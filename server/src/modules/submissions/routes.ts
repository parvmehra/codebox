import { Role, SubmissionLanguage, SubmissionStatus } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../database/prisma.js';
import { requireAuth, type AuthenticatedRequest } from '../../middleware/auth.js';
import { submissionRateLimiter } from '../../middleware/rate-limit.js';
import { logger } from '../../observability/logger.js';
import {
  submissionEnqueueFailuresTotal,
  submissionEnqueuesTotal,
} from '../../observability/metrics.js';
import {
  publishSubmission,
  publishSubmissionCancellation,
  publishSubmissionEvent,
} from '../../queue/submissions.js';
import { assertSubmissionTransition, isTerminalSubmissionStatus } from './state-machine.js';
import { HttpError } from '../../utils/http-error.js';

const createSubmissionInput = z.object({
  problemId: z.string().uuid(),
  contestId: z.string().uuid().optional(),
  language: z.nativeEnum(SubmissionLanguage),
  priority: z.number().int().min(0).max(10).default(0),
  sourceCode: z
    .string()
    .min(1)
    .max(100_000)
    .refine((sourceCode) => Buffer.byteLength(sourceCode, 'utf8') <= 100_000, {
      message: 'Source code must not exceed 100,000 UTF-8 bytes.',
    }),
});

const historyQuery = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const cancellableStatuses = [
  SubmissionStatus.QUEUED,
  SubmissionStatus.ASSIGNED,
  SubmissionStatus.STARTING,
  SubmissionStatus.COMPILING,
  SubmissionStatus.RUNNING,
] as const;

export const submissionsRouter = Router();
const log = logger.child({ component: 'submissions-api' });

submissionsRouter.post(
  '/',
  submissionRateLimiter,
  requireAuth,
  async (request: AuthenticatedRequest, response) => {
    const input = createSubmissionInput.parse(request.body);
    if (input.priority > 0 && request.user!.role !== Role.ADMIN) {
      throw new HttpError(403, 'INSUFFICIENT_ROLE', 'Only admins can set submission priority.');
    }
    const problem = await prisma.problem.findFirst({
      where: { id: input.problemId, isPublished: true },
      select: { id: true },
    });

    if (!problem) throw new HttpError(404, 'PROBLEM_NOT_FOUND', 'Published problem not found.');

    if (input.contestId) {
      const contest = await prisma.contest.findFirst({
        where: { id: input.contestId, isPublished: true },
        select: { id: true, startAt: true, endAt: true },
      });
      if (!contest) throw new HttpError(404, 'CONTEST_NOT_FOUND', 'Contest not found.');
      const now = Date.now();
      if (now < contest.startAt.getTime() || now >= contest.endAt.getTime()) {
        throw new HttpError(
          409,
          'CONTEST_NOT_ACTIVE',
          'Contest submissions are only accepted while it is live.',
        );
      }

      const participant = await prisma.contestParticipant.findUnique({
        where: { contestId_userId: { contestId: contest.id, userId: request.user!.id } },
        select: { userId: true },
      });
      if (!participant) {
        throw new HttpError(403, 'CONTEST_NOT_JOINED', 'Join the contest before submitting to it.');
      }

      const contestProblem = await prisma.contestProblem.findUnique({
        where: { contestId_problemId: { contestId: contest.id, problemId: problem.id } },
        select: { problemId: true },
      });
      if (!contestProblem) {
        throw new HttpError(
          400,
          'PROBLEM_NOT_IN_CONTEST',
          'This problem is not part of the contest.',
        );
      }
    }

    const submission = await prisma.submission.create({
      data: {
        userId: request.user!.id,
        problemId: problem.id,
        ...(input.contestId ? { contestId: input.contestId } : {}),
        language: input.language,
        sourceCode: input.sourceCode,
        priority: input.priority,
      },
      select: { id: true, status: true, language: true, priority: true, createdAt: true },
    });

    try {
      await publishSubmissionEvent({
        type: 'submission:queued',
        submissionId: submission.id,
        userId: request.user!.id,
        status: SubmissionStatus.QUEUED,
        updatedAt: submission.createdAt.toISOString(),
      });
    } catch (error) {
      log.warn({ error, submissionId: submission.id }, 'Could not publish queued status event');
    }

    try {
      await publishSubmission(submission.id, submission.priority);
      submissionEnqueuesTotal.inc({ language: submission.language });
    } catch (error) {
      submissionEnqueueFailuresTotal.inc({ language: submission.language });
      log.error({ error, submissionId: submission.id }, 'Could not publish submission job');
      assertSubmissionTransition(SubmissionStatus.QUEUED, SubmissionStatus.SYSTEM_ERROR);
      await prisma.submission.updateMany({
        where: { id: submission.id, status: SubmissionStatus.QUEUED },
        data: {
          status: SubmissionStatus.SYSTEM_ERROR,
          errorMessage: 'The submission could not be queued.',
        },
      });
      try {
        await publishSubmissionEvent({
          type: 'submission:failed',
          submissionId: submission.id,
          userId: request.user!.id,
          status: SubmissionStatus.SYSTEM_ERROR,
          updatedAt: new Date().toISOString(),
          errorMessage: 'The submission could not be queued.',
        });
      } catch (eventError) {
        log.warn(
          { error: eventError, submissionId: submission.id },
          'Could not publish failure event',
        );
      }

      return response.status(503).json({
        error: {
          code: 'QUEUE_UNAVAILABLE',
          message:
            'The submission was saved but could not be queued. Check its status before retrying.',
        },
        submissionId: submission.id,
      });
    }

    return response.status(202).json({ data: submission });
  },
);

submissionsRouter.get('/', requireAuth, async (request: AuthenticatedRequest, response) => {
  const { cursor, limit } = historyQuery.parse(request.query);
  const records = await prisma.submission.findMany({
    where: { userId: request.user!.id },
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    take: limit + 1,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      language: true,
      status: true,
      executionTimeMs: true,
      memoryUsedKb: true,
      createdAt: true,
      updatedAt: true,
      problem: { select: { id: true, slug: true, title: true } },
    },
  });

  const hasMore = records.length > limit;
  if (hasMore) records.pop();

  return response.json({
    data: records,
    nextCursor: hasMore ? (records.at(-1)?.id ?? null) : null,
  });
});

submissionsRouter.post(
  '/:id/cancel',
  requireAuth,
  async (request: AuthenticatedRequest, response) => {
    const id = z.string().uuid().parse(request.params.id);
    const current = await prisma.submission.findFirst({
      where: { id, userId: request.user!.id },
      select: { id: true, status: true },
    });
    if (!current) throw new HttpError(404, 'SUBMISSION_NOT_FOUND', 'Submission not found.');
    if (current.status === SubmissionStatus.CANCELLED) {
      return response.json({ data: { id, status: current.status } });
    }
    if (isTerminalSubmissionStatus(current.status)) {
      throw new HttpError(
        409,
        'SUBMISSION_ALREADY_FINISHED',
        'This submission has already finished.',
      );
    }

    assertSubmissionTransition(current.status, SubmissionStatus.CANCELLED);
    const cancelled = await prisma.submission.updateMany({
      where: { id, userId: request.user!.id, status: { in: [...cancellableStatuses] } },
      data: {
        status: SubmissionStatus.CANCELLED,
        errorMessage: null,
        workerId: null,
        leaseToken: null,
        leaseExpiresAt: null,
        needsDispatch: false,
      },
    });
    if (cancelled.count !== 1) {
      const latest = await prisma.submission.findFirst({
        where: { id, userId: request.user!.id },
        select: { status: true },
      });
      if (latest?.status === SubmissionStatus.CANCELLED) {
        return response.json({ data: { id, status: latest.status } });
      }
      throw new HttpError(
        409,
        'SUBMISSION_ALREADY_FINISHED',
        'This submission has already finished.',
      );
    }

    const updatedAt = new Date().toISOString();
    await publishSubmissionEvent({
      type: 'submission:cancelled',
      submissionId: id,
      userId: request.user!.id,
      status: SubmissionStatus.CANCELLED,
      updatedAt,
    }).catch((error: unknown) => {
      log.warn({ error, submissionId: id }, 'Could not publish cancellation event');
    });
    await publishSubmissionCancellation(id).catch((error: unknown) => {
      log.warn({ error, submissionId: id }, 'Could not signal submission cancellation');
    });

    return response.json({ data: { id, status: SubmissionStatus.CANCELLED } });
  },
);

submissionsRouter.post(
  '/:id/rerun',
  submissionRateLimiter,
  requireAuth,
  async (request: AuthenticatedRequest, response) => {
    const id = z.string().uuid().parse(request.params.id);
    const original = await prisma.submission.findFirst({
      where: { id, userId: request.user!.id },
      select: {
        id: true,
        problemId: true,
        language: true,
        sourceCode: true,
        priority: true,
        status: true,
        executions: {
          orderBy: { attemptNumber: 'desc' },
          take: 1,
          select: { id: true, completedAt: true },
        },
      },
    });
    if (!original) throw new HttpError(404, 'SUBMISSION_NOT_FOUND', 'Submission not found.');

    const sourceExecution = original.executions[0];
    if (!isTerminalSubmissionStatus(original.status) || !sourceExecution?.completedAt) {
      throw new HttpError(
        409,
        'SUBMISSION_NOT_RERUNNABLE',
        'Only a completed submission with a recorded execution can be re-run.',
      );
    }

    const rerun = await prisma.submission.create({
      data: {
        userId: request.user!.id,
        problemId: original.problemId,
        language: original.language,
        sourceCode: original.sourceCode,
        priority: original.priority,
        rerunOfExecutionId: sourceExecution.id,
      },
      select: {
        id: true,
        status: true,
        language: true,
        priority: true,
        rerunOfExecutionId: true,
        createdAt: true,
      },
    });

    try {
      await publishSubmissionEvent({
        type: 'submission:queued',
        submissionId: rerun.id,
        userId: request.user!.id,
        status: SubmissionStatus.QUEUED,
        updatedAt: rerun.createdAt.toISOString(),
      });
    } catch (error) {
      log.warn({ error, submissionId: rerun.id }, 'Could not publish re-run queued event');
    }

    try {
      await publishSubmission(rerun.id, rerun.priority);
      submissionEnqueuesTotal.inc({ language: rerun.language });
    } catch (error) {
      submissionEnqueueFailuresTotal.inc({ language: rerun.language });
      log.error({ error, submissionId: rerun.id }, 'Could not publish re-run job');
      assertSubmissionTransition(SubmissionStatus.QUEUED, SubmissionStatus.SYSTEM_ERROR);
      await prisma.submission.updateMany({
        where: { id: rerun.id, status: SubmissionStatus.QUEUED },
        data: {
          status: SubmissionStatus.SYSTEM_ERROR,
          errorMessage: 'The submission could not be queued.',
        },
      });
      await publishSubmissionEvent({
        type: 'submission:failed',
        submissionId: rerun.id,
        userId: request.user!.id,
        status: SubmissionStatus.SYSTEM_ERROR,
        updatedAt: new Date().toISOString(),
        errorMessage: 'The submission could not be queued.',
      }).catch((eventError: unknown) => {
        log.warn(
          { error: eventError, submissionId: rerun.id },
          'Could not publish re-run failure event',
        );
      });
      return response.status(503).json({
        error: {
          code: 'QUEUE_UNAVAILABLE',
          message: 'The re-run was saved but could not be queued.',
        },
        submissionId: rerun.id,
      });
    }

    return response.status(202).json({ data: rerun });
  },
);

submissionsRouter.get('/:id', requireAuth, async (request: AuthenticatedRequest, response) => {
  const id = z.string().uuid().parse(request.params.id);
  const submission = await prisma.submission.findFirst({
    where: { id, userId: request.user!.id },
    select: {
      id: true,
      language: true,
      sourceCode: true,
      status: true,
      executionTimeMs: true,
      memoryUsedKb: true,
      rerunOfExecutionId: true,
      errorMessage: true,
      createdAt: true,
      updatedAt: true,
      problem: { select: { id: true, slug: true, title: true } },
      executions: {
        orderBy: { attemptNumber: 'desc' },
        select: {
          id: true,
          attemptNumber: true,
          languageVersion: true,
          dockerImage: true,
          dockerImageDigest: true,
          dockerImageId: true,
          sourceCodeSha256: true,
          profileSnapshot: true,
          timeLimitMs: true,
          memoryLimitMb: true,
          startedAt: true,
          completedAt: true,
          executionTimeMs: true,
          memoryUsedKb: true,
          testCases: {
            orderBy: { testIndex: 'asc' },
            select: { testIndex: true, testCaseVersion: true },
          },
          testResults: {
            orderBy: { testIndex: 'asc' },
            select: { testIndex: true, status: true, executionTimeMs: true, errorMessage: true },
          },
        },
      },
    },
  });

  if (!submission) throw new HttpError(404, 'SUBMISSION_NOT_FOUND', 'Submission not found.');
  const { executions, ...details } = submission;
  return response.json({ data: { ...details, testResults: executions[0]?.testResults ?? [] } });
});
