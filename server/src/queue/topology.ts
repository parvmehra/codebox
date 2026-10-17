import type { Channel } from 'amqplib';

export const SUBMISSION_QUEUE = 'submissions.execute';
export const SUBMISSION_INGRESS_QUEUE = 'submissions.scheduler';
export const SUBMISSION_RETRY_QUEUE = 'submissions.retry';
export const SUBMISSION_RETRY_QUEUE_V2 = 'submissions.retry.priority';
export const SUBMISSION_SCHEDULER_WAIT_QUEUE = 'submissions.scheduler.wait';
export const SUBMISSION_DEAD_QUEUE = 'submissions.dead';
export const SUBMISSION_CONTROL_EXCHANGE = 'submissions.control';
export const MAX_JOB_RETRIES = 2;
export const JOB_RETRY_DELAY_MS = 5_000;
export const SCHEDULER_WAIT_DELAY_MS = 15_000;
export const MAX_SUBMISSION_PRIORITY = 10;
export const SUBMISSION_WORKER_QUEUE_PREFIX = 'submissions.worker';

export function workerQueueName(capabilities: readonly string[]): string {
  const normalized = [...new Set(capabilities)].sort();
  if (normalized.length === 0) throw new Error('A worker must support at least one language.');
  return `${SUBMISSION_WORKER_QUEUE_PREFIX}.${normalized.map((value) => value.toLowerCase()).join('.')}`;
}

export async function assertSubmissionTopology(channel: Channel): Promise<void> {
  await channel.assertQueue(SUBMISSION_QUEUE, { durable: true });
  await channel.assertQueue(SUBMISSION_INGRESS_QUEUE, {
    durable: true,
    arguments: { 'x-max-priority': MAX_SUBMISSION_PRIORITY },
  });
  await channel.assertQueue(SUBMISSION_RETRY_QUEUE, {
    durable: true,
    arguments: {
      'x-message-ttl': JOB_RETRY_DELAY_MS,
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': SUBMISSION_QUEUE,
    },
  });
  await channel.assertQueue(SUBMISSION_RETRY_QUEUE_V2, {
    durable: true,
    arguments: {
      'x-message-ttl': JOB_RETRY_DELAY_MS,
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': SUBMISSION_INGRESS_QUEUE,
    },
  });
  await channel.assertQueue(SUBMISSION_SCHEDULER_WAIT_QUEUE, {
    durable: true,
    arguments: {
      'x-message-ttl': SCHEDULER_WAIT_DELAY_MS,
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': SUBMISSION_INGRESS_QUEUE,
      'x-max-priority': MAX_SUBMISSION_PRIORITY,
    },
  });
  await channel.assertQueue(SUBMISSION_DEAD_QUEUE, { durable: true });
  await channel.assertExchange(SUBMISSION_CONTROL_EXCHANGE, 'fanout', { durable: false });
}

export async function assertWorkerQueue(channel: Channel, capabilities: readonly string[]) {
  return channel.assertQueue(workerQueueName(capabilities), {
    durable: true,
    arguments: { 'x-max-priority': MAX_SUBMISSION_PRIORITY },
  });
}
