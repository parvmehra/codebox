import { SubmissionLanguage } from '@prisma/client';
import { MAX_SUBMISSION_PRIORITY, workerQueueName } from './topology.js';

export type SchedulerStrategy = 'FIFO' | 'PRIORITY';

export type SchedulerWorker = {
  workerId: string;
  capabilities: readonly string[];
  activeJobs: number;
};

export type WorkerQueueDepth = {
  messageCount: number;
  consumerCount: number;
};

export type WorkerQueueAssignment = {
  queueName: string;
  workerCount: number;
  queuedJobs: number;
  averageActiveJobs: number;
  load: number;
};

export function parseWorkerCapabilities(value: string): SubmissionLanguage[] {
  const supported = new Set<string>(Object.values(SubmissionLanguage));
  const capabilities = [
    ...new Set(value.split(',').map((language) => language.trim().toUpperCase())),
  ]
    .filter(Boolean)
    .sort();
  const unsupported = capabilities.filter((language) => !supported.has(language));

  if (unsupported.length > 0) {
    throw new Error(`Unsupported worker language(s): ${unsupported.join(', ')}.`);
  }
  if (capabilities.length === 0) {
    throw new Error('WORKER_LANGUAGES must list at least one supported language.');
  }

  return capabilities as SubmissionLanguage[];
}

export function chooseWorkerQueue(
  language: string,
  workers: readonly SchedulerWorker[],
  queueDepths: ReadonlyMap<string, WorkerQueueDepth>,
): WorkerQueueAssignment | undefined {
  const groups = new Map<string, { workers: SchedulerWorker[]; depth: WorkerQueueDepth }>();

  for (const worker of workers) {
    if (!worker.capabilities.includes(language)) continue;
    const queueName = workerQueueName(worker.capabilities);
    const depth = queueDepths.get(queueName);
    if (!depth || depth.consumerCount < 1) continue;

    const group = groups.get(queueName);
    if (group) {
      group.workers.push(worker);
    } else {
      groups.set(queueName, { workers: [worker], depth });
    }
  }

  return [...groups.entries()]
    .map(([queueName, { workers: groupWorkers, depth }]) => {
      const averageActiveJobs =
        groupWorkers.reduce((total, worker) => total + Math.max(0, worker.activeJobs), 0) /
        groupWorkers.length;
      return {
        queueName,
        workerCount: groupWorkers.length,
        queuedJobs: depth.messageCount,
        averageActiveJobs,
        load: depth.messageCount + averageActiveJobs,
      };
    })
    .sort(
      (left, right) => left.load - right.load || left.queueName.localeCompare(right.queueName),
    )[0];
}

export function resolveMessagePriority(priority: number, strategy: SchedulerStrategy): number {
  if (strategy === 'FIFO') return 0;
  return Math.max(0, Math.min(MAX_SUBMISSION_PRIORITY, Math.trunc(priority)));
}
