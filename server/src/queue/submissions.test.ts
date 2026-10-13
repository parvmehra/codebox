import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendToQueue = vi.fn((...args: unknown[]) => {
  const confirm = args[3] as ((error: Error | null) => void) | undefined;
  confirm?.(null);
  return true;
});
const fakeChannel = {
  assertQueue: vi.fn().mockResolvedValue({}),
  close: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  sendToQueue,
};
const fakeConnection = {
  close: vi.fn().mockResolvedValue(undefined),
  createConfirmChannel: vi.fn().mockResolvedValue(fakeChannel),
  on: vi.fn(),
};
const connect = vi.fn().mockResolvedValue(fakeConnection);

vi.doMock('amqplib', () => ({ default: { connect } }));

process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET ??= 'test-secret-for-submission-api-tests-only-32';

const { closeSubmissionPublisher, publishSubmission, SUBMISSION_QUEUE } = await import('./submissions.js');

beforeEach(() => vi.clearAllMocks());

afterEach(async () => closeSubmissionPublisher());

describe('submission queue publisher', () => {
  it('publishes a persistent job and waits for the broker confirmation', async () => {
    const submissionId = 'c3070e38-c557-43d5-a59b-e8af46675370';

    await publishSubmission(submissionId);

    expect(connect).toHaveBeenCalledOnce();
    expect(fakeChannel.assertQueue).toHaveBeenCalledWith(SUBMISSION_QUEUE, { durable: true });
    expect(sendToQueue).toHaveBeenCalledOnce();

    const [queue, content, options] = sendToQueue.mock.calls[0] as [string, Buffer, Record<string, unknown>];
    expect(queue).toBe(SUBMISSION_QUEUE);
    expect(JSON.parse(content.toString())).toEqual({ submissionId });
    expect(options).toMatchObject({
      persistent: true,
      contentType: 'application/json',
      messageId: submissionId,
      type: 'submission.execute',
    });
  });

  it('rejects when RabbitMQ negatively acknowledges a job', async () => {
    sendToQueue.mockImplementationOnce((...args: unknown[]) => {
      const confirm = args[3] as ((error: Error | null) => void) | undefined;
      confirm?.(new Error('broker rejected message'));
      return true;
    });

    await expect(publishSubmission('c3070e38-c557-43d5-a59b-e8af46675370')).rejects.toThrow(
      'broker rejected message',
    );
  });
});
