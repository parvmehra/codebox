import type { ConfirmChannel, ConsumeMessage, Options } from 'amqplib';
import { SUBMISSION_DEAD_QUEUE, SUBMISSION_RETRY_QUEUE } from './topology.js';

export async function publishRetryMessage(
  channel: ConfirmChannel,
  message: ConsumeMessage,
  retryCount: number,
): Promise<void> {
  await publishConfirmed(channel, SUBMISSION_RETRY_QUEUE, message, {
    contentType: message.properties.contentType ?? 'application/json',
    contentEncoding: message.properties.contentEncoding,
    messageId: message.properties.messageId,
    correlationId: message.properties.correlationId,
    timestamp: Date.now(),
    type: message.properties.type ?? 'submission.execute',
    persistent: true,
    headers: { ...message.properties.headers, 'x-retry-count': retryCount },
  });
}

export async function publishDeadLetter(
  channel: ConfirmChannel,
  message: ConsumeMessage,
  reason: string,
): Promise<void> {
  await publishConfirmed(channel, SUBMISSION_DEAD_QUEUE, message, {
    contentType: message.properties.contentType ?? 'application/json',
    contentEncoding: message.properties.contentEncoding,
    messageId: message.properties.messageId,
    correlationId: message.properties.correlationId,
    timestamp: Date.now(),
    type: message.properties.type ?? 'submission.execute',
    persistent: true,
    headers: {
      ...message.properties.headers,
      'x-retry-count': getRetryCount(message),
      'x-dead-letter-reason': reason,
      'x-dead-lettered-at': new Date().toISOString(),
    },
  });
}

export function getRetryCount(message: ConsumeMessage): number {
  const count = message.properties.headers?.['x-retry-count'];
  return typeof count === 'number' && Number.isInteger(count) && count > 0 ? count : 0;
}

function publishConfirmed(
  channel: ConfirmChannel,
  queue: string,
  message: ConsumeMessage,
  options: Options.Publish,
): Promise<void> {
  return new Promise((resolve, reject) => {
    channel.sendToQueue(queue, message.content, options, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}
