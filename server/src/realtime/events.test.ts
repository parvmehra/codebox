import { SubmissionStatus, TestResultStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { realtimeEventSchema, realtimeRoutingKey } from './events.js';

describe('real-time event contract', () => {
  it('uses one route per event and strips private fields before delivery', () => {
    const event = realtimeEventSchema.parse({
      type: 'submission:test-progress',
      submissionId: 'c3070e38-c557-43d5-a59b-e8af46675370',
      userId: 'a25145ab-21aa-4d20-9e08-3a2b4d59110f',
      status: SubmissionStatus.RUNNING,
      updatedAt: '2026-10-16T10:00:00.000Z',
      testIndex: 1,
      resultStatus: TestResultStatus.PASSED,
      executionTimeMs: 12,
      errorMessage: null,
      input: 'private hidden test input',
      expectedOut: 'private expected output',
      sourceCode: 'private source',
    });

    expect(realtimeRoutingKey(event)).toBe('submission.test-progress');
    expect(event).not.toHaveProperty('input');
    expect(event).not.toHaveProperty('expectedOut');
    expect(event).not.toHaveProperty('sourceCode');
  });
});
