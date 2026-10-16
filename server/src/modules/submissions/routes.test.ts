import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SubmissionStatus } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.doMock('../../database/prisma.js', () => ({
  prisma: {
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
}));

process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET ??= 'test-secret-for-submission-api-tests-only-32';

const { env } = await import('../../config/env.js');
const { prisma } = await import('../../database/prisma.js');
const { publishSubmission, publishSubmissionEvent } = await import('../../queue/submissions.js');
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

function authHeaders(): HeadersInit {
  const token = jwt.sign({ id: userId, role: 'USER' }, env.JWT_SECRET);
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

describe('submission API', () => {
  it('saves and queues a submission for a published problem', async () => {
    vi.mocked(prisma.problem.findFirst).mockResolvedValue({ id: problemId } as never);
    vi.mocked(prisma.submission.create).mockResolvedValue({
      id: submissionId,
      status: SubmissionStatus.QUEUED,
      language: 'JAVA',
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
    expect(publishSubmission).toHaveBeenCalledWith(submissionId);
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
});
