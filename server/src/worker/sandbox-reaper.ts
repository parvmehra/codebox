import { prisma } from '../database/prisma.js';
import { logger } from '../observability/logger.js';
import { HEARTBEAT_TTL_MS } from '../realtime/worker-status.js';
import { createDockerCommandRunner, type DockerCommandRunner } from './docker-executor.js';

const log = logger.child({ component: 'sandbox-reaper' });
export const SANDBOX_WORKER_LABEL = 'codebox.worker';
export const SANDBOX_REAP_INTERVAL_MS = 30_000;

// A worker killed with SIGKILL cannot remove its sandbox. Containers are labelled with the owning
// worker id, so any sandbox whose owner has stopped sending heartbeats is safe to remove.
export async function reapOrphanedSandboxes(
  ownWorkerId: string,
  now = new Date(),
  runCommand: DockerCommandRunner = createDockerCommandRunner(),
): Promise<number> {
  const listing = await runCommand(
    [
      'ps',
      '-a',
      '--filter',
      `label=${SANDBOX_WORKER_LABEL}`,
      '--format',
      `{{.ID}} {{.Label "${SANDBOX_WORKER_LABEL}"}}`,
    ],
    { timeoutMs: 15_000 },
  );
  if (listing.exitCode !== 0) return 0;

  const sandboxes = listing.stdout
    .split('\n')
    .map((line) => line.trim().split(' '))
    .filter((parts): parts is [string, string] => parts.length === 2 && parts[0] !== '')
    .filter(([, owner]) => owner !== ownWorkerId);
  if (sandboxes.length === 0) return 0;

  const owners = await prisma.worker.findMany({
    where: { id: { in: [...new Set(sandboxes.map(([, owner]) => owner))] } },
    select: { id: true, lastHeartbeatAt: true },
  });
  const alive = new Set(
    owners
      .filter(
        ({ lastHeartbeatAt }) => now.getTime() - lastHeartbeatAt.getTime() <= HEARTBEAT_TTL_MS,
      )
      .map(({ id }) => id),
  );

  const orphans = sandboxes.filter(([, owner]) => !alive.has(owner)).map(([id]) => id);
  if (orphans.length === 0) return 0;

  const removal = await runCommand(['rm', '--force', ...orphans], { timeoutMs: 30_000 });
  if (removal.exitCode !== 0) {
    log.error({ error: removal.stderr }, 'Could not remove orphaned sandbox containers');
    return 0;
  }
  log.warn({ count: orphans.length }, 'Removed sandbox containers left by stopped workers');
  return orphans.length;
}
