import { SubmissionLanguage, SubmissionStatus } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../database/prisma.js';
import { requireAuth, type AuthenticatedRequest } from '../../middleware/auth.js';
import {
  publishSubmission,
  publishSubmissionCancellation,
  publishSubmissionEvent,
} from '../../queue/submissions.js';
import { assertSubmissionTransition, isTerminalSubmissionStatus } from './state-machine.js';
import { HttpError } from '../../utils/http-error.js';

const createSubmissionInput = z.object({
  problemId: z.string().uuid(),
  language: z.nativeEnum(SubmissionLanguage),
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

submissionsRouter.post('/', requireAuth, async (request: AuthenticatedRequest, response) => {
  const input = createSubmissionInput.parse(request.body);
  const problem = await prisma.problem.findFirst({
    where: { id: input.problemId, isPublished: true },
    select: { id: true },
  });

  if (!problem) throw new HttpError(404, 'PROBLEM_NOT_FOUND', 'Published problem not found.');

  const submission = await prisma.submission.create({
    data: {
      userId: request.user!.id,
      problemId: problem.id,
      language: input.language,
      sourceCode: input.sourceCode,
    },
    select: { id: true, status: true, language: true, createdAt: true },
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
    console.warn({ error, submissionId: submission.id }, 'Could not publish queued status event');
  }

  try {
    await publishSubmission(submission.id);
  } catch (error) {
    console.error({ error, submissionId: submission.id }, 'Could not publish submission job');
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
      console.warn(
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
});

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
      console.warn({ error, submissionId: id }, 'Could not publish cancellation event');
    });
    await publishSubmissionCancellation(id).catch((error: unknown) => {
      console.warn({ error, submissionId: id }, 'Could not signal submission cancellation');
    });

    return response.json({ data: { id, status: SubmissionStatus.CANCELLED } });
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
      errorMessage: true,
      createdAt: true,
      updatedAt: true,
      problem: { select: { id: true, slug: true, title: true } },
      executions: {
        orderBy: { attemptNumber: 'desc' },
        take: 1,
        select: {
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
