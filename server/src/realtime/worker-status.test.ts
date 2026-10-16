import { beforeEach, describe, expect, it } from 'vitest';
import { clearWorkerStatus, getWorkerStatus, recordWorkerHeartbeat } from './worker-status.js';

const workerId = 'a25145ab-21aa-4d20-9e08-3a2b4d59110f';

beforeEach(() => clearWorkerStatus());

describe('worker status', () => {
  it('reports offline until a fresh heartbeat arrives', () => {
    expect(getWorkerStatus()).toEqual({
      status: 'offline',
      workerCount: 0,
      activeJobs: 0,
      lastHeartbeatAt: null,
    });
  });

  it('aggregates active workers and marks stale or stopped workers offline', () => {
    recordWorkerHeartbeat(
      {
        type: 'worker:heartbeat',
        workerId,
        status: 'online',
        activeJobs: 1,
        sentAt: '2026-10-16T10:00:00.000Z',
      },
      1_000,
    );
    expect(getWorkerStatus(45_999)).toMatchObject({
      status: 'online',
      workerCount: 1,
      activeJobs: 1,
    });
    expect(getWorkerStatus(46_001)).toMatchObject({
      status: 'offline',
      workerCount: 0,
      activeJobs: 0,
    });

    recordWorkerHeartbeat(
      {
        type: 'worker:heartbeat',
        workerId,
        status: 'offline',
        activeJobs: 0,
        sentAt: '2026-10-16T10:00:46.000Z',
      },
      46_000,
    );
    expect(getWorkerStatus(46_001)).toMatchObject({
      status: 'offline',
      workerCount: 0,
      activeJobs: 0,
      lastHeartbeatAt: '2026-10-16T10:00:46.000Z',
    });
  });
});
