import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DockerCommandRunner } from './docker-executor.js';

vi.mock('../database/prisma.js', () => ({ prisma: { worker: { findMany: vi.fn() } } }));

const { prisma } = await import('../database/prisma.js');
const { reapOrphanedSandboxes } = await import('./sandbox-reaper.js');

const now = new Date('2026-01-01T00:00:00Z');
const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '', outputLimitExceeded: false });

beforeEach(() => vi.clearAllMocks());

describe('reapOrphanedSandboxes', () => {
  it('removes only sandboxes whose owner stopped heartbeating or is unknown', async () => {
    const calls: string[][] = [];
    const runner: DockerCommandRunner = async (args) => {
      calls.push(args);
      return args[0] === 'ps' ? ok('c-live live\nc-dead dead\nc-unknown ghost\nc-own me\n') : ok();
    };
    vi.mocked(prisma.worker.findMany).mockResolvedValue([
      { id: 'live', lastHeartbeatAt: new Date(now.getTime() - 5_000) },
      { id: 'dead', lastHeartbeatAt: new Date(now.getTime() - 120_000) },
    ] as never);

    const removed = await reapOrphanedSandboxes('me', now, runner);

    expect(removed).toBe(2);
    expect(calls.at(-1)).toEqual(['rm', '--force', 'c-dead', 'c-unknown']);
  });

  it('does nothing when every sandbox belongs to a live worker', async () => {
    const runner = vi.fn<DockerCommandRunner>(async () => ok('c1 live\n'));
    vi.mocked(prisma.worker.findMany).mockResolvedValue([
      { id: 'live', lastHeartbeatAt: new Date(now.getTime() - 1_000) },
    ] as never);

    expect(await reapOrphanedSandboxes('me', now, runner)).toBe(0);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("never touches this worker's own sandboxes", async () => {
    const runner = vi.fn<DockerCommandRunner>(async () => ok('c-own me\n'));
    expect(await reapOrphanedSandboxes('me', now, runner)).toBe(0);
    expect(prisma.worker.findMany).not.toHaveBeenCalled();
  });
});
