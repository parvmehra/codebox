import { createServer } from 'node:http';
import { createSocketServer } from './realtime/socket-server.js';
import { startRealtimeEventConsumer } from './realtime/event-consumer.js';
import { app } from './app.js';
import { env } from './config/env.js';
import { prisma } from './database/prisma.js';
import { closeSubmissionPublisher } from './queue/submissions.js';
import { startSubmissionRecovery } from './modules/submissions/recovery.js';
import { startSubmissionScheduler } from './queue/scheduler-service.js';
import { logger } from './observability/logger.js';

const server = createServer(app);
const io = createSocketServer(server);
const closeRealtimeEventConsumer = await startRealtimeEventConsumer(io);
const stopSubmissionScheduler = await startSubmissionScheduler();
const stopSubmissionRecovery = await startSubmissionRecovery();
server.listen(env.PORT, () => logger.info({ port: env.PORT }, 'API listening'));
let isShuttingDown = false;

async function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info({ signal }, 'API shutdown requested');

  const socketServerClosed = new Promise<void>((resolve) => io.close(() => resolve()));
  await stopSubmissionRecovery();
  await stopSubmissionScheduler();
  await Promise.allSettled([
    socketServerClosed,
    closeRealtimeEventConsumer(),
    closeSubmissionPublisher(),
    prisma.$disconnect(),
  ]);
  process.exitCode = 0;
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
