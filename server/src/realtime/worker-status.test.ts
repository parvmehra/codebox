import { WorkerStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  workerUpsert: vi.fn(),
  workerDeleteMany: vi.fn(),
  heartbeatCreate: vi.fn(),
  heartbeatDeleteMany: vi.fn(),
  workerFindMany: vi.fn(),
}));

vi.doMock('../database/prisma.js', () => ({
  prisma: {
    worker: {
      upsert: mocks.workerUpsert,
      deleteMany: mocks.workerDeleteMany,
      findMany: mocks.workerFindMany,
    },
    workerHeartbeat: {
      create: mocks.heartbeatCreate,
      deleteMany: mocks.heartbeatDeleteMany,
    },
  },
}));

const { getWorkerStatus, persistWorkerHeartbeat } = await import('./worker-status.js');

const workerId = 'a25145ab-21aa-4d20-9e08-3a2b4d59110f';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.workerUpsert.mockResolvedValue({});
  mocks.workerDeleteMany.mockResolvedValue({ count: 0 });
  mocks.heartbeatCreate.mockResolvedValue({});
  mocks.heartbeatDeleteMany.mockResolvedValue({ count: 0 });
  mocks.workerFindMany.mockResolvedValue([]);
});

describe('persisted worker status', () => {
  it('persists heartbeat history without running retention cleanup per heartbeat', async () => {
    const receivedAt = new Date('2026-10-16T10:00:00.000Z');
    await persistWorkerHeartbeat(workerId, WorkerStatus.ONLINE, 1, receivedAt, []);

    expect(mocks.workerUpsert).toHaveBeenCalledWith({
      where: { id: workerId },
      create: {
        id: workerId,
        status: WorkerStatus.ONLINE,
        activeJobs: 1,
        capabilities: [],
        lastHeartbeatAt: receivedAt,
      },
      update: {
        status: WorkerStatus.ONLINE,
        activeJobs: 1,
        capabilities: [],
        lastHeartbeatAt: receivedAt,
      },
    });
    expect(mocks.heartbeatCreate).toHaveBeenCalledWith({
      data: {
        workerId,
        status: WorkerStatus.ONLINE,
        activeJobs: 1,
        capabilities: [],
        recordedAt: receivedAt,
      },
    });
    expect(mocks.heartbeatDeleteMany).not.toHaveBeenCalled();
    expect(mocks.workerDeleteMany).not.toHaveBeenCalled();
  });

  it('reports only fresh online workers and uses persisted heartbeat time', async () => {
    mocks.workerFindMany.mockResolvedValue([
      {
        id: workerId,
        status: WorkerStatus.ONLINE,
        activeJobs: 2,
        lastHeartbeatAt: new Date('2026-10-16T10:00:00.000Z'),
      },
      {
        id: '48a6a0a4-828e-4ea0-a9ec-60509f663ca5',
        status: WorkerStatus.OFFLINE,
        activeJobs: 0,
        lastHeartbeatAt: new Date('2026-10-16T10:00:01.000Z'),
      },
      {
        id: 'a2cfc83e-d5b6-4359-8783-dca879f3c215',
        status: WorkerStatus.ONLINE,
        activeJobs: 8,
        lastHeartbeatAt: new Date('2026-10-16T09:58:00.000Z'),
      },
    ]);

    await expect(getWorkerStatus(new Date('2026-10-16T10:00:02.000Z'))).resolves.toEqual({
      status: 'online',
      workerCount: 1,
      activeJobs: 2,
      lastHeartbeatAt: '2026-10-16T10:00:01.000Z',
    });
    expect(mocks.workerFindMany).toHaveBeenCalledWith({
      orderBy: { lastHeartbeatAt: 'desc' },
      select: { id: true, status: true, activeJobs: true, lastHeartbeatAt: true },
    });
  });

  it('reports offline when every persisted heartbeat is stale', async () => {
    mocks.workerFindMany.mockResolvedValue([
      {
        id: workerId,
        status: WorkerStatus.ONLINE,
        activeJobs: 1,
        lastHeartbeatAt: new Date('2026-10-16T09:58:00.000Z'),
      },
    ]);
    await expect(getWorkerStatus(new Date('2026-10-16T10:00:00.000Z'))).resolves.toMatchObject({
      status: 'offline',
      workerCount: 0,
      activeJobs: 0,
      lastHeartbeatAt: '2026-10-16T09:58:00.000Z',
    });
  });
});
