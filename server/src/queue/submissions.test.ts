import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubmissionStatus } from '@prisma/client';

const sendToQueue = vi.fn((...args: unknown[]) => {
  const confirm = args[3] as ((error: Error | null) => void) | undefined;
  confirm?.(null);
  return true;
});
const publish = vi.fn((...args: unknown[]) => {
  const confirm = args[4] as ((error: Error | null) => void) | undefined;
  confirm?.(null);
  return true;
});
const fakeChannel = {
  assertExchange: vi.fn().mockResolvedValue({}),
  assertQueue: vi.fn().mockResolvedValue({}),
  close: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  publish,
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

const { closeSubmissionPublisher, publishSubmission, publishSubmissionEvent, SUBMISSION_QUEUE } =
  await import('./submissions.js');

beforeEach(() => vi.clearAllMocks());

afterEach(async () => closeSubmissionPublisher());

describe('submission queue publisher', () => {
  it('publishes a persistent job and waits for the broker confirmation', async () => {
    const submissionId = 'c3070e38-c557-43d5-a59b-e8af46675370';

    await publishSubmission(submissionId);

    expect(connect).toHaveBeenCalledOnce();
    expect(fakeChannel.assertQueue).toHaveBeenCalledWith(SUBMISSION_QUEUE, { durable: true });
    expect(fakeChannel.assertExchange).toHaveBeenCalledWith('submissions.events', 'topic', {
      durable: false,
    });
    expect(sendToQueue).toHaveBeenCalledOnce();

    const [queue, content, options] = sendToQueue.mock.calls[0] as [
      string,
      Buffer,
      Record<string, unknown>,
    ];
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

  it('publishes only the transient event fields on the matching routing key', async () => {
    await publishSubmissionEvent({
      type: 'submission:queued',
      submissionId: 'c3070e38-c557-43d5-a59b-e8af46675370',
      userId: 'a25145ab-21aa-4d20-9e08-3a2b4d59110f',
      status: SubmissionStatus.QUEUED,
      updatedAt: '2026-10-16T10:00:00.000Z',
    });

    const [exchange, routingKey, content, options] = publish.mock.calls[0] as [
      string,
      string,
      Buffer,
      Record<string, unknown>,
    ];
    expect(exchange).toBe('submissions.events');
    expect(routingKey).toBe('submission.queued');
    expect(JSON.parse(content.toString())).toMatchObject({ type: 'submission:queued' });
    expect(options).toMatchObject({
      contentType: 'application/json',
      persistent: false,
      type: 'submission:queued',
    });
  });
});
