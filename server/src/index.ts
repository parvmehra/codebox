import { createServer } from 'node:http';
import { createSocketServer } from './realtime/socket-server.js';
import { startRealtimeEventConsumer } from './realtime/event-consumer.js';
import { app } from './app.js';
import { env } from './config/env.js';
import { prisma } from './database/prisma.js';
import { closeSubmissionPublisher } from './queue/submissions.js';

const server = createServer(app);
const io = createSocketServer(server);
const closeRealtimeEventConsumer = await startRealtimeEventConsumer(io);
server.listen(env.PORT, () => console.info({ port: env.PORT }, 'API listening'));
let isShuttingDown = false;

async function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.info({ signal }, 'API shutdown requested');

  await Promise.allSettled([
    new Promise<void>((resolve) => io.close(() => resolve())),
    closeRealtimeEventConsumer(),
    closeSubmissionPublisher(),
    prisma.$disconnect(),
  ]);
  process.exitCode = 0;
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
