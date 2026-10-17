import { SubmissionStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  submissionFindMany: vi.fn(),
  submissionUpdateMany: vi.fn(),
  executionUpdateMany: vi.fn(),
  publishSubmission: vi.fn(),
  publishSubmissionDeadLetter: vi.fn(),
  publishSubmissionEvent: vi.fn(),
}));

vi.doMock('../../database/prisma.js', () => ({
  prisma: {
    submission: {
      findMany: mocks.submissionFindMany,
      updateMany: mocks.submissionUpdateMany,
    },
    execution: { updateMany: mocks.executionUpdateMany },
  },
}));

vi.doMock('../../queue/submissions.js', () => ({
  publishSubmission: mocks.publishSubmission,
  publishSubmissionDeadLetter: mocks.publishSubmissionDeadLetter,
  publishSubmissionEvent: mocks.publishSubmissionEvent,
}));

const { recoverSubmissions } = await import('./recovery.js');

const submissionId = 'c3070e38-c557-43d5-a59b-e8af46675370';
const userId = 'a25145ab-21aa-4d20-9e08-3a2b4d59110f';
const leaseToken = '48a6a0a4-828e-4ea0-a9ec-60509f663ca5';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.submissionFindMany.mockResolvedValue([]);
  mocks.submissionUpdateMany.mockResolvedValue({ count: 1 });
  mocks.executionUpdateMany.mockResolvedValue({ count: 1 });
  mocks.publishSubmission.mockResolvedValue(undefined);
  mocks.publishSubmissionDeadLetter.mockResolvedValue(undefined);
  mocks.publishSubmissionEvent.mockResolvedValue(undefined);
});

describe('stale submission recovery', () => {
  it('releases an expired lease, closes the old execution attempt, and republishes the job', async () => {
    const now = new Date('2026-10-17T10:00:00.000Z');
    mocks.submissionFindMany
      .mockResolvedValueOnce([
        {
          id: submissionId,
          userId,
          status: SubmissionStatus.RUNNING,
          attemptCount: 2,
          leaseToken,
        },
      ])
      .mockResolvedValueOnce([{ id: submissionId, priority: 0 }]);

    await recoverSubmissions(now);

    expect(mocks.submissionUpdateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: submissionId,
        status: SubmissionStatus.RUNNING,
        leaseToken,
        leaseExpiresAt: { lte: now },
      },
      data: {
        status: SubmissionStatus.QUEUED,
        workerId: null,
        leaseToken: null,
        leaseExpiresAt: null,
        needsDispatch: true,
        lastEnqueuedAt: new Date('2026-10-17T09:59:50.000Z'),
      },
    });
    expect(mocks.executionUpdateMany).toHaveBeenCalledWith({
      where: { submissionId, attemptNumber: 2, completedAt: null },
      data: { completedAt: now },
    });
    expect(mocks.publishSubmissionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'submission:queued',
        submissionId,
        userId,
        status: SubmissionStatus.QUEUED,
      }),
    );
    expect(mocks.publishSubmission).toHaveBeenCalledWith(submissionId, 0);
    expect(mocks.submissionUpdateMany).toHaveBeenNthCalledWith(2, {
      where: { id: submissionId, status: SubmissionStatus.QUEUED, needsDispatch: true },
      data: { needsDispatch: false, lastEnqueuedAt: now },
    });
  });

  it('marks a repeatedly stale submission failed after its attempt budget is exhausted', async () => {
    const now = new Date('2026-10-17T10:00:00.000Z');
    mocks.submissionFindMany.mockResolvedValueOnce([
      {
        id: submissionId,
        userId,
        status: SubmissionStatus.COMPILING,
        attemptCount: 4,
        leaseToken,
      },
    ]);

    await recoverSubmissions(now);

    expect(mocks.submissionUpdateMany).toHaveBeenCalledWith({
      where: {
        id: submissionId,
        status: SubmissionStatus.COMPILING,
        leaseToken,
        leaseExpiresAt: { lte: now },
      },
      data: {
        status: SubmissionStatus.SYSTEM_ERROR,
        errorMessage: 'The worker stopped responding after several attempts.',
        workerId: null,
        leaseToken: null,
        leaseExpiresAt: null,
        needsDispatch: false,
      },
    });
    expect(mocks.publishSubmissionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'submission:failed',
        submissionId,
        userId,
        status: SubmissionStatus.SYSTEM_ERROR,
      }),
    );
    expect(mocks.publishSubmission).not.toHaveBeenCalled();
    expect(mocks.publishSubmissionDeadLetter).toHaveBeenCalledWith(
      submissionId,
      'stale-attempt-limit',
    );
  });
});
