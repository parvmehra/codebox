import { Role, SubmissionStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../database/prisma.js';
import {
  optionalAuth,
  requireAuth,
  requireRole,
  type AuthenticatedRequest,
} from '../../middleware/auth.js';
import { HttpError } from '../../utils/http-error.js';
import { scoreContestLeaderboard } from './scoring.js';

const createContestInput = z
  .object({
    slug: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .max(120),
    title: z.string().min(3).max(160),
    description: z.string().min(1).max(4_000),
    startAt: z
      .string()
      .datetime({ offset: true })
      .transform((value) => new Date(value)),
    endAt: z
      .string()
      .datetime({ offset: true })
      .transform((value) => new Date(value)),
    isPublished: z.boolean().default(false),
    problems: z
      .array(
        z.object({ problemId: z.string().uuid(), points: z.number().int().min(1).max(10_000) }),
      )
      .min(1)
      .max(50),
  })
  .superRefine((input, context) => {
    if (input.endAt <= input.startAt) {
      context.addIssue({
        code: 'custom',
        message: 'The contest end must be after its start.',
        path: ['endAt'],
      });
    }
    if (new Set(input.problems.map(({ problemId }) => problemId)).size !== input.problems.length) {
      context.addIssue({
        code: 'custom',
        message: 'Each problem can only be added once.',
        path: ['problems'],
      });
    }
  });

const joinContestInput = z
  .object({ displayName: z.string().trim().min(2).max(24).optional() })
  .default({});

function contestStatus(startAt: Date, endAt: Date): 'UPCOMING' | 'LIVE' | 'COMPLETED' {
  const now = Date.now();
  if (now < startAt.getTime()) return 'UPCOMING';
  if (now >= endAt.getTime()) return 'COMPLETED';
  return 'LIVE';
}

export const contestsRouter = Router();

contestsRouter.get('/', async (_request, response) => {
  const contests = await prisma.contest.findMany({
    where: { isPublished: true },
    orderBy: [{ startAt: 'asc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      slug: true,
      title: true,
      description: true,
      startAt: true,
      endAt: true,
      _count: { select: { participants: true, problems: true } },
    },
  });

  return response.json({
    data: contests.map(({ _count, ...contest }) => ({
      ...contest,
      status: contestStatus(contest.startAt, contest.endAt),
      participantCount: _count.participants,
      problemCount: _count.problems,
    })),
  });
});

contestsRouter.post('/', requireAuth, requireRole(Role.ADMIN), async (request, response) => {
  const input = createContestInput.parse(request.body);
  const existingSlug = await prisma.contest.findUnique({
    where: { slug: input.slug },
    select: { id: true },
  });
  if (existingSlug)
    throw new HttpError(409, 'CONTEST_SLUG_IN_USE', 'A contest already uses this slug.');

  const problemIds = input.problems.map(({ problemId }) => problemId);
  const publishedProblems = await prisma.problem.findMany({
    where: { id: { in: problemIds }, isPublished: true },
    select: { id: true },
  });
  if (publishedProblems.length !== problemIds.length) {
    throw new HttpError(
      400,
      'INVALID_CONTEST_PROBLEMS',
      'Every contest problem must be published.',
    );
  }

  const contest = await prisma.contest.create({
    data: {
      slug: input.slug,
      title: input.title,
      description: input.description,
      startAt: input.startAt,
      endAt: input.endAt,
      isPublished: input.isPublished,
      problems: {
        create: input.problems.map(({ problemId, points }, position) => ({
          problemId,
          points,
          position,
        })),
      },
    },
    select: { id: true, slug: true, title: true, startAt: true, endAt: true, isPublished: true },
  });

  return response.status(201).json({ data: contest });
});

contestsRouter.get('/:id', optionalAuth, async (request: AuthenticatedRequest, response) => {
  const identifier = z.string().parse(request.params.id);
  const contest = await prisma.contest.findFirst({
    where: { isPublished: true, OR: [{ id: identifier }, { slug: identifier }] },
    select: {
      id: true,
      slug: true,
      title: true,
      description: true,
      startAt: true,
      endAt: true,
      problems: {
        where: { problem: { isPublished: true } },
        orderBy: { position: 'asc' },
        select: {
          points: true,
          problem: { select: { id: true, slug: true, title: true, difficulty: true } },
        },
      },
      _count: { select: { participants: true } },
    },
  });
  if (!contest) throw new HttpError(404, 'CONTEST_NOT_FOUND', 'Contest not found.');

  const participant = request.user
    ? await prisma.contestParticipant.findUnique({
        where: { contestId_userId: { contestId: contest.id, userId: request.user.id } },
        select: { displayName: true },
      })
    : null;

  return response.json({
    data: {
      ...contest,
      status: contestStatus(contest.startAt, contest.endAt),
      participantCount: contest._count.participants,
      isParticipant: Boolean(participant),
      displayName: participant?.displayName ?? null,
    },
  });
});

contestsRouter.post('/:id/join', requireAuth, async (request: AuthenticatedRequest, response) => {
  const identifier = z.string().parse(request.params.id);
  const contest = await prisma.contest.findFirst({
    where: { isPublished: true, OR: [{ id: identifier }, { slug: identifier }] },
    select: { id: true, endAt: true },
  });
  if (!contest) throw new HttpError(404, 'CONTEST_NOT_FOUND', 'Contest not found.');
  if (contest.endAt.getTime() <= Date.now()) {
    throw new HttpError(409, 'CONTEST_CLOSED', 'This contest has already ended.');
  }

  const userId = request.user!.id;
  const participantKey = { contestId: contest.id, userId };
  const existingParticipant = await prisma.contestParticipant.findUnique({
    where: { contestId_userId: participantKey },
  });
  if (existingParticipant) return response.json({ data: existingParticipant });

  const { displayName } = joinContestInput.parse(request.body ?? {});
  const name = displayName ?? `Coder-${randomUUID().slice(0, 8)}`;
  const existingName = await prisma.contestParticipant.findUnique({
    where: { contestId_displayName: { contestId: contest.id, displayName: name } },
    select: { userId: true },
  });
  if (existingName) {
    throw new HttpError(
      409,
      'CONTEST_NAME_IN_USE',
      'That display name is already in this contest.',
    );
  }

  const participant = await prisma.contestParticipant.create({
    data: { ...participantKey, displayName: name },
  });
  return response.status(201).json({ data: participant });
});

contestsRouter.get(
  '/:id/leaderboard',
  optionalAuth,
  async (request: AuthenticatedRequest, response) => {
    const identifier = z.string().parse(request.params.id);
    const contest = await prisma.contest.findFirst({
      where: { isPublished: true, OR: [{ id: identifier }, { slug: identifier }] },
      select: {
        id: true,
        startAt: true,
        endAt: true,
        problems: { select: { problemId: true, points: true } },
        participants: {
          orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }],
          select: { userId: true, displayName: true, joinedAt: true },
        },
      },
    });
    if (!contest) throw new HttpError(404, 'CONTEST_NOT_FOUND', 'Contest not found.');

    const acceptedSubmissions = await prisma.submission.findMany({
      where: {
        contestId: contest.id,
        status: SubmissionStatus.ACCEPTED,
        createdAt: { gte: contest.startAt, lt: contest.endAt },
      },
      select: { userId: true, problemId: true, updatedAt: true },
    });
    const data = scoreContestLeaderboard(
      contest.participants,
      contest.problems,
      acceptedSubmissions.map(({ userId, problemId, updatedAt }) => ({
        userId,
        problemId,
        acceptedAt: updatedAt,
      })),
    );
    const myDisplayName = contest.participants.find(
      ({ userId }) => userId === request.user?.id,
    )?.displayName;

    return response.json({
      data,
      myRank: myDisplayName
        ? (data.find(({ displayName }) => displayName === myDisplayName)?.rank ?? null)
        : null,
      totalProblems: contest.problems.length,
    });
  },
);
