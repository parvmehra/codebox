import amqp from 'amqplib';
import type { Channel, ChannelModel } from 'amqplib';
import type { Server } from 'socket.io';
import { runtimeEnv } from '../config/runtime-env.js';
import { realtimeEventSchema, SUBMISSION_EVENTS_EXCHANGE } from './events.js';

export async function startRealtimeEventConsumer(io: Server): Promise<() => Promise<void>> {
  const connection: ChannelModel = await amqp.connect(runtimeEnv.RABBITMQ_URL);
  let channel: Channel | undefined;

  try {
    channel = await connection.createChannel();
    await channel.assertExchange(SUBMISSION_EVENTS_EXCHANGE, 'topic', { durable: false });
    const { queue } = await channel.assertQueue('', {
      durable: false,
      exclusive: true,
      autoDelete: true,
    });
    await channel.bindQueue(queue, SUBMISSION_EVENTS_EXCHANGE, 'submission.*');
    await channel.bindQueue(queue, SUBMISSION_EVENTS_EXCHANGE, 'worker.heartbeat');

    await channel.consume(
      queue,
      (message) => {
        if (!message) return;
        const parsed = realtimeEventSchema.safeParse(parseMessage(message.content));
        if (!parsed.success) {
          console.warn('Discarding an invalid real-time event.');
          return;
        }

        const event = parsed.data;
        if (event.type === 'worker:heartbeat') return;

        const { userId, ...clientEvent } = event;
        io.to(`user:${userId}`).emit(event.type, clientEvent);
      },
      { noAck: true },
    );

    console.info('Real-time event consumer is ready');
    return async () => {
      await channel?.close().catch(() => undefined);
      await connection.close().catch(() => undefined);
    };
  } catch (error) {
    await channel?.close().catch(() => undefined);
    await connection.close().catch(() => undefined);
    throw error;
  }
}

function parseMessage(content: Buffer): unknown {
  try {
    return JSON.parse(content.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}
