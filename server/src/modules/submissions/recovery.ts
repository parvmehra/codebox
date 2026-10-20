import { SubmissionStatus } from '@prisma/client';
import { prisma } from '../../database/prisma.js';
import { logger } from '../../observability/logger.js';
import {
  publishSubmission,
  publishSubmissionDeadLetter,
  publishSubmissionEvent,
} from '../../queue/submissions.js';
import { assertSubmissionTransition } from './state-machine.js';
import {
  MAX_EXECUTION_ATTEMPTS,
  RECOVERY_BATCH_SIZE,
  SUBMISSION_RECOVERY_INTERVAL_MS,
} from '../../queue/reliability.js';

const activeStatuses = [
  SubmissionStatus.ASSIGNED,
  SubmissionStatus.STARTING,
  SubmissionStatus.COMPILING,
  SubmissionStatus.RUNNING,
] as const;
const dispatchRetryAgeMs = 10_000;

type ExpiredSubmission = {
  id: string;
  userId: string;
  status: (typeof activeStatuses)[number];
  attemptCount: number;
  leaseToken: string | null;
};

let timer: NodeJS.Timeout | undefined;
let recoveryPromise: Promise<void> | undefined;
const log = logger.child({ component: 'submission-recovery' });

export async function startSubmissionRecovery(): Promise<() => Promise<void>> {
  await recoverSubmissions();
  timer = setInterval(() => void recoverSubmissions(), SUBMISSION_RECOVERY_INTERVAL_MS);
  timer.unref();
  return async () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    await recoveryPromise;
  };
}

export async function recoverSubmissions(now = new Date()): Promise<void> {
  if (recoveryPromise) return recoveryPromise;
  recoveryPromise = runRecovery(now).finally(() => {
    recoveryPromise = undefined;
  });
  return recoveryPromise;
}

async function runRecovery(now: Date): Promise<void> {
  try {
    const expired = (await prisma.submission.findMany({
      where: { status: { in: [...activeStatuses] }, leaseExpiresAt: { lte: now } },
      orderBy: { leaseExpiresAt: 'asc' },
      take: RECOVERY_BATCH_SIZE,
      select: { id: true, userId: true, status: true, attemptCount: true, leaseToken: true },
    })) as ExpiredSubmission[];

    for (const submission of expired) {
      await recoverExpiredSubmission(submission, now);
    }

    const dispatchable = await prisma.submission.findMany({
      where: {
        status: SubmissionStatus.QUEUED,
        needsDispatch: true,
        lastEnqueuedAt: { lte: new Date(now.getTime() - dispatchRetryAgeMs) },
      },
      orderBy: { lastEnqueuedAt: 'asc' },
      take: RECOVERY_BATCH_SIZE,
      select: { id: true, priority: true },
    });

    for (const submission of dispatchable) {
      try {
        await publishSubmission(submission.id, submission.priority);
        await prisma.submission.updateMany({
          where: { id: submission.id, status: SubmissionStatus.QUEUED, needsDispatch: true },
          data: { needsDispatch: false, lastEnqueuedAt: now },
        });
      } catch (error) {
        log.error({ error, submissionId: submission.id }, 'Could not requeue recovered submission');
      }
    }
  } catch (error) {
    log.error({ error }, 'Submission recovery pass failed');
  }
}

async function recoverExpiredSubmission(submission: ExpiredSubmission, now: Date): Promise<void> {
  if (submission.attemptCount >= MAX_EXECUTION_ATTEMPTS) {
    const failed = await prisma.submission.updateMany({
      where: {
        id: submission.id,
        status: submission.status,
        leaseToken: submission.leaseToken,
        leaseExpiresAt: { lte: now },
      },
      data: {
        status: SubmissionStatus.SYSTEM_ERROR,
        errorMessage: 'The worker stopped responding after several attempts.',
        workerId: null,
        leaseToken: null,
        leaseExpiresAt: null,
        needsDispatch: false,
      },
    });
    if (failed.count !== 1) return;

    await prisma.execution.updateMany({
      where: {
        submissionId: submission.id,
        attemptNumber: submission.attemptCount,
        completedAt: null,
      },
      data: { completedAt: now },
    });
    await publishFailure(submission, now);
    await publishSubmissionDeadLetter(submission.id, 'stale-attempt-limit').catch(
      (error: unknown) => {
        log.warn(
          { error, submissionId: submission.id },
          'Could not dead-letter exhausted stale submission',
        );
      },
    );
    return;
  }

  assertSubmissionTransition(submission.status, SubmissionStatus.QUEUED);
  const recovered = await prisma.submission.updateMany({
    where: {
      id: submission.id,
      status: submission.status,
      leaseToken: submission.leaseToken,
      leaseExpiresAt: { lte: now },
    },
    data: {
      status: SubmissionStatus.QUEUED,
      workerId: null,
      leaseToken: null,
      leaseExpiresAt: null,
      needsDispatch: true,
      lastEnqueuedAt: new Date(now.getTime() - dispatchRetryAgeMs),
    },
  });
  if (recovered.count !== 1) return;

  await prisma.execution.updateMany({
    where: {
      submissionId: submission.id,
      attemptNumber: submission.attemptCount,
      completedAt: null,
    },
    data: { completedAt: now },
  });
  await publishSubmissionEvent({
    type: 'submission:queued',
    submissionId: submission.id,
    userId: submission.userId,
    status: SubmissionStatus.QUEUED,
    updatedAt: now.toISOString(),
  }).catch((error: unknown) => {
    log.warn({ error, submissionId: submission.id }, 'Could not publish recovery event');
  });
}

async function publishFailure(submission: ExpiredSubmission, now: Date): Promise<void> {
  await publishSubmissionEvent({
    type: 'submission:failed',
    submissionId: submission.id,
    userId: submission.userId,
    status: SubmissionStatus.SYSTEM_ERROR,
    updatedAt: now.toISOString(),
    errorMessage: 'The worker stopped responding after several attempts.',
  }).catch((error: unknown) => {
    log.warn({ error, submissionId: submission.id }, 'Could not publish recovery failure event');
  });
}
