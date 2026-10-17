import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import { describe, expect, it, vi } from 'vitest';
import { getRetryCount, publishDeadLetter, publishRetryMessage } from './delivery.js';
import { MAX_EXECUTION_ATTEMPTS } from './reliability.js';
import { MAX_JOB_RETRIES, SUBMISSION_DEAD_QUEUE, SUBMISSION_RETRY_QUEUE } from './topology.js';

const payload = Buffer.from(
  JSON.stringify({ submissionId: 'c3070e38-c557-43d5-a59b-e8af46675370' }),
);

function createMessage(headers: Record<string, unknown> = {}): ConsumeMessage {
  return {
    content: payload,
    properties: {
      contentType: 'application/json',
      messageId: 'c3070e38-c557-43d5-a59b-e8af46675370',
      type: 'submission.execute',
      headers,
    },
  } as ConsumeMessage;
}

function createConfirmChannel() {
  let confirm: ((error: Error | null) => void) | undefined;
  const sendToQueue = vi.fn(
    (
      _queue: string,
      _content: Buffer,
      _options: unknown,
      callback: (error: Error | null) => void,
    ) => {
      confirm = callback;
      return true;
    },
  );
  return {
    channel: { sendToQueue } as unknown as ConfirmChannel,
    sendToQueue,
    confirm: (error: Error | null = null) => confirm?.(error),
  };
}

describe('bounded RabbitMQ delivery policy', () => {
  it('limits each submission to three execution attempts', () => {
    expect(MAX_EXECUTION_ATTEMPTS).toBe(3);
    expect(MAX_JOB_RETRIES).toBe(MAX_EXECUTION_ATTEMPTS - 1);
  });

  it('copies a retry into the delayed durable queue and waits for publisher confirmation', async () => {
    const fake = createConfirmChannel();
    const pending = publishRetryMessage(fake.channel, createMessage({ trace: 'preserved' }), 2);

    expect(fake.sendToQueue).toHaveBeenCalledOnce();
    const [queue, content, options] = fake.sendToQueue.mock.calls[0];
    expect(queue).toBe(SUBMISSION_RETRY_QUEUE);
    expect(content).toEqual(payload);
    expect(options).toMatchObject({
      persistent: true,
      contentType: 'application/json',
      headers: { trace: 'preserved', 'x-retry-count': 2 },
    });

    let resolved = false;
    void pending.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    fake.confirm();
    await pending;
    expect(resolved).toBe(true);
  });

  it('moves exhausted or malformed jobs to the durable dead-letter queue with a reason', async () => {
    const fake = createConfirmChannel();
    const message = createMessage({ 'x-retry-count': 2 });
    const pending = publishDeadLetter(fake.channel, message, 'retry-limit');
    const [queue, content, options] = fake.sendToQueue.mock.calls[0];

    expect(queue).toBe(SUBMISSION_DEAD_QUEUE);
    expect(content).toEqual(payload);
    expect(options).toMatchObject({
      persistent: true,
      headers: {
        'x-retry-count': 2,
        'x-dead-letter-reason': 'retry-limit',
      },
    });
    fake.confirm();
    await pending;
  });

  it('sanitizes retry counters from malformed or absent headers', () => {
    expect(getRetryCount(createMessage())).toBe(0);
    expect(getRetryCount(createMessage({ 'x-retry-count': -1 }))).toBe(0);
    expect(getRetryCount(createMessage({ 'x-retry-count': '2' }))).toBe(0);
    expect(getRetryCount(createMessage({ 'x-retry-count': 2 }))).toBe(2);
  });
});
