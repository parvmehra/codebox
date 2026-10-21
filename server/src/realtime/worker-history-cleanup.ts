import { prisma } from '../database/prisma.js';
import { logger } from '../observability/logger.js';

export const WORKER_HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const WORKER_HISTORY_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;

export async function cleanupWorkerHistory(now = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - WORKER_HISTORY_RETENTION_MS);
  await prisma.workerHeartbeat.deleteMany({ where: { recordedAt: { lt: cutoff } } });
  await prisma.worker.deleteMany({ where: { lastHeartbeatAt: { lt: cutoff } } });
}

export function startWorkerHistoryCleanup(): () => Promise<void> {
  let stopped = false;
  let activeCleanup: Promise<void> | undefined;

  const runCleanup = () => {
    if (stopped || activeCleanup) return activeCleanup;
    activeCleanup = cleanupWorkerHistory()
      .catch((error: unknown) => {
        logger.warn({ error }, 'Worker history cleanup failed');
      })
      .finally(() => {
        activeCleanup = undefined;
      });
    return activeCleanup;
  };

  void runCleanup();
  const timer = setInterval(() => void runCleanup(), WORKER_HISTORY_CLEANUP_INTERVAL_MS);
  timer.unref();

  return async () => {
    stopped = true;
    clearInterval(timer);
    await activeCleanup;
  };
}
