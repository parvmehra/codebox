import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SubmissionStatus } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.doMock('../../database/prisma.js', () => ({
  prisma: {
    $queryRaw: vi.fn(),
    problem: { findFirst: vi.fn() },
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
const submissionId = 'c3070e38-c557-43d5-a59b-e8af46675370';
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
