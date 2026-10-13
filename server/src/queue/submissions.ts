import amqp from 'amqplib';
import type { ChannelModel, ConfirmChannel } from 'amqplib';
import { env } from '../config/env.js';

export const SUBMISSION_QUEUE = 'submissions.execute';

let connection: ChannelModel | undefined;
let channel: ConfirmChannel | undefined;
let channelPromise: Promise<ConfirmChannel> | undefined;

async function createChannel(): Promise<ConfirmChannel> {
  const nextConnection = await amqp.connect(env.RABBITMQ_URL);

  try {
    const nextChannel = await nextConnection.createConfirmChannel();
    await nextChannel.assertQueue(SUBMISSION_QUEUE, { durable: true });

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

export async function publishSubmission(submissionId: string): Promise<void> {
  const publisher = await getConfirmChannel();
  const payload = Buffer.from(JSON.stringify({ submissionId }));

  await new Promise<void>((resolve, reject) => {
    publisher.sendToQueue(
      SUBMISSION_QUEUE,
      payload,
      {
        persistent: true,
        contentType: 'application/json',
        messageId: submissionId,
        timestamp: Date.now(),
        type: 'submission.execute',
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
