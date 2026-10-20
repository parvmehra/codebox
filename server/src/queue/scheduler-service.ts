import { SubmissionStatus, WorkerStatus } from '@prisma/client';
import amqp, { type ChannelModel, type ConfirmChannel, type ConsumeMessage } from 'amqplib';
import { z } from 'zod';
import { runtimeEnv } from '../config/runtime-env.js';
import { prisma } from '../database/prisma.js';
import { logger } from '../observability/logger.js';
import {
  schedulerAssignmentsTotal,
  schedulerQueueDepth,
  schedulerReady,
} from '../observability/metrics.js';
import { HEARTBEAT_TTL_MS } from '../realtime/worker-status.js';
import { publishDeadLetter } from './delivery.js';
import {
  chooseWorkerQueue,
  resolveMessagePriority,
  type SchedulerWorker,
  type WorkerQueueDepth,
} from './scheduler.js';
import {
  assertSubmissionTopology,
  MAX_SUBMISSION_PRIORITY,
  SUBMISSION_INGRESS_QUEUE,
  SUBMISSION_QUEUE,
  SUBMISSION_SCHEDULER_WAIT_QUEUE,
  workerQueueName,
} from './topology.js';

const schedulerJob = z.object({ submissionId: z.string().uuid() });
const log = logger.child({ component: 'scheduler' });

let connection: ChannelModel | undefined;
let channel: ConfirmChannel | undefined;
let consumerTags: string[] = [];
let schedulerIsReady = false;
const activeDeliveries = new Set<Promise<void>>();

export function isSubmissionSchedulerReady(): boolean {
  return schedulerIsReady;
}

export async function startSubmissionScheduler(): Promise<() => Promise<void>> {
  connection = await amqp.connect(runtimeEnv.RABBITMQ_URL);
  channel = await connection.createConfirmChannel();
  await assertSubmissionTopology(channel);
  await channel.prefetch(1);

  const consumers = await Promise.all(
    [SUBMISSION_INGRESS_QUEUE, SUBMISSION_QUEUE].map((queue) =>
      channel!.consume(queue, (message) => {
        if (!message || !channel) return;
        const delivery = handleDelivery(channel, message).catch((error: unknown) => {
          log.error(
            { error, messageId: message.properties.messageId },
            'Scheduler delivery failed',
          );
          try {
            channel?.nack(message, false, true);
          } catch {
            // Closing the channel requeues any unacknowledged delivery.
          }
        });
        activeDeliveries.add(delivery);
        void delivery.finally(() => activeDeliveries.delete(delivery));
      }),
    ),
  );
  consumerTags = consumers.map(({ consumerTag }) => consumerTag);

  connection.on('error', (error: Error) => {
    setSchedulerReady(false);
    log.error({ error }, 'Scheduler RabbitMQ connection error');
  });
  connection.on('close', () => setSchedulerReady(false));
  channel.on('error', (error: Error) => {
    setSchedulerReady(false);
    log.error({ error }, 'Scheduler RabbitMQ channel error');
  });
  channel.on('close', () => setSchedulerReady(false));
  setSchedulerReady(true);
  log.info(
    { queues: [SUBMISSION_INGRESS_QUEUE, SUBMISSION_QUEUE] },
    'Submission scheduler is ready',
  );

  return stopSubmissionScheduler;
}

export async function stopSubmissionScheduler(): Promise<void> {
  setSchedulerReady(false);
  const currentChannel = channel;
  if (!currentChannel) return;

  await Promise.all(
    consumerTags.map((consumerTag) => currentChannel.cancel(consumerTag).catch(() => undefined)),
  );
  await Promise.allSettled([...activeDeliveries]);
  consumerTags = [];
  channel = undefined;
  await currentChannel.close().catch(() => undefined);
  const currentConnection = connection;
  connection = undefined;
  await currentConnection?.close().catch(() => undefined);
}

function setSchedulerReady(ready: boolean): void {
  schedulerIsReady = ready;
  schedulerReady.set(Number(ready));
}

async function handleDelivery(
  schedulerChannel: ConfirmChannel,
  message: ConsumeMessage,
): Promise<void> {
  let value: unknown;
  try {
    value = JSON.parse(message.content.toString('utf8'));
  } catch {
    await publishDeadLetter(schedulerChannel, message, 'invalid-json');
    schedulerChannel.ack(message);
    return;
  }

  const parsed = schedulerJob.safeParse(value);
  if (!parsed.success) {
    await publishDeadLetter(schedulerChannel, message, 'invalid-payload');
    schedulerChannel.ack(message);
    return;
  }

  const submission = await prisma.submission.findUnique({
    where: { id: parsed.data.submissionId },
    select: { status: true, language: true, priority: true },
  });
  if (!submission || submission.status !== SubmissionStatus.QUEUED) {
    schedulerChannel.ack(message);
    return;
  }

  const cutoff = new Date(Date.now() - HEARTBEAT_TTL_MS);
  const workerRecords = await prisma.worker.findMany({
    where: { status: WorkerStatus.ONLINE, lastHeartbeatAt: { gte: cutoff } },
    select: { id: true, capabilities: true, activeJobs: true },
  });
  const workers: SchedulerWorker[] = workerRecords.map((worker) => ({
    workerId: worker.id,
    capabilities: worker.capabilities,
    activeJobs: worker.activeJobs,
  }));
  const queueNames = [
    ...new Set(
      workers
        .filter(({ capabilities }) => capabilities.length > 0)
        .map(({ capabilities }) => workerQueueName(capabilities)),
    ),
  ];
  const queueDepths = new Map<string, WorkerQueueDepth>();

  for (const queueName of queueNames) {
    const { messageCount, consumerCount } = await schedulerChannel.assertQueue(queueName, {
      durable: true,
      arguments: { 'x-max-priority': MAX_SUBMISSION_PRIORITY },
    });
    queueDepths.set(queueName, { messageCount, consumerCount });
  }

  const assignment = chooseWorkerQueue(submission.language, workers, queueDepths);
  if (!assignment) {
    await publishConfirmed(schedulerChannel, SUBMISSION_SCHEDULER_WAIT_QUEUE, message, {
      priority: resolveMessagePriority(submission.priority, runtimeEnv.SCHEDULER_STRATEGY),
      headers: { ...message.properties.headers, 'x-scheduler-waiting': true },
    });
    schedulerAssignmentsTotal.inc({
      language: submission.language,
      strategy: runtimeEnv.SCHEDULER_STRATEGY,
      destination: 'wait',
    });
    schedulerChannel.ack(message);
    return;
  }

  await publishConfirmed(schedulerChannel, assignment.queueName, message, {
    priority: resolveMessagePriority(submission.priority, runtimeEnv.SCHEDULER_STRATEGY),
  });
  schedulerAssignmentsTotal.inc({
    language: submission.language,
    strategy: runtimeEnv.SCHEDULER_STRATEGY,
    destination: 'worker',
  });
  schedulerQueueDepth.observe(
    { language: submission.language, strategy: runtimeEnv.SCHEDULER_STRATEGY },
    assignment.queuedJobs,
  );
  schedulerChannel.ack(message);
  log.info(
    {
      submissionId: parsed.data.submissionId,
      language: submission.language,
      strategy: runtimeEnv.SCHEDULER_STRATEGY,
      queueName: assignment.queueName,
      queuedJobs: assignment.queuedJobs,
      averageActiveJobs: assignment.averageActiveJobs,
      candidateWorkers: assignment.workerCount,
    },
    'Scheduled submission for a compatible worker group',
  );
}

function publishConfirmed(
  publisher: ConfirmChannel,
  queue: string,
  message: ConsumeMessage,
  override: { priority: number; headers?: Record<string, unknown> },
): Promise<void> {
  return new Promise((resolve, reject) => {
    publisher.sendToQueue(
      queue,
      message.content,
      {
        persistent: true,
        contentType: message.properties.contentType ?? 'application/json',
        contentEncoding: message.properties.contentEncoding,
        messageId: message.properties.messageId,
        correlationId: message.properties.correlationId,
        timestamp: Date.now(),
        type: message.properties.type ?? 'submission.execute',
        priority: override.priority,
        headers: override.headers ?? message.properties.headers,
      },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}
