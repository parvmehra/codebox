import { WorkerStatus } from '@prisma/client';
import { prisma } from '../database/prisma.js';

const HEARTBEAT_TTL_MS = 45_000;
const HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export async function persistWorkerHeartbeat(
  workerId: string,
  status: WorkerStatus,
  activeJobs: number,
  receivedAt = new Date(),
): Promise<void> {
  await prisma.worker.upsert({
    where: { id: workerId },
    create: { id: workerId, status, activeJobs, lastHeartbeatAt: receivedAt },
    update: { status, activeJobs, lastHeartbeatAt: receivedAt },
  });

  await prisma.workerHeartbeat.create({
    data: { workerId, status, activeJobs, recordedAt: receivedAt },
  });
  const historyCutoff = new Date(receivedAt.getTime() - HISTORY_RETENTION_MS);
  await prisma.workerHeartbeat.deleteMany({ where: { recordedAt: { lt: historyCutoff } } });
  await prisma.worker.deleteMany({ where: { lastHeartbeatAt: { lt: historyCutoff } } });
}

export async function getWorkerStatus(now = new Date()) {
  const workers = await prisma.worker.findMany({
    orderBy: { lastHeartbeatAt: 'desc' },
    select: { id: true, status: true, activeJobs: true, lastHeartbeatAt: true },
  });
  const online = workers.filter(
    ({ status, lastHeartbeatAt }) =>
      status === WorkerStatus.ONLINE &&
      now.getTime() - lastHeartbeatAt.getTime() <= HEARTBEAT_TTL_MS,
  );

  const mostRecent = workers.reduce<Date | undefined>(
    (latest, worker) =>
      !latest || worker.lastHeartbeatAt > latest ? worker.lastHeartbeatAt : latest,
    undefined,
  );

  return {
    status: online.length > 0 ? ('online' as const) : ('offline' as const),
    workerCount: online.length,
    activeJobs: online.reduce((total, { activeJobs }) => total + activeJobs, 0),
    lastHeartbeatAt: mostRecent?.toISOString() ?? null,
  };
}
