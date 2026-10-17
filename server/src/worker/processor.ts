import { randomUUID } from 'node:crypto';
import { SubmissionStatus } from '@prisma/client';
import { prisma } from '../database/prisma.js';
import { SUBMISSION_LEASE_MS, MAX_EXECUTION_ATTEMPTS } from '../queue/reliability.js';
import {
  assertSubmissionTransition,
  isTerminalSubmissionStatus,
} from '../modules/submissions/state-machine.js';
import type { Prisma } from '@prisma/client';
import type { SubmissionRealtimeEvent, SubmissionStateEvent } from '../realtime/events.js';
import {
  executeSubmission,
  type ExecutionResult,
  SourceSizeLimitError,
} from './docker-executor.js';
import { getLanguageProfile, UnsupportedLanguageError } from './language-profile.js';

class SubmissionStateChangedError extends Error {
  constructor(
    readonly current: SubmissionStatus,
    readonly next: SubmissionStatus,
  ) {
    super(`Submission state changed before ${current} → ${next} could be saved.`);
    this.name = 'SubmissionStateChangedError';
  }
}

export class RetryableSubmissionError extends Error {
  constructor(
    readonly submissionId: string,
    cause: unknown,
  ) {
    super('A temporary worker failure requires retry.', { cause });
    this.name = 'RetryableSubmissionError';
  }
}

export type SubmissionProcessingResult = {
  processed: boolean;
  status?: SubmissionStatus;
  attemptLimitReached?: boolean;
};

type RealtimePublisher = (event: SubmissionRealtimeEvent) => void;
type ProcessOptions = { workerId: string; leaseToken?: string; signal?: AbortSignal };

export async function processSubmission(
  submissionId: string,
  publishEvent: RealtimePublisher = () => undefined,
  { workerId, leaseToken: providedLeaseToken, signal }: ProcessOptions = {
    workerId: 'unit-test-worker',
  },
): Promise<SubmissionProcessingResult> {
  const leaseToken = providedLeaseToken ?? randomUUID();
  const claim = await prisma.submission.updateMany({
    where: {
      id: submissionId,
      status: SubmissionStatus.QUEUED,
      attemptCount: { lt: MAX_EXECUTION_ATTEMPTS },
    },
    data: {
      status: SubmissionStatus.ASSIGNED,
      attemptCount: { increment: 1 },
      workerId,
      leaseToken,
      leaseExpiresAt: leaseExpiry(),
      needsDispatch: false,
    },
  });

  if (claim.count !== 1) {
    const existing = await prisma.submission.findUnique({
      where: { id: submissionId },
      select: { status: true, attemptCount: true, userId: true },
    });
    if (
      existing?.status === SubmissionStatus.QUEUED &&
      existing.attemptCount >= MAX_EXECUTION_ATTEMPTS
    ) {
      const failed = await prisma.submission.updateMany({
        where: {
          id: submissionId,
          status: SubmissionStatus.QUEUED,
          attemptCount: { gte: MAX_EXECUTION_ATTEMPTS },
        },
        data: {
          status: SubmissionStatus.SYSTEM_ERROR,
          errorMessage: 'The worker could not complete this submission after several attempts.',
          workerId: null,
          leaseToken: null,
          leaseExpiresAt: null,
          needsDispatch: false,
        },
      });
      if (failed.count === 1) {
        emitStateEvent(publishEvent, {
          type: 'submission:failed',
          submissionId,
          userId: existing.userId,
          status: SubmissionStatus.SYSTEM_ERROR,
          errorMessage: 'The worker could not complete this submission after several attempts.',
        });
        return {
          processed: false,
          status: SubmissionStatus.SYSTEM_ERROR,
          attemptLimitReached: true,
        };
      }
    }

    return { processed: false, status: existing?.status };
  }

  let currentStatus: SubmissionStatus = SubmissionStatus.ASSIGNED;
  let executionId: string | undefined;
  let attemptNumber = 1;
  let userId: string | undefined;

  try {
    const submission = await prisma.submission.findUnique({
      where: { id: submissionId },
      select: {
        userId: true,
        language: true,
        sourceCode: true,
        attemptCount: true,
        problem: {
          select: {
            testCases: {
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              select: { id: true, input: true, expectedOut: true },
            },
          },
        },
      },
    });

    if (!submission) throw new Error('Submission disappeared after it was assigned.');
    userId = submission.userId;
    attemptNumber = submission.attemptCount;
    emitStateEvent(publishEvent, {
      type: 'submission:assigned',
      submissionId,
      userId,
      status: currentStatus,
    });

    await transitionSubmission(submissionId, currentStatus, SubmissionStatus.STARTING, leaseToken);
    currentStatus = SubmissionStatus.STARTING;
    emitStateEvent(publishEvent, {
      type: 'submission:starting',
      submissionId,
      userId,
      status: currentStatus,
    });

    const profile = getLanguageProfile(submission.language);
    if (submission.problem.testCases.length === 0) {
      throw new Error('The selected problem has no test cases.');
    }

    const execution = await prisma.execution.create({
      data: {
        submissionId,
        attemptNumber,
        languageVersion: profile.languageVersion,
        dockerImage: profile.dockerImage,
        timeLimitMs: profile.timeLimitMs,
        memoryLimitMb: profile.memoryLimitMb,
      },
      select: { id: true },
    });
    executionId = execution.id;

    const result = await executeSubmission(profile, {
      sourceCode: submission.sourceCode,
      testCases: submission.problem.testCases,
      signal,
      onPhase: async (nextStatus) => {
        await transitionSubmission(submissionId, currentStatus, nextStatus, leaseToken);
        currentStatus = nextStatus;
        emitStateEvent(publishEvent, {
          type:
            nextStatus === SubmissionStatus.COMPILING
              ? 'submission:compiling'
              : 'submission:running',
          submissionId,
          userId: submission.userId,
          status: currentStatus,
        });
      },
      onTestResult: async (testResult) => {
        await renewLease(submissionId, currentStatus, leaseToken);
        await prisma.executionTestResult.create({
          data: { executionId: execution.id, ...testResult },
        });
        publishSafely(publishEvent, {
          type: 'submission:test-progress',
          submissionId,
          userId: submission.userId,
          status: currentStatus,
          updatedAt: new Date().toISOString(),
          testIndex: testResult.testIndex,
          resultStatus: testResult.status,
          executionTimeMs: testResult.executionTimeMs,
          errorMessage: testResult.errorMessage,
        });
      },
    });

    if (signal?.aborted)
      return await handleAbort(submissionId, currentStatus, leaseToken, signal, executionId);

    await persistExecutionSummary(execution.id, result);
    await transitionSubmission(submissionId, currentStatus, result.status, leaseToken, {
      executionTimeMs: result.executionTimeMs,
      memoryUsedKb: result.memoryUsedKb,
      errorMessage: result.errorMessage,
    });
    emitStateEvent(publishEvent, {
      type:
        result.status === SubmissionStatus.ACCEPTED ? 'submission:completed' : 'submission:failed',
      submissionId,
      userId: submission.userId,
      status: result.status,
      errorMessage: result.errorMessage ?? undefined,
    });

    return { processed: true, status: result.status };
  } catch (error) {
    if (signal?.aborted)
      return await handleAbort(submissionId, currentStatus, leaseToken, signal, executionId);

    if (error instanceof SubmissionStateChangedError) {
      const existing = await prisma.submission.findUnique({
        where: { id: submissionId },
        select: { status: true },
      });
      return { processed: false, status: existing?.status ?? error.current };
    }

    if (error instanceof UnsupportedLanguageError || error instanceof SourceSizeLimitError) {
      const errorMessage = error.message;
      await transitionSubmission(
        submissionId,
        currentStatus,
        SubmissionStatus.SYSTEM_ERROR,
        leaseToken,
        {
          errorMessage,
        },
      );
      if (executionId) {
        await prisma.execution.update({
          where: { id: executionId },
          data: { completedAt: new Date() },
        });
      }
      if (userId) {
        emitStateEvent(publishEvent, {
          type: 'submission:failed',
          submissionId,
          userId,
          status: SubmissionStatus.SYSTEM_ERROR,
          errorMessage,
        });
      }
      return { processed: true, status: SubmissionStatus.SYSTEM_ERROR };
    }

    assertSubmissionTransition(currentStatus, SubmissionStatus.QUEUED);
    const released = await prisma.submission.updateMany({
      where: { id: submissionId, status: currentStatus, leaseToken },
      data: {
        status: SubmissionStatus.QUEUED,
        workerId: null,
        leaseToken: null,
        leaseExpiresAt: null,
        errorMessage: null,
      },
    });

    if (released.count !== 1) {
      const existing = await prisma.submission.findUnique({
        where: { id: submissionId },
        select: { status: true },
      });
      return { processed: false, status: existing?.status ?? currentStatus };
    }

    if (executionId) {
      await prisma.execution.update({
        where: { id: executionId },
        data: { completedAt: new Date() },
      });
    }
    if (userId) {
      emitStateEvent(publishEvent, {
        type: 'submission:queued',
        submissionId,
        userId,
        status: SubmissionStatus.QUEUED,
      });
    }
    throw new RetryableSubmissionError(submissionId, error);
  }
}

async function handleAbort(
  submissionId: string,
  currentStatus: SubmissionStatus,
  leaseToken: string,
  signal: AbortSignal,
  executionId?: string,
): Promise<SubmissionProcessingResult> {
  const reason = signal.reason as { kind?: string } | undefined;
  if (reason?.kind === 'user-cancel') {
    if (executionId) {
      await prisma.execution.updateMany({
        where: { id: executionId, completedAt: null },
        data: { completedAt: new Date() },
      });
    }
    return { processed: false, status: SubmissionStatus.CANCELLED };
  }

  assertSubmissionTransition(currentStatus, SubmissionStatus.QUEUED);
  const released = await prisma.submission.updateMany({
    where: { id: submissionId, status: currentStatus, leaseToken },
    data: {
      status: SubmissionStatus.QUEUED,
      workerId: null,
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
  if (released.count === 1) {
    if (executionId) {
      await prisma.execution.updateMany({
        where: { id: executionId, completedAt: null },
        data: { completedAt: new Date() },
      });
    }
    throw new RetryableSubmissionError(submissionId, signal.reason);
  }

  const existing = await prisma.submission.findUnique({
    where: { id: submissionId },
    select: { status: true },
  });
  return { processed: false, status: existing?.status ?? currentStatus };
}

export async function failQueuedSubmission(
  submissionId: string,
  publishEvent: RealtimePublisher = () => undefined,
): Promise<boolean> {
  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    select: { userId: true },
  });
  if (!submission) return false;

  const errorMessage = 'The worker could not complete this submission after several attempts.';
  const failed = await prisma.submission.updateMany({
    where: {
      id: submissionId,
      status: SubmissionStatus.QUEUED,
    },
    data: {
      status: SubmissionStatus.SYSTEM_ERROR,
      errorMessage,
      needsDispatch: false,
      workerId: null,
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
  if (failed.count !== 1) return false;

  emitStateEvent(publishEvent, {
    type: 'submission:failed',
    submissionId,
    userId: submission.userId,
    status: SubmissionStatus.SYSTEM_ERROR,
    errorMessage,
  });
  return true;
}

function emitStateEvent(
  publishEvent: RealtimePublisher,
  event: Omit<SubmissionStateEvent, 'updatedAt'> & { updatedAt?: string },
): void {
  const payload = { ...event, updatedAt: event.updatedAt ?? new Date().toISOString() };
  publishSafely(publishEvent, payload);
}

function publishSafely(publishEvent: RealtimePublisher, event: SubmissionRealtimeEvent): void {
  try {
    publishEvent(event);
  } catch (error) {
    console.warn({ error, submissionId: event.submissionId }, 'Could not publish submission event');
  }
}

async function transitionSubmission(
  submissionId: string,
  current: SubmissionStatus,
  next: SubmissionStatus,
  leaseToken: string,
  data: Prisma.SubmissionUpdateManyMutationInput = {},
): Promise<void> {
  assertSubmissionTransition(current, next);
  const terminal = isTerminalSubmissionStatus(next);
  const changed = await prisma.submission.updateMany({
    where: { id: submissionId, status: current, leaseToken },
    data: {
      ...data,
      status: next,
      workerId: terminal ? null : undefined,
      leaseToken: terminal ? null : leaseToken,
      leaseExpiresAt: terminal ? null : leaseExpiry(),
    },
  });
  if (changed.count !== 1) throw new SubmissionStateChangedError(current, next);
}

async function renewLease(
  submissionId: string,
  status: SubmissionStatus,
  leaseToken: string,
): Promise<void> {
  const changed = await prisma.submission.updateMany({
    where: { id: submissionId, status, leaseToken },
    data: { leaseExpiresAt: leaseExpiry() },
  });
  if (changed.count !== 1) throw new SubmissionStateChangedError(status, status);
}

function leaseExpiry(): Date {
  return new Date(Date.now() + SUBMISSION_LEASE_MS);
}

async function persistExecutionSummary(
  executionId: string,
  result: ExecutionResult,
): Promise<void> {
  await prisma.execution.update({
    where: { id: executionId },
    data: {
      completedAt: new Date(),
      executionTimeMs: result.executionTimeMs,
      memoryUsedKb: result.memoryUsedKb,
    },
  });
}
