import { SubmissionStatus } from '@prisma/client';
import { prisma } from '../database/prisma.js';
import { assertSubmissionTransition } from '../modules/submissions/state-machine.js';
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

export type SubmissionProcessingResult = {
  processed: boolean;
  status?: SubmissionStatus;
};

type RealtimePublisher = (event: SubmissionRealtimeEvent) => void;

export async function processSubmission(
  submissionId: string,
  publishEvent: RealtimePublisher = () => undefined,
): Promise<SubmissionProcessingResult> {
  const claim = await prisma.submission.updateMany({
    where: { id: submissionId, status: SubmissionStatus.QUEUED },
    data: { status: SubmissionStatus.ASSIGNED },
  });

  if (claim.count !== 1) {
    const existing = await prisma.submission.findUnique({
      where: { id: submissionId },
      select: { status: true },
    });
    return { processed: false, status: existing?.status };
  }

  let currentStatus: SubmissionStatus = SubmissionStatus.ASSIGNED;
  let executionId: string | undefined;
  let userId: string | undefined;

  try {
    const submission = await prisma.submission.findUnique({
      where: { id: submissionId },
      select: {
        userId: true,
        language: true,
        sourceCode: true,
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
    emitStateEvent(publishEvent, {
      type: 'submission:assigned',
      submissionId,
      userId,
      status: currentStatus,
    });

    await transitionSubmission(submissionId, currentStatus, SubmissionStatus.STARTING);
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
        attemptNumber: 1,
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
      onPhase: async (nextStatus) => {
        await transitionSubmission(submissionId, currentStatus, nextStatus);
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

    await persistExecutionSummary(execution.id, result);
    await transitionSubmission(submissionId, currentStatus, result.status, {
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
    if (error instanceof SubmissionStateChangedError) {
      console.info(
        { submissionId, currentStatus, nextStatus: error.next },
        'Submission state changed during processing',
      );
      return { processed: false, status: error.current };
    }

    console.error({ submissionId, error }, 'Submission execution failed');
    const errorMessage =
      error instanceof UnsupportedLanguageError || error instanceof SourceSizeLimitError
        ? error.message
        : 'The worker could not complete this submission.';

    try {
      await transitionSubmission(submissionId, currentStatus, SubmissionStatus.SYSTEM_ERROR, {
        errorMessage,
      });
    } catch (transitionError) {
      if (transitionError instanceof SubmissionStateChangedError) {
        return { processed: false, status: transitionError.current };
      }
      throw transitionError;
    }

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
  data: Prisma.SubmissionUpdateManyMutationInput = {},
): Promise<void> {
  assertSubmissionTransition(current, next);
  const changed = await prisma.submission.updateMany({
    where: { id: submissionId, status: current },
    data: { ...data, status: next },
  });
  if (changed.count !== 1) throw new SubmissionStateChangedError(current, next);
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
