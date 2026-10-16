import type { RealtimeEvent } from './events.js';

const HEARTBEAT_TTL_MS = 45_000;
type WorkerHeartbeat = Extract<RealtimeEvent, { type: 'worker:heartbeat' }>;

const workers = new Map<string, { heartbeat: WorkerHeartbeat; receivedAt: number }>();

export function recordWorkerHeartbeat(heartbeat: WorkerHeartbeat, receivedAt = Date.now()): void {
  for (const [workerId, record] of workers) {
    if (receivedAt - record.receivedAt > HEARTBEAT_TTL_MS * 4) workers.delete(workerId);
  }
  workers.set(heartbeat.workerId, { heartbeat, receivedAt });
}

export function getWorkerStatus(now = Date.now()) {
  const records = [...workers.values()];
  const online = records.filter(
    ({ heartbeat, receivedAt }) =>
      heartbeat.status === 'online' && now - receivedAt <= HEARTBEAT_TTL_MS,
  );
  const mostRecent = records.reduce<{ sentAt: string; receivedAt: number } | undefined>(
    (latest, record) =>
      !latest || record.receivedAt > latest.receivedAt
        ? { sentAt: record.heartbeat.sentAt, receivedAt: record.receivedAt }
        : latest,
    undefined,
  );

  return {
    status: online.length > 0 ? ('online' as const) : ('offline' as const),
    workerCount: online.length,
    activeJobs: online.reduce((total, { heartbeat }) => total + heartbeat.activeJobs, 0),
    lastHeartbeatAt: mostRecent?.sentAt ?? null,
  };
}

export function clearWorkerStatus(): void {
  workers.clear();
}
