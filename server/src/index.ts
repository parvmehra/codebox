import { app } from './app.js';
import { env } from './config/env.js';
import { prisma } from './database/prisma.js';
import { closeSubmissionPublisher } from './queue/submissions.js';

const server = app.listen(env.PORT, () => console.info({ port: env.PORT }, 'API listening'));
let isShuttingDown = false;

async function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.info({ signal }, 'API shutdown requested');

  server.close(async (error) => {
    if (error) console.error({ error }, 'Failed to close the HTTP server cleanly');
    await Promise.allSettled([closeSubmissionPublisher(), prisma.$disconnect()]);
    process.exitCode = error ? 1 : 0;
  });
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
