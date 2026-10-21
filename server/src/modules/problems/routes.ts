import { Role } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../database/prisma.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { HttpError } from '../../utils/http-error.js';
import { createProblemInput, testCaseInput, updateTestCaseInput } from './validation.js';

export const problemsRouter = Router();

problemsRouter.get('/', async (request, response) => {
  const difficulty = z.enum(['EASY', 'MEDIUM', 'HARD']).optional().parse(request.query.difficulty);
  const problems = await prisma.problem.findMany({
    where: { isPublished: true, ...(difficulty ? { difficulty } : {}) },
    select: { id: true, slug: true, title: true, difficulty: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  return response.json({ data: problems });
});

problemsRouter.get('/:id', async (request, response) => {
  const problem = await prisma.problem.findFirst({
    where: { id: request.params.id, isPublished: true },
    select: {
      id: true,
      slug: true,
      title: true,
      description: true,
      difficulty: true,
      constraints: true,
      inputFormat: true,
      outputFormat: true,
      examples: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!problem) throw new HttpError(404, 'NOT_FOUND', 'Problem not found.');
  return response.json({ data: problem });
});

problemsRouter.post('/', requireAuth, requireRole(Role.ADMIN), async (request, response) => {
  const input = createProblemInput.parse(request.body);
  const problem = await prisma.problem.create({ data: input });
  return response.status(201).json({ data: problem });
});

problemsRouter.get(
  '/:problemId/test-cases',
  requireAuth,
  requireRole(Role.ADMIN),
  async (request, response) => {
    const problemId = z.string().uuid().parse(request.params.problemId);
    const testCases = await prisma.testCase.findMany({
      where: { problemId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        version: true,
        input: true,
        expectedOut: true,
        isHidden: true,
        versions: {
          orderBy: { version: 'desc' },
          select: {
            version: true,
            input: true,
            expectedOut: true,
            isHidden: true,
            createdAt: true,
          },
        },
      },
    });
    return response.json({ data: testCases });
  },
);

problemsRouter.post(
  '/:problemId/test-cases',
  requireAuth,
  requireRole(Role.ADMIN),
  async (request, response) => {
    const problemId = z.string().uuid().parse(request.params.problemId);
    const input = testCaseInput.parse(request.body);
    const problem = await prisma.problem.findUnique({
      where: { id: problemId },
      select: { id: true },
    });
    if (!problem) throw new HttpError(404, 'NOT_FOUND', 'Problem not found.');

    const testCase = await prisma.testCase.create({
      data: {
        problemId,
        ...input,
        version: 1,
        versions: { create: { version: 1, ...input } },
      },
      select: { id: true, problemId: true, version: true, createdAt: true },
    });
    return response.status(201).json({ data: testCase });
  },
);

problemsRouter.patch(
  '/:problemId/test-cases/:testCaseId',
  requireAuth,
  requireRole(Role.ADMIN),
  async (request, response) => {
    const problemId = z.string().uuid().parse(request.params.problemId);
    const testCaseId = z.string().uuid().parse(request.params.testCaseId);
    const { expectedVersion, ...input } = updateTestCaseInput.parse(request.body);
    const nextVersion = expectedVersion + 1;

    const result = await prisma.$transaction(async (transaction) => {
      const changed = await transaction.testCase.updateMany({
        where: { id: testCaseId, problemId, version: expectedVersion },
        data: { ...input, version: nextVersion },
      });
      if (changed.count !== 1) {
        const current = await transaction.testCase.findFirst({
          where: { id: testCaseId, problemId },
          select: { version: true },
        });
        return current
          ? { kind: 'conflict' as const, version: current.version }
          : { kind: 'missing' as const };
      }

      await transaction.testCaseVersion.create({
        data: { testCaseId, version: nextVersion, ...input },
      });
      return { kind: 'updated' as const, version: nextVersion };
    });

    if (result.kind === 'missing') {
      throw new HttpError(404, 'TEST_CASE_NOT_FOUND', 'Test case not found.');
    }
    if (result.kind === 'conflict') {
      throw new HttpError(
        409,
        'TEST_CASE_VERSION_CONFLICT',
        `The test case is now at version ${result.version}. Reload before updating it.`,
      );
    }

    return response.json({
      data: { id: testCaseId, problemId, version: result.version },
    });
  },
);
