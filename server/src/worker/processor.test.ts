import { SubmissionLanguage, SubmissionStatus, TestResultStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  submissionUpdateMany: vi.fn(),
  submissionFindUnique: vi.fn(),
  executionCreate: vi.fn(),
  executionUpdate: vi.fn(),
  testResultCreate: vi.fn(),
  executeSubmission: vi.fn(),
  publishEvent: vi.fn(),
}));

vi.doMock('../database/prisma.js', () => ({
  prisma: {
    submission: {
      updateMany: mocks.submissionUpdateMany,
      findUnique: mocks.submissionFindUnique,
    },
    execution: {
      create: mocks.executionCreate,
      update: mocks.executionUpdate,
    },
    executionTestResult: { create: mocks.testResultCreate },
  },
}));

vi.doMock('./docker-executor.js', () => ({
  executeSubmission: mocks.executeSubmission,
  SourceSizeLimitError: class SourceSizeLimitError extends Error {},
}));

const { processSubmission, RetryableSubmissionError } = await import('./processor.js');

const submissionId = 'c3070e38-c557-43d5-a59b-e8af46675370';
const executionId = '48a6a0a4-828e-4ea0-a9ec-60509f663ca5';
const testCaseId = 'a7bdb143-0d95-42c8-91f8-58b531d00fed';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.submissionUpdateMany.mockResolvedValue({ count: 1 });
  mocks.submissionFindUnique.mockResolvedValue({
    status: SubmissionStatus.ASSIGNED,
    userId: 'a25145ab-21aa-4d20-9e08-3a2b4d59110f',
    language: SubmissionLanguage.JAVA,
    sourceCode: 'public class Main {}',
    attemptCount: 1,
    problem: { testCases: [{ id: testCaseId, input: '1', expectedOut: '1' }] },
  });
  mocks.executionCreate.mockResolvedValue({ id: executionId });
  mocks.executionUpdate.mockResolvedValue({});
  mocks.testResultCreate.mockResolvedValue({});
  mocks.executeSubmission.mockImplementation(async (_profile, { onPhase, onTestResult }) => {
    await onPhase(SubmissionStatus.COMPILING);
    await onPhase(SubmissionStatus.RUNNING);
    await onTestResult({
      testCaseId,
      testIndex: 1,
      status: TestResultStatus.PASSED,
      executionTimeMs: 12,
      errorMessage: null,
    });
    return {
      status: SubmissionStatus.ACCEPTED,
      executionTimeMs: 12,
      memoryUsedKb: null,
      errorMessage: null,
    };
  });
});

describe('submission worker processor', () => {
  it('persists validated state transitions, execution metadata, and per-test results', async () => {
    const result = await processSubmission(submissionId, mocks.publishEvent);

    expect(result).toEqual({ processed: true, status: SubmissionStatus.ACCEPTED });
    expect(
      mocks.submissionUpdateMany.mock.calls
        .map(([args]) => args.data.status)
        .filter((status) => status !== undefined),
    ).toEqual([
      SubmissionStatus.ASSIGNED,
      SubmissionStatus.STARTING,
      SubmissionStatus.COMPILING,
      SubmissionStatus.RUNNING,
      SubmissionStatus.ACCEPTED,
    ]);
    expect(mocks.executionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        submissionId,
        attemptNumber: 1,
        languageVersion: '21',
        dockerImage: 'eclipse-temurin:21-jdk-jammy',
      }),
      select: { id: true },
    });
    expect(mocks.executeSubmission).toHaveBeenCalledWith(
      expect.objectContaining({ language: SubmissionLanguage.JAVA }),
      expect.objectContaining({ sourceCode: 'public class Main {}' }),
    );
    expect(mocks.testResultCreate).toHaveBeenCalledWith({
      data: {
        executionId,
        testCaseId,
        testIndex: 1,
        status: TestResultStatus.PASSED,
        executionTimeMs: 12,
        errorMessage: null,
      },
    });
    expect(mocks.publishEvent.mock.calls.map(([event]) => event.type)).toEqual([
      'submission:assigned',
      'submission:starting',
      'submission:compiling',
      'submission:running',
      'submission:test-progress',
      'submission:completed',
    ]);
    expect(mocks.publishEvent.mock.calls[4]?.[0]).toMatchObject({
      type: 'submission:test-progress',
      submissionId,
      userId: 'a25145ab-21aa-4d20-9e08-3a2b4d59110f',
      testIndex: 1,
      resultStatus: TestResultStatus.PASSED,
    });
    expect(mocks.publishEvent.mock.calls.at(-1)?.[0]).not.toHaveProperty('input');
    expect(mocks.publishEvent.mock.calls.at(-1)?.[0]).not.toHaveProperty('expectedOut');
  });

  it('releases a lease after Docker or persistence failures so RabbitMQ can retry', async () => {
    mocks.executeSubmission.mockRejectedValue(new Error('private daemon address'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(processSubmission(submissionId, mocks.publishEvent)).rejects.toBeInstanceOf(
      RetryableSubmissionError,
    );

    expect(mocks.submissionUpdateMany.mock.calls.at(-1)?.[0]).toMatchObject({
      where: { id: submissionId, status: SubmissionStatus.STARTING },
      data: {
        status: SubmissionStatus.QUEUED,
        workerId: null,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    expect(mocks.executionUpdate).toHaveBeenCalledWith({
      where: { id: executionId },
      data: { completedAt: expect.any(Date) },
    });
    expect(mocks.publishEvent.mock.calls.at(-1)?.[0]).toMatchObject({
      type: 'submission:queued',
      status: SubmissionStatus.QUEUED,
    });
  });

  it('persists compiler diagnostics as a terminal compilation error', async () => {
    mocks.executeSubmission.mockImplementation(async (_profile, { onPhase }) => {
      await onPhase(SubmissionStatus.COMPILING);
      return {
        status: SubmissionStatus.COMPILATION_ERROR,
        executionTimeMs: null,
        memoryUsedKb: null,
        errorMessage: 'Main.java:1: error: expected a semicolon',
      };
    });

    const result = await processSubmission(submissionId, mocks.publishEvent);

    expect(result).toEqual({ processed: true, status: SubmissionStatus.COMPILATION_ERROR });
    expect(mocks.submissionUpdateMany.mock.calls.map(([args]) => args.data.status)).toEqual([
      SubmissionStatus.ASSIGNED,
      SubmissionStatus.STARTING,
      SubmissionStatus.COMPILING,
      SubmissionStatus.COMPILATION_ERROR,
    ]);
    expect(mocks.submissionUpdateMany.mock.calls.at(-1)?.[0].data.errorMessage).toBe(
      'Main.java:1: error: expected a semicolon',
    );
    expect(mocks.testResultCreate).not.toHaveBeenCalled();
    expect(mocks.publishEvent.mock.calls.at(-1)?.[0]).toMatchObject({
      type: 'submission:failed',
      status: SubmissionStatus.COMPILATION_ERROR,
      errorMessage: 'Main.java:1: error: expected a semicolon',
    });
  });

  it.each([SubmissionStatus.ASSIGNED, SubmissionStatus.RUNNING, SubmissionStatus.ACCEPTED])(
    'does not start a second execution for a duplicate delivery in %s',
    async (status) => {
      mocks.submissionUpdateMany.mockResolvedValueOnce({ count: 0 });
      mocks.submissionFindUnique.mockResolvedValueOnce({
        status,
        attemptCount: 1,
        userId: 'a25145ab-21aa-4d20-9e08-3a2b4d59110f',
      });

      const result = await processSubmission(submissionId);

      expect(result).toEqual({ processed: false, status });
      expect(mocks.submissionUpdateMany).toHaveBeenCalledWith({
        where: {
          id: submissionId,
          status: SubmissionStatus.QUEUED,
          attemptCount: { lt: 3 },
        },
        data: expect.objectContaining({
          status: SubmissionStatus.ASSIGNED,
          attemptCount: { increment: 1 },
        }),
      });
      expect(mocks.executionCreate).not.toHaveBeenCalled();
      expect(mocks.executeSubmission).not.toHaveBeenCalled();
    },
  );
});
