import { Role } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../database/prisma.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { HttpError } from '../../utils/http-error.js';

const createProblem = z.object({ slug: z.string().regex(/^[a-z0-9-]+$/).max(120), title: z.string().min(3).max(200), description: z.string().min(1), difficulty: z.enum(['EASY', 'MEDIUM', 'HARD']), constraints: z.string().min(1), inputFormat: z.string().min(1), outputFormat: z.string().min(1), examples: z.array(z.object({ input: z.string(), output: z.string(), explanation: z.string().optional() })).max(10), isPublished: z.boolean().default(false) });
export const problemsRouter = Router();
problemsRouter.get('/', async (request, response) => {
  const difficulty = z.enum(['EASY', 'MEDIUM', 'HARD']).optional().parse(request.query.difficulty);
  const problems = await prisma.problem.findMany({ where: { isPublished: true, ...(difficulty ? { difficulty } : {}) }, select: { id: true, slug: true, title: true, difficulty: true, createdAt: true }, orderBy: { createdAt: 'desc' } });
  return response.json({ data: problems });
});
problemsRouter.get('/:id', async (request, response) => {
  const problem = await prisma.problem.findFirst({ where: { id: request.params.id, isPublished: true }, select: { id: true, slug: true, title: true, description: true, difficulty: true, constraints: true, inputFormat: true, outputFormat: true, examples: true, createdAt: true, updatedAt: true } });
  if (!problem) throw new HttpError(404, 'NOT_FOUND', 'Problem not found.');
  return response.json({ data: problem });
});
problemsRouter.post('/', requireAuth, requireRole(Role.ADMIN), async (request, response) => {
  const input = createProblem.parse(request.body);
  const problem = await prisma.problem.create({ data: input });
  return response.status(201).json({ data: problem });
});
