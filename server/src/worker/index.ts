import amqp, { type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib';
import { z } from 'zod';
import { runtimeEnv } from '../config/runtime-env.js';
import { prisma } from '../database/prisma.js';
import { SUBMISSION_QUEUE } from '../queue/submissions.js';
import { ensureLanguageImages } from './docker-executor.js';
import { processSubmission } from './processor.js';

const submissionJob = z.object({ submissionId: z.string().uuid() });

let connection: ChannelModel | undefined;
let channel: Channel | undefined;
let consumerTag: string | undefined;
let isShuttingDown = false;
const activeMessages = new Set<Promise<void>>();

async function startWorker(): Promise<void> {
  await ensureLanguageImages();
  connection = await amqp.connect(runtimeEnv.RABBITMQ_URL);
  channel = await connection.createChannel();
  await channel.assertQueue(SUBMISSION_QUEUE, { durable: true });
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

  const consumer = await channel.consume(
    SUBMISSION_QUEUE,
    (message) => {
      if (!message) return;
      const work = handleMessage(message).catch((error: unknown) => {
        console.error({ error }, 'Unexpected error handling submission delivery');
      });
      activeMessages.add(work);
      void work.finally(() => activeMessages.delete(work));
    },
    { noAck: false },
  );
  consumerTag = consumer.consumerTag;
  console.info({ queue: SUBMISSION_QUEUE, consumerTag }, 'Submission worker is ready');
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
    channel?.ack(message);
    return;
  }

  const parsed = submissionJob.safeParse(payload);
  if (!parsed.success) {
    console.error(
      { messageId: message.properties.messageId },
      'Discarding malformed submission job',
    );
    channel?.ack(message);
    return;
  }

  try {
    const result = await processSubmission(parsed.data.submissionId);
    console.info({ submissionId: parsed.data.submissionId, ...result }, 'Submission job processed');
    channel?.ack(message);
  } catch (error) {
    console.error(
      { error, submissionId: parsed.data.submissionId },
      'Submission job could not be persisted',
    );
    channel?.nack(message, false, true);
  }
}

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.info({ signal }, 'Worker shutdown requested');

  if (consumerTag) await channel?.cancel(consumerTag).catch(() => undefined);
  await Promise.allSettled([...activeMessages]);
  await channel?.close().catch(() => undefined);
  await connection?.close().catch(() => undefined);
  await prisma.$disconnect().catch((error: unknown) => {
    console.error({ error }, 'Could not disconnect worker database client');
  });
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

void startWorker().catch(async (error: unknown) => {
  console.error({ error }, 'Could not start submission worker');
  process.exitCode = 1;
  await connection?.close().catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
});
