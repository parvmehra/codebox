import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.doMock('../../database/prisma.js', () => ({
  prisma: {
    contest: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    contestParticipant: { findUnique: vi.fn(), create: vi.fn() },
    contestProblem: { findUnique: vi.fn() },
    problem: { findMany: vi.fn() },
    submission: { findMany: vi.fn() },
  },
}));

process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET ??= 'test-secret-for-contest-api-tests-only-32';
process.env.LOG_LEVEL ??= 'silent';

const { env } = await import('../../config/env.js');
const { prisma } = await import('../../database/prisma.js');
const { app } = await import('../../app.js');

const userId = 'a25145ab-21aa-4d20-9e08-3a2b4d59110f';
const contestId = '8ec1dc8b-cbb6-4956-9e5d-2b1b3e003bc9';
const problemId = '7ad05396-f608-44ea-8a31-5e4be967fab6';
let server: Server;
let baseUrl: string;

beforeEach(async () => {
  vi.clearAllMocks();
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

function authHeaders(role = 'USER'): HeadersInit {
  const token = jwt.sign({ id: userId, role }, env.JWT_SECRET);
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

describe('contest API', () => {
  it('requires an admin to create a contest with published problems', async () => {
    const body = {
      slug: 'autumn-algorithms',
      title: 'Autumn Algorithms',
      description: 'A short set of problems.',
      startAt: '2026-11-01T10:00:00.000Z',
      endAt: '2026-11-01T12:00:00.000Z',
      isPublished: true,
      problems: [{ problemId, points: 100 }],
    };

    const denied = await fetch(`${baseUrl}/api/contests`, {
      method: 'POST',
      headers: authHeaders('USER'),
      body: JSON.stringify(body),
    });
    expect(denied.status).toBe(403);

    vi.mocked(prisma.contest.findUnique).mockResolvedValue(null as never);
    vi.mocked(prisma.problem.findMany).mockResolvedValue([{ id: problemId }] as never);
    vi.mocked(prisma.contest.create).mockResolvedValue({
      id: contestId,
      slug: body.slug,
      title: body.title,
      startAt: new Date(body.startAt),
      endAt: new Date(body.endAt),
      isPublished: true,
    } as never);

    const created = await fetch(`${baseUrl}/api/contests`, {
      method: 'POST',
      headers: authHeaders('ADMIN'),
      body: JSON.stringify(body),
    });

    expect(created.status).toBe(201);
    expect(prisma.contest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          problems: { create: [{ problemId, points: 100, position: 0 }] },
        }),
      }),
    );
  });

  it('lets an authenticated participant join with a public name', async () => {
    vi.mocked(prisma.contest.findFirst).mockResolvedValue({
      id: contestId,
      endAt: new Date(Date.now() + 60_000),
    } as never);
    vi.mocked(prisma.contestParticipant.findUnique)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce(null as never);
    vi.mocked(prisma.contestParticipant.create).mockResolvedValue({
      contestId,
      userId,
      displayName: 'Aster',
      joinedAt: new Date('2026-10-21T00:00:00.000Z'),
    } as never);

    const response = await fetch(`${baseUrl}/api/contests/${contestId}/join`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ displayName: 'Aster' }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ data: { displayName: 'Aster' } });
    expect(prisma.contestParticipant.create).toHaveBeenCalledWith({
      data: { contestId, userId, displayName: 'Aster' },
    });
  });

  it('returns a public leaderboard without exposing account IDs or emails', async () => {
    vi.mocked(prisma.contest.findFirst).mockResolvedValue({
      id: contestId,
      startAt: new Date('2026-10-20T10:00:00.000Z'),
      endAt: new Date('2026-10-22T10:00:00.000Z'),
      problems: [{ problemId, points: 100 }],
      participants: [{ userId, displayName: 'Aster', joinedAt: new Date('2026-10-20T09:00:00Z') }],
    } as never);
    vi.mocked(prisma.submission.findMany).mockResolvedValue([
      {
        userId,
        problemId,
        updatedAt: new Date('2026-10-21T10:00:00.000Z'),
      },
    ] as never);

    const response = await fetch(`${baseUrl}/api/contests/${contestId}/leaderboard`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('Aster');
    expect(body).toContain('100');
    expect(body).not.toContain(userId);
    expect(body).not.toContain('@');
  });
});
