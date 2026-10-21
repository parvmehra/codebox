import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  workerDeleteMany: vi.fn(),
  heartbeatDeleteMany: vi.fn(),
  warn: vi.fn(),
}));

vi.doMock('../database/prisma.js', () => ({
  prisma: {
    worker: { deleteMany: mocks.workerDeleteMany },
    workerHeartbeat: { deleteMany: mocks.heartbeatDeleteMany },
  },
}));
vi.doMock('../observability/logger.js', () => ({ logger: { warn: mocks.warn } }));

const { cleanupWorkerHistory, startWorkerHistoryCleanup, WORKER_HISTORY_CLEANUP_INTERVAL_MS } =
  await import('./worker-history-cleanup.js');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.workerDeleteMany.mockResolvedValue({ count: 0 });
  mocks.heartbeatDeleteMany.mockResolvedValue({ count: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('worker history cleanup', () => {
  it('deletes only worker records older than the seven-day retention cutoff', async () => {
    await cleanupWorkerHistory(new Date('2026-10-16T10:00:00.000Z'));

    const cutoff = new Date('2026-10-09T10:00:00.000Z');
    expect(mocks.heartbeatDeleteMany).toHaveBeenCalledWith({
      where: { recordedAt: { lt: cutoff } },
    });
    expect(mocks.workerDeleteMany).toHaveBeenCalledWith({
      where: { lastHeartbeatAt: { lt: cutoff } },
    });
    expect(mocks.heartbeatDeleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.workerDeleteMany.mock.invocationCallOrder[0],
    );
  });

  it('runs at startup and hourly, and stops its timer cleanly', async () => {
    vi.useFakeTimers();
    const stop = startWorkerHistoryCleanup();

    expect(mocks.heartbeatDeleteMany).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(mocks.workerDeleteMany).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(WORKER_HISTORY_CLEANUP_INTERVAL_MS);
    expect(mocks.heartbeatDeleteMany).toHaveBeenCalledTimes(2);
    expect(mocks.workerDeleteMany).toHaveBeenCalledTimes(2);

    await stop();
    await vi.advanceTimersByTimeAsync(WORKER_HISTORY_CLEANUP_INTERVAL_MS);
    expect(mocks.heartbeatDeleteMany).toHaveBeenCalledTimes(2);
  });

  it('logs cleanup failures and keeps the scheduled job available', async () => {
    vi.useFakeTimers();
    mocks.heartbeatDeleteMany.mockRejectedValueOnce(new Error('database unavailable'));
    const stop = startWorkerHistoryCleanup();
    await vi.waitFor(() => expect(mocks.warn).toHaveBeenCalledOnce());

    expect(mocks.warn).toHaveBeenCalledWith(
      { error: expect.any(Error) },
      'Worker history cleanup failed',
    );
    await vi.advanceTimersByTimeAsync(WORKER_HISTORY_CLEANUP_INTERVAL_MS);
    expect(mocks.heartbeatDeleteMany).toHaveBeenCalledTimes(2);
    await stop();
  });
});
