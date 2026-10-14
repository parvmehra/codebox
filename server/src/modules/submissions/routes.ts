import { SubmissionLanguage, SubmissionStatus } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../database/prisma.js';
import { requireAuth, type AuthenticatedRequest } from '../../middleware/auth.js';
import { publishSubmission } from '../../queue/submissions.js';
import { assertSubmissionTransition } from './state-machine.js';
import { HttpError } from '../../utils/http-error.js';

const createSubmissionInput = z.object({
  problemId: z.string().uuid(),
  language: z.literal(SubmissionLanguage.JAVA),
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
