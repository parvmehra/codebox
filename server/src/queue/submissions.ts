import amqp from 'amqplib';
import type { ChannelModel, ConfirmChannel } from 'amqplib';
import { runtimeEnv } from '../config/runtime-env.js';
import {
  realtimeRoutingKey,
  SUBMISSION_EVENTS_EXCHANGE,
  type SubmissionRealtimeEvent,
} from '../realtime/events.js';
import {
  assertSubmissionTopology,
  SUBMISSION_CONTROL_EXCHANGE,
  SUBMISSION_DEAD_QUEUE,
  SUBMISSION_INGRESS_QUEUE,
} from './topology.js';
import { resolveMessagePriority } from './scheduler.js';

export { SUBMISSION_INGRESS_QUEUE, SUBMISSION_QUEUE } from './topology.js';

let connection: ChannelModel | undefined;
let channel: ConfirmChannel | undefined;
let channelPromise: Promise<ConfirmChannel> | undefined;

async function createChannel(): Promise<ConfirmChannel> {
  const nextConnection = await amqp.connect(runtimeEnv.RABBITMQ_URL);

  try {
    const nextChannel = await nextConnection.createConfirmChannel();
    await assertSubmissionTopology(nextChannel);
    await nextChannel.assertExchange(SUBMISSION_EVENTS_EXCHANGE, 'topic', { durable: false });

    nextConnection.on('error', (error: Error) => {
      console.error({ error }, 'RabbitMQ connection error');
    });
    nextConnection.on('close', () => {
      if (connection !== nextConnection) return;
      connection = undefined;
      channel = undefined;
      channelPromise = undefined;
    });
    nextChannel.on('close', () => {
      if (channel !== nextChannel) return;
      const staleConnection = connection;
      connection = undefined;
      channel = undefined;
      channelPromise = undefined;
      void staleConnection?.close().catch(() => undefined);
    });
    nextChannel.on('error', (error: Error) => {
      console.error({ error }, 'RabbitMQ publisher channel error');
    });

    connection = nextConnection;
    channel = nextChannel;
    return nextChannel;
  } catch (error) {
    await nextConnection.close().catch(() => undefined);
    throw error;
  }
}

async function getConfirmChannel(): Promise<ConfirmChannel> {
  if (channel) return channel;
  if (!channelPromise) channelPromise = createChannel();

  const pendingChannel = channelPromise;
  try {
    return await pendingChannel;
  } catch (error) {
    if (channelPromise === pendingChannel) channelPromise = undefined;
    throw error;
  }
}

export async function publishSubmission(submissionId: string, priority = 0): Promise<void> {
  const publisher = await getConfirmChannel();
  const payload = Buffer.from(JSON.stringify({ submissionId }));

  await new Promise<void>((resolve, reject) => {
    publisher.sendToQueue(
      SUBMISSION_INGRESS_QUEUE,
      payload,
      {
        persistent: true,
        contentType: 'application/json',
        messageId: submissionId,
        timestamp: Date.now(),
        type: 'submission.execute',
        priority: resolveMessagePriority(priority, runtimeEnv.SCHEDULER_STRATEGY),
      },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

export async function publishSubmissionEvent(event: SubmissionRealtimeEvent): Promise<void> {
  const publisher = await getConfirmChannel();
  const payload = Buffer.from(JSON.stringify(event));

  await new Promise<void>((resolve, reject) => {
    publisher.publish(
      SUBMISSION_EVENTS_EXCHANGE,
      realtimeRoutingKey(event),
      payload,
      { contentType: 'application/json', persistent: false, type: event.type },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

export async function publishSubmissionCancellation(submissionId: string): Promise<void> {
  const publisher = await getConfirmChannel();
  const payload = Buffer.from(JSON.stringify({ submissionId }));

  await new Promise<void>((resolve, reject) => {
    publisher.publish(
      SUBMISSION_CONTROL_EXCHANGE,
      '',
      payload,
      { contentType: 'application/json', persistent: false, type: 'submission.cancel' },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

export async function publishSubmissionDeadLetter(
  submissionId: string,
  reason: string,
): Promise<void> {
  const publisher = await getConfirmChannel();
  const payload = Buffer.from(JSON.stringify({ submissionId }));

  await new Promise<void>((resolve, reject) => {
    publisher.sendToQueue(
      SUBMISSION_DEAD_QUEUE,
      payload,
      {
        persistent: true,
        contentType: 'application/json',
        messageId: submissionId,
        type: 'submission.execute',
        headers: { 'x-dead-letter-reason': reason, 'x-dead-lettered-at': new Date().toISOString() },
      },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

export async function closeSubmissionPublisher(): Promise<void> {
  const currentChannel = channel;
  const currentConnection = connection;
  channel = undefined;
  connection = undefined;
  channelPromise = undefined;

  await currentChannel?.close().catch(() => undefined);
  await currentConnection?.close().catch(() => undefined);
}
