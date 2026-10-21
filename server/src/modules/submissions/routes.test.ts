import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SubmissionStatus } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.doMock('../../database/prisma.js', () => ({
  prisma: {
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
    problem: { findFirst: vi.fn(), findUnique: vi.fn() },
    contest: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    contestParticipant: { findUnique: vi.fn(), create: vi.fn() },
    contestProblem: { findUnique: vi.fn() },
    testCase: {
      findMany: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
      findFirst: vi.fn(),
    },
    testCaseVersion: { create: vi.fn() },
    submission: {
      create: vi.fn(),
      updateMany: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}));

vi.doMock('../../queue/submissions.js', () => ({
  publishSubmission: vi.fn(),
  publishSubmissionEvent: vi.fn(),
  publishSubmissionCancellation: vi.fn(),
}));

process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET ??= 'test-secret-for-submission-api-tests-only-32';
process.env.LOG_LEVEL ??= 'silent';

const { env } = await import('../../config/env.js');
const { prisma } = await import('../../database/prisma.js');
const { publishSubmission, publishSubmissionEvent, publishSubmissionCancellation } =
  await import('../../queue/submissions.js');
const { app } = await import('../../app.js');

const userId = 'a25145ab-21aa-4d20-9e08-3a2b4d59110f';
const problemId = '7ad05396-f608-44ea-8a31-5e4be967fab6';
const contestId = '8ec1dc8b-cbb6-4956-9e5d-2b1b3e003bc9';
const submissionId = 'c3070e38-c557-43d5-a59b-e8af46675370';
const executionId = '48a6a0a4-828e-4ea0-a9ec-60509f663ca5';
const rerunSubmissionId = '63806c75-00b8-4fa8-9e88-f81cd67c2a3b';
const testCaseId = 'a7bdb143-0d95-42c8-91f8-58b531d00fed';
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

describe('submission API', () => {
  it('exposes liveness, dependency readiness, and Prometheus metrics', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);

    const liveness = await fetch(`${baseUrl}/health/live`);
    expect(liveness.status).toBe(200);
    expect(await liveness.json()).toEqual({ status: 'live' });

    const readiness = await fetch(`${baseUrl}/health/ready`);
    expect(readiness.status).toBe(503);
    expect(await readiness.json()).toEqual({
      status: 'not_ready',
      checks: { database: true, scheduler: false },
    });

    const metrics = await fetch(`${baseUrl}/metrics`);
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get('content-type')).toContain('text/plain');
    expect(await metrics.text()).toContain('# HELP codebox_http_requests_total');
  });

  it('saves and queues a submission for a published problem', async () => {
    vi.mocked(prisma.problem.findFirst).mockResolvedValue({ id: problemId } as never);
    vi.mocked(prisma.submission.create).mockResolvedValue({
      id: submissionId,
      status: SubmissionStatus.QUEUED,
      language: 'JAVA',
      priority: 0,
      createdAt: new Date('2026-10-13T00:00:00.000Z'),
    } as never);

    const response = await fetch(`${baseUrl}/api/submissions`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ problemId, language: 'JAVA', sourceCode: 'class Main {}' }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      data: { id: submissionId, status: SubmissionStatus.QUEUED, language: 'JAVA' },
    });
    expect(publishSubmission).toHaveBeenCalledWith(submissionId, 0);
    expect(publishSubmissionEvent).toHaveBeenCalledWith({
      type: 'submission:queued',
      submissionId,
      userId,
      status: SubmissionStatus.QUEUED,
      updatedAt: '2026-10-13T00:00:00.000Z',
    });
  });

  it('stores contest submissions only for joined users while the contest is live', async () => {
    vi.mocked(prisma.problem.findFirst).mockResolvedValue({ id: problemId } as never);
    vi.mocked(prisma.contest.findFirst).mockResolvedValue({
      id: contestId,
      startAt: new Date(Date.now() - 60_000),
      endAt: new Date(Date.now() + 60_000),
    } as never);
    vi.mocked(prisma.contestParticipant.findUnique).mockResolvedValue({ userId } as never);
    vi.mocked(prisma.contestProblem.findUnique).mockResolvedValue({ problemId } as never);
    vi.mocked(prisma.submission.create).mockResolvedValue({
      id: submissionId,
      status: SubmissionStatus.QUEUED,
      language: 'JAVA',
      priority: 0,
      createdAt: new Date('2026-10-13T00:00:00.000Z'),
    } as never);

    const response = await fetch(`${baseUrl}/api/submissions`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ problemId, contestId, language: 'JAVA', sourceCode: 'class Main {}' }),
    });

    expect(response.status).toBe(202);
    expect(prisma.contestParticipant.findUnique).toHaveBeenCalledWith({
      where: { contestId_userId: { contestId, userId } },
      select: { userId: true },
    });
    expect(prisma.submission.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ contestId }) }),
    );
  });

  it('rejects contest submissions before the contest starts', async () => {
    vi.mocked(prisma.problem.findFirst).mockResolvedValue({ id: problemId } as never);
    vi.mocked(prisma.contest.findFirst).mockResolvedValue({
      id: contestId,
      startAt: new Date(Date.now() + 60_000),
      endAt: new Date(Date.now() + 120_000),
    } as never);

    const response = await fetch(`${baseUrl}/api/submissions`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ problemId, contestId, language: 'JAVA', sourceCode: 'class Main {}' }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'CONTEST_NOT_ACTIVE' } });
    expect(prisma.submission.create).not.toHaveBeenCalled();
  });

  it('marks the saved submission failed when the broker cannot confirm it', async () => {
    vi.mocked(prisma.problem.findFirst).mockResolvedValue({ id: problemId } as never);
    vi.mocked(prisma.submission.create).mockResolvedValue({
      id: submissionId,
      status: SubmissionStatus.QUEUED,
      language: 'JAVA',
      priority: 0,
      createdAt: new Date('2026-10-13T00:00:00.000Z'),
    } as never);
    vi.mocked(publishSubmission).mockRejectedValue(new Error('broker unavailable'));
    vi.mocked(prisma.submission.updateMany).mockResolvedValue({ count: 1 });

    const response = await fetch(`${baseUrl}/api/submissions`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ problemId, language: 'JAVA', sourceCode: 'class Main {}' }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'QUEUE_UNAVAILABLE' },
      submissionId,
    });
    expect(prisma.submission.updateMany).toHaveBeenCalledWith({
      where: { id: submissionId, status: SubmissionStatus.QUEUED },
      data: {
        status: SubmissionStatus.SYSTEM_ERROR,
        errorMessage: 'The submission could not be queued.',
      },
    });
    expect(publishSubmissionEvent).toHaveBeenCalledTimes(2);
    expect(publishSubmissionEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'submission:failed',
        status: SubmissionStatus.SYSTEM_ERROR,
      }),
    );
  });

  it('requires a valid JWT before looking up a problem', async () => {
    const response = await fetch(`${baseUrl}/api/submissions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ problemId, language: 'JAVA', sourceCode: 'class Main {}' }),
    });

    expect(response.status).toBe(401);
    expect(prisma.problem.findFirst).not.toHaveBeenCalled();
  });

  it('accepts each supported execution language', async () => {
    vi.mocked(prisma.problem.findFirst).mockResolvedValue({ id: problemId } as never);
    vi.mocked(prisma.submission.create).mockImplementation((async ({
      data,
    }: Parameters<typeof prisma.submission.create>[0]) => ({
      id: submissionId,
      status: SubmissionStatus.QUEUED,
      language: data.language,
      priority: data.priority,
      createdAt: new Date('2026-10-13T00:00:00.000Z'),
    })) as never);
    vi.mocked(publishSubmission).mockResolvedValue(undefined);

    for (const language of ['JAVA', 'PYTHON', 'CPP', 'NODEJS'] as const) {
      const response = await fetch(`${baseUrl}/api/submissions`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ problemId, language, sourceCode: 'print(1)' }),
      });

      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ data: { language } });
    }
    expect(publishSubmission).toHaveBeenCalledTimes(4);
    expect(publishSubmissionEvent).toHaveBeenCalledTimes(4);
  });

  it('allows admins to assign a bounded priority to a submission', async () => {
    vi.mocked(prisma.problem.findFirst).mockResolvedValue({ id: problemId } as never);
    vi.mocked(prisma.submission.create).mockResolvedValue({
      id: submissionId,
      status: SubmissionStatus.QUEUED,
      language: 'JAVA',
      priority: 7,
      createdAt: new Date('2026-10-13T00:00:00.000Z'),
    } as never);

    const response = await fetch(`${baseUrl}/api/submissions`, {
      method: 'POST',
      headers: authHeaders('ADMIN'),
      body: JSON.stringify({
        problemId,
        language: 'JAVA',
        priority: 7,
        sourceCode: 'class Main {}',
      }),
    });

    expect(response.status).toBe(202);
    expect(publishSubmission).toHaveBeenCalledWith(submissionId, 7);
  });

  it('does not let regular users raise submission priority', async () => {
    const response = await fetch(`${baseUrl}/api/submissions`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        problemId,
        language: 'JAVA',
        priority: 1,
        sourceCode: 'class Main {}',
      }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'INSUFFICIENT_ROLE' } });
    expect(prisma.problem.findFirst).not.toHaveBeenCalled();
  });

  it('rejects language values outside the supported enum', async () => {
    const response = await fetch(`${baseUrl}/api/submissions`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ problemId, language: 'RUST', sourceCode: 'fn main() {}' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(prisma.problem.findFirst).not.toHaveBeenCalled();
  });

  it('returns per-test verdicts without exposing test inputs or expected outputs', async () => {
    vi.mocked(prisma.submission.findFirst).mockResolvedValue({
      id: submissionId,
      language: 'JAVA',
      sourceCode: 'public class Main {}',
      status: SubmissionStatus.ACCEPTED,
      executionTimeMs: 12,
      memoryUsedKb: null,
      errorMessage: null,
      createdAt: new Date('2026-10-13T00:00:00.000Z'),
      updatedAt: new Date('2026-10-13T00:00:01.000Z'),
      problem: { id: problemId, slug: 'sample', title: 'Sample' },
      executions: [
        {
          testResults: [
            {
              testIndex: 1,
              status: 'PASSED',
              executionTimeMs: 12,
              errorMessage: null,
            },
          ],
        },
      ],
    } as never);

    const response = await fetch(`${baseUrl}/api/submissions/${submissionId}`, {
      headers: authHeaders(),
    });
    const body = (await response.json()) as { data: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(body.data.testResults).toEqual([
      { testIndex: 1, status: 'PASSED', executionTimeMs: 12, errorMessage: null },
    ]);
    expect(body.data).not.toHaveProperty('input');
    expect(body.data).not.toHaveProperty('expectedOut');
  });

  it('creates a separate re-run submission linked to the exact completed execution', async () => {
    const completedAt = new Date('2026-10-20T10:00:00.000Z');
    vi.mocked(prisma.submission.findFirst).mockResolvedValue({
      id: submissionId,
      problemId,
      language: 'JAVA',
      sourceCode: 'public class Main {}',
      priority: 0,
      status: SubmissionStatus.ACCEPTED,
      executions: [{ id: executionId, completedAt }],
    } as never);
    vi.mocked(prisma.submission.create).mockResolvedValue({
      id: rerunSubmissionId,
      status: SubmissionStatus.QUEUED,
      language: 'JAVA',
      priority: 0,
      rerunOfExecutionId: executionId,
      createdAt: new Date('2026-10-20T10:01:00.000Z'),
    } as never);
    vi.mocked(publishSubmission).mockResolvedValue(undefined);

    const response = await fetch(`${baseUrl}/api/submissions/${submissionId}/rerun`, {
      method: 'POST',
      headers: authHeaders(),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      data: {
        id: rerunSubmissionId,
        status: SubmissionStatus.QUEUED,
        rerunOfExecutionId: executionId,
      },
    });
    expect(prisma.submission.create).toHaveBeenCalledWith({
      data: {
        userId,
        problemId,
        language: 'JAVA',
        sourceCode: 'public class Main {}',
        priority: 0,
        rerunOfExecutionId: executionId,
      },
      select: expect.objectContaining({ id: true, rerunOfExecutionId: true }),
    });
    expect(publishSubmission).toHaveBeenCalledWith(rerunSubmissionId, 0);
  });

  it('rejects re-running a submission without a completed execution', async () => {
    vi.mocked(prisma.submission.findFirst).mockResolvedValue({
      id: submissionId,
      status: SubmissionStatus.RUNNING,
      executions: [{ id: executionId, completedAt: null }],
    } as never);

    const response = await fetch(`${baseUrl}/api/submissions/${submissionId}/rerun`, {
      method: 'POST',
      headers: authHeaders(),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'SUBMISSION_NOT_RERUNNABLE' },
    });
    expect(prisma.submission.create).not.toHaveBeenCalled();
  });

  it('creates a test case together with its immutable first version', async () => {
    vi.mocked(prisma.problem.findUnique).mockResolvedValue({ id: problemId } as never);
    vi.mocked(prisma.testCase.create).mockResolvedValue({
      id: testCaseId,
      problemId,
      version: 1,
      createdAt: new Date('2026-10-20T10:00:00.000Z'),
    } as never);

    const response = await fetch(`${baseUrl}/api/problems/${problemId}/test-cases`, {
      method: 'POST',
      headers: authHeaders('ADMIN'),
      body: JSON.stringify({ input: '1 2', expectedOut: '3', isHidden: true }),
    });

    expect(response.status).toBe(201);
    expect(prisma.testCase.create).toHaveBeenCalledWith({
      data: {
        problemId,
        input: '1 2',
        expectedOut: '3',
        isHidden: true,
        version: 1,
        versions: {
          create: { version: 1, input: '1 2', expectedOut: '3', isHidden: true },
        },
      },
      select: { id: true, problemId: true, version: true, createdAt: true },
    });
  });

  it('adds a new immutable test case version with optimistic concurrency', async () => {
    const transaction = {
      testCase: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findFirst: vi.fn(),
      },
      testCaseVersion: { create: vi.fn().mockResolvedValue({}) },
    };
    vi.mocked(prisma.$transaction).mockImplementation(((operation: unknown) =>
      typeof operation === 'function' ? operation(transaction) : Promise.resolve([])) as never);

    const response = await fetch(`${baseUrl}/api/problems/${problemId}/test-cases/${testCaseId}`, {
      method: 'PATCH',
      headers: authHeaders('ADMIN'),
      body: JSON.stringify({
        expectedVersion: 1,
        input: '1 4',
        expectedOut: '5',
        isHidden: false,
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { id: testCaseId, problemId, version: 2 },
    });
    expect(transaction.testCase.updateMany).toHaveBeenCalledWith({
      where: { id: testCaseId, problemId, version: 1 },
      data: { input: '1 4', expectedOut: '5', isHidden: false, version: 2 },
    });
    expect(transaction.testCaseVersion.create).toHaveBeenCalledWith({
      data: { testCaseId, version: 2, input: '1 4', expectedOut: '5', isHidden: false },
    });
  });

  it('rejects stale test case edits instead of replacing a newer version', async () => {
    const transaction = {
      testCase: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findFirst: vi.fn().mockResolvedValue({ version: 3 }),
      },
      testCaseVersion: { create: vi.fn() },
    };
    vi.mocked(prisma.$transaction).mockImplementation(((operation: unknown) =>
      typeof operation === 'function' ? operation(transaction) : Promise.resolve([])) as never);

    const response = await fetch(`${baseUrl}/api/problems/${problemId}/test-cases/${testCaseId}`, {
      method: 'PATCH',
      headers: authHeaders('ADMIN'),
      body: JSON.stringify({
        expectedVersion: 1,
        input: 'stale',
        expectedOut: 'old',
        isHidden: true,
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'TEST_CASE_VERSION_CONFLICT' },
    });
    expect(transaction.testCaseVersion.create).not.toHaveBeenCalled();
  });

  it('cancels an owned queued submission and signals active workers', async () => {
    vi.mocked(prisma.submission.findFirst).mockResolvedValue({
      id: submissionId,
      status: SubmissionStatus.QUEUED,
      updatedAt: new Date('2026-10-16T10:00:00.000Z'),
    } as never);
    vi.mocked(prisma.submission.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked(publishSubmissionEvent).mockResolvedValue(undefined);
    vi.mocked(publishSubmissionCancellation).mockResolvedValue(undefined);

    const response = await fetch(`${baseUrl}/api/submissions/${submissionId}/cancel`, {
      method: 'POST',
      headers: authHeaders(),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { id: submissionId, status: SubmissionStatus.CANCELLED },
    });
    expect(prisma.submission.updateMany).toHaveBeenCalledWith({
      where: {
        id: submissionId,
        userId,
        status: { in: ['QUEUED', 'ASSIGNED', 'STARTING', 'COMPILING', 'RUNNING'] },
      },
      data: {
        status: SubmissionStatus.CANCELLED,
        errorMessage: null,
        workerId: null,
        leaseToken: null,
        leaseExpiresAt: null,
        needsDispatch: false,
      },
    });
    expect(publishSubmissionCancellation).toHaveBeenCalledWith(submissionId);
    expect(publishSubmissionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'submission:cancelled',
        submissionId,
        userId,
        status: SubmissionStatus.CANCELLED,
      }),
    );
  });
});
