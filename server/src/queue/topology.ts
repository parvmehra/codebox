import type { Channel } from 'amqplib';

export const SUBMISSION_QUEUE = 'submissions.execute';
export const SUBMISSION_RETRY_QUEUE = 'submissions.retry';
export const SUBMISSION_DEAD_QUEUE = 'submissions.dead';
export const SUBMISSION_CONTROL_EXCHANGE = 'submissions.control';
export const MAX_JOB_RETRIES = 2;
export const JOB_RETRY_DELAY_MS = 5_000;

export async function assertSubmissionTopology(channel: Channel): Promise<void> {
  await channel.assertQueue(SUBMISSION_QUEUE, { durable: true });
  await channel.assertQueue(SUBMISSION_RETRY_QUEUE, {
    durable: true,
    arguments: {
      'x-message-ttl': JOB_RETRY_DELAY_MS,
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': SUBMISSION_QUEUE,
    },
  });
  await channel.assertQueue(SUBMISSION_DEAD_QUEUE, { durable: true });
  await channel.assertExchange(SUBMISSION_CONTROL_EXCHANGE, 'fanout', { durable: false });
}
