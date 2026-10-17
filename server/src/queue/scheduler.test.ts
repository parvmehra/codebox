import { describe, expect, it } from 'vitest';
import { SubmissionLanguage } from '@prisma/client';
import {
  chooseWorkerQueue,
  parseWorkerCapabilities,
  resolveMessagePriority,
  type SchedulerWorker,
} from './scheduler.js';
import { workerQueueName } from './topology.js';

describe('submission scheduler', () => {
  it('parses and normalizes configured worker capabilities', () => {
    expect(parseWorkerCapabilities(' python, JAVA,python ')).toEqual([
      SubmissionLanguage.JAVA,
      SubmissionLanguage.PYTHON,
    ]);
    expect(() => parseWorkerCapabilities('RUST')).toThrow('Unsupported worker language');
    expect(() => parseWorkerCapabilities(' , ')).toThrow('at least one supported language');
  });

  it('routes only to capability groups that support the job language', () => {
    const javaOnly = [SubmissionLanguage.JAVA];
    const pythonOnly = [SubmissionLanguage.PYTHON];
    const workers: SchedulerWorker[] = [
      { workerId: 'java-worker', capabilities: javaOnly, activeJobs: 0 },
      { workerId: 'python-worker', capabilities: pythonOnly, activeJobs: 0 },
    ];
    const queueDepths = new Map([
      [workerQueueName(javaOnly), { messageCount: 0, consumerCount: 1 }],
      [workerQueueName(pythonOnly), { messageCount: 0, consumerCount: 1 }],
    ]);

    expect(chooseWorkerQueue(SubmissionLanguage.JAVA, workers, queueDepths)?.queueName).toBe(
      workerQueueName(javaOnly),
    );
    expect(chooseWorkerQueue(SubmissionLanguage.CPP, workers, queueDepths)).toBeUndefined();
  });

  it('skips capability groups with no active queue consumer', () => {
    const capabilities = [SubmissionLanguage.JAVA];
    const workers: SchedulerWorker[] = [
      { workerId: 'offline-queue-worker', capabilities, activeJobs: 0 },
    ];
    const queueDepths = new Map([
      [workerQueueName(capabilities), { messageCount: 0, consumerCount: 0 }],
    ]);

    expect(chooseWorkerQueue(SubmissionLanguage.JAVA, workers, queueDepths)).toBeUndefined();
  });

  it('selects the eligible capability group with the lowest queued and active load', () => {
    const allLanguages = Object.values(SubmissionLanguage);
    const javaOnly = [SubmissionLanguage.JAVA];
    const workers: SchedulerWorker[] = [
      { workerId: 'busy-flexible-worker', capabilities: allLanguages, activeJobs: 1 },
      { workerId: 'idle-java-worker', capabilities: javaOnly, activeJobs: 0 },
    ];
    const queueDepths = new Map([
      [workerQueueName(allLanguages), { messageCount: 2, consumerCount: 1 }],
      [workerQueueName(javaOnly), { messageCount: 0, consumerCount: 1 }],
    ]);

    expect(chooseWorkerQueue(SubmissionLanguage.JAVA, workers, queueDepths)).toMatchObject({
      queueName: workerQueueName(javaOnly),
      queuedJobs: 0,
      load: 0,
    });
  });

  it('accounts for queue depth and worker utilization in its load score', () => {
    const capabilities = [SubmissionLanguage.JAVA];
    const queueName = workerQueueName(capabilities);
    const workers: SchedulerWorker[] = [
      { workerId: 'worker-a', capabilities, activeJobs: 2 },
      { workerId: 'worker-b', capabilities, activeJobs: 0 },
    ];
    const assignment = chooseWorkerQueue(
      SubmissionLanguage.JAVA,
      workers,
      new Map([[queueName, { messageCount: 3, consumerCount: 2 }]]),
    );

    expect(assignment).toMatchObject({
      queueName,
      workerCount: 2,
      queuedJobs: 3,
      averageActiveJobs: 1,
      load: 4,
    });
  });

  it('uses FIFO by default and honors bounded priority when configured', () => {
    expect(resolveMessagePriority(8, 'FIFO')).toBe(0);
    expect(resolveMessagePriority(8, 'PRIORITY')).toBe(8);
    expect(resolveMessagePriority(18, 'PRIORITY')).toBe(10);
  });
});
