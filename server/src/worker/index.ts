import { randomUUID } from 'node:crypto';
import { WorkerStatus } from '@prisma/client';
import amqp, { type ChannelModel, type ConfirmChannel, type ConsumeMessage } from 'amqplib';
import { z } from 'zod';
import { runtimeEnv } from '../config/runtime-env.js';
import { prisma } from '../database/prisma.js';
import { getRetryCount, publishDeadLetter, publishRetryMessage } from '../queue/delivery.js';
import {
  assertSubmissionTopology,
  MAX_JOB_RETRIES,
  SUBMISSION_CONTROL_EXCHANGE,
  assertWorkerQueue,
} from '../queue/topology.js';
import { SUBMISSION_LEASE_MS } from '../queue/reliability.js';
import { parseWorkerCapabilities } from '../queue/scheduler.js';
import { SUBMISSION_EVENTS_EXCHANGE } from '../realtime/events.js';
import { publishRealtimeEvent } from '../realtime/publish.js';
import { persistWorkerHeartbeat } from '../realtime/worker-status.js';
import { ensureLanguageImages } from './docker-executor.js';
import { failQueuedSubmission, processSubmission } from './processor.js';

const submissionJob = z.object({ submissionId: z.string().uuid() });
const cancellationMessage = z.object({ submissionId: z.string().uuid() });
const ACTIVE_STATUSES = ['ASSIGNED', 'STARTING', 'COMPILING', 'RUNNING'] as const;
const HEARTBEAT_INTERVAL_MS = 15_000;
const CANCELLATION_POLL_MS = 2_000;
const SHUTDOWN_DRAIN_MS = 18_000;
const SHUTDOWN_ABORT_WAIT_MS = 7_000;
const workerCapabilities = parseWorkerCapabilities(runtimeEnv.WORKER_LANGUAGES);

type ActiveSubmission = {
  controller: AbortController;
  leaseToken: string;
};

let connection: ChannelModel | undefined;
let channel: ConfirmChannel | undefined;
let consumerTag: string | undefined;
let controlConsumerTag: string | undefined;
let heartbeatTimer: NodeJS.Timeout | undefined;
let cancellationTimer: NodeJS.Timeout | undefined;
let isShuttingDown = false;
const activeMessages = new Set<Promise<void>>();
const activeSubmissions = new Map<string, ActiveSubmission>();
const workerId = randomUUID();

async function startWorker(): Promise<void> {
  await ensureLanguageImages();
  connection = await amqp.connect(runtimeEnv.RABBITMQ_URL);
  channel = await connection.createConfirmChannel();
  await assertSubmissionTopology(channel);
  const workerQueue = (await assertWorkerQueue(channel, workerCapabilities)).queue;
  await channel.assertExchange(SUBMISSION_EVENTS_EXCHANGE, 'topic', { durable: false });
  await channel.prefetch(1);

  connection.on('error', (error: Error) => {
    console.error({ error }, 'RabbitMQ worker connection error');
  });
  connection.on('close', () => {
    if (isShuttingDown) return;
    console.error('RabbitMQ worker connection closed unexpectedly.');
    process.exitCode = 1;
    void shutdown('broker-connection-closed');
  });
  channel.on('error', (error: Error) => {
    console.error({ error }, 'RabbitMQ worker channel error');
  });

  const controlQueue = await channel.assertQueue('', {
    durable: false,
    exclusive: true,
    autoDelete: true,
  });
  await channel.bindQueue(controlQueue.queue, SUBMISSION_CONTROL_EXCHANGE, '');
  const controlConsumer = await channel.consume(
    controlQueue.queue,
    (message) => {
      if (message) handleCancellation(message);
    },
    { noAck: true },
  );
  controlConsumerTag = controlConsumer.consumerTag;

  const consumer = await channel.consume(
    workerQueue,
    (message) => {
      if (!message) return;
      const work = handleMessage(message).catch((error: unknown) => {
        console.error({ error }, 'Unexpected error handling submission delivery');
        try {
          channel?.nack(message, false, true);
        } catch {
          // Closing the channel requeues any unacknowledged delivery.
        }
      });
      activeMessages.add(work);
      void work.finally(() => activeMessages.delete(work));
    },
    { noAck: false },
  );
  consumerTag = consumer.consumerTag;
  heartbeatTimer = setInterval(
    () => void publishWorkerHeartbeat(WorkerStatus.ONLINE),
    HEARTBEAT_INTERVAL_MS,
  );
  heartbeatTimer.unref();
  cancellationTimer = setInterval(() => void monitorActiveSubmissions(), CANCELLATION_POLL_MS);
  cancellationTimer.unref();
  await publishWorkerHeartbeat(WorkerStatus.ONLINE);
  console.info(
    { queue: workerQueue, workerId, capabilities: workerCapabilities, consumerTag },
    'Submission worker is ready',
  );
}

async function handleMessage(message: ConsumeMessage): Promise<void> {
  let payload: unknown;
  try {
    payload = JSON.parse(message.content.toString('utf8'));
  } catch {
    console.error(
      { messageId: message.properties.messageId },
      'Discarding invalid JSON submission job',
    );
    await deadLetter(message, 'invalid-json');
    return;
  }

  const parsed = submissionJob.safeParse(payload);
  if (!parsed.success) {
    console.error(
      { messageId: message.properties.messageId },
      'Discarding malformed submission job',
    );
    await deadLetter(message, 'invalid-payload');
    return;
  }

  const { submissionId } = parsed.data;
  const controller = new AbortController();
  const leaseToken = randomUUID();
  activeSubmissions.set(submissionId, { controller, leaseToken });
  const retryCount = getRetryCount(message);

  try {
    if (!channel) throw new Error('The worker channel is unavailable.');
    const result = await processSubmission(
      submissionId,
      (event) => publishRealtimeEvent(channel!, event),
      { workerId, leaseToken, signal: controller.signal },
    );
    console.info({ submissionId, ...result }, 'Submission job processed');
    if (result.attemptLimitReached) {
      await deadLetter(message, 'attempt-limit');
    } else {
      channel.ack(message);
    }
  } catch (error) {
    console.error({ error, submissionId, retryCount }, 'Submission processing attempt failed');
    try {
      if (retryCount < MAX_JOB_RETRIES) {
        await retryLater(message, retryCount + 1);
      } else {
        await failQueuedSubmission(submissionId, (event) =>
          publishRealtimeEvent(channel!, event),
        ).catch((finalizationError: unknown) => {
          console.error(
            { error: finalizationError, submissionId },
            'Could not persist the exhausted submission failure before dead-lettering',
          );
        });
        await deadLetter(message, 'retry-limit');
      }
    } catch (publishError) {
      console.error({ error: publishError, submissionId }, 'Could not route failed job');
      channel?.nack(message, false, true);
    }
  } finally {
    if (activeSubmissions.get(submissionId)?.controller === controller) {
      activeSubmissions.delete(submissionId);
    }
  }
}

function handleCancellation(message: ConsumeMessage): void {
  let payload: unknown;
  try {
    payload = JSON.parse(message.content.toString('utf8'));
  } catch {
    return;
  }
  const parsed = cancellationMessage.safeParse(payload);
  if (!parsed.success) return;
  const active = activeSubmissions.get(parsed.data.submissionId);
  if (active && !active.controller.signal.aborted) {
    active.controller.abort({ kind: 'user-cancel' });
  }
}

async function monitorActiveSubmissions(): Promise<void> {
  const active = [...activeSubmissions.entries()];
  if (active.length === 0) return;

  try {
    const cancelled = await prisma.submission.findMany({
      where: {
        id: { in: active.map(([submissionId]) => submissionId) },
        status: 'CANCELLED',
      },
      select: { id: true },
    });
    for (const submission of cancelled) {
      const running = activeSubmissions.get(submission.id);
      if (running && !running.controller.signal.aborted) {
        running.controller.abort({ kind: 'user-cancel' });
      }
    }
  } catch (error) {
    console.warn({ error }, 'Could not check active submission cancellations');
  }
}

async function publishWorkerHeartbeat(status: WorkerStatus): Promise<void> {
  const receivedAt = new Date();
  try {
    await persistWorkerHeartbeat(
      workerId,
      status,
      activeSubmissions.size,
      receivedAt,
      workerCapabilities,
    );
  } catch (error) {
    console.warn({ error, workerId }, 'Could not persist worker heartbeat');
  }

  if (!channel) return;
  try {
    publishRealtimeEvent(channel, {
      type: 'worker:heartbeat',
      workerId,
      status: status === WorkerStatus.ONLINE ? 'online' : 'offline',
      activeJobs: activeSubmissions.size,
      sentAt: receivedAt.toISOString(),
    });
  } catch (error) {
    console.warn({ error, workerId }, 'Could not publish worker heartbeat');
  }

  if (status !== WorkerStatus.ONLINE) return;
  for (const [submissionId, active] of activeSubmissions) {
    try {
      const renewed = await prisma.submission.updateMany({
        where: {
          id: submissionId,
          workerId,
          leaseToken: active.leaseToken,
          status: { in: [...ACTIVE_STATUSES] },
        },
        data: { leaseExpiresAt: new Date(Date.now() + SUBMISSION_LEASE_MS) },
      });
      if (renewed.count === 1) continue;

      const persisted = await prisma.submission.findUnique({
        where: { id: submissionId },
        select: { status: true, leaseToken: true },
      });
      if (!active.controller.signal.aborted) {
        active.controller.abort({
          kind: persisted?.status === 'CANCELLED' ? 'user-cancel' : 'lease-lost',
        });
      }
    } catch (error) {
      console.warn({ error, submissionId }, 'Could not renew submission lease');
    }
  }
}

async function retryLater(message: ConsumeMessage, retryCount: number): Promise<void> {
  if (!channel) throw new Error('The worker channel is unavailable.');
  await publishRetryMessage(channel, message, retryCount);
  channel.ack(message);
  console.warn({ retryCount, maxRetries: MAX_JOB_RETRIES }, 'Scheduled submission retry');
}

async function deadLetter(message: ConsumeMessage, reason: string): Promise<void> {
  if (!channel) throw new Error('The worker channel is unavailable.');
  await publishDeadLetter(channel, message, reason);
  channel.ack(message);
}

async function shutdown(signalName: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.info({ signal: signalName }, 'Worker shutdown requested');
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (cancellationTimer) clearInterval(cancellationTimer);

  if (consumerTag) await channel?.cancel(consumerTag).catch(() => undefined);
  if (controlConsumerTag) await channel?.cancel(controlConsumerTag).catch(() => undefined);

  const drained = Promise.allSettled([...activeMessages]);
  let timeout: NodeJS.Timeout | undefined;
  await Promise.race([
    drained,
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, SHUTDOWN_DRAIN_MS);
    }),
  ]);
  if (timeout) clearTimeout(timeout);

  if (activeMessages.size > 0) {
    for (const active of activeSubmissions.values()) {
      if (!active.controller.signal.aborted) active.controller.abort({ kind: 'shutdown' });
    }
    await Promise.race([drained, delay(SHUTDOWN_ABORT_WAIT_MS)]);
  }

  await publishWorkerHeartbeat(WorkerStatus.OFFLINE);
  await channel?.close().catch(() => undefined);
  await connection?.close().catch(() => undefined);
  await prisma.$disconnect().catch((error: unknown) => {
    console.error({ error }, 'Could not disconnect worker database client');
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

void startWorker().catch(async (error: unknown) => {
  console.error({ error }, 'Could not start submission worker');
  process.exitCode = 1;
  await connection?.close().catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
});
