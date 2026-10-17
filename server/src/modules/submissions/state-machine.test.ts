import { describe, expect, it } from 'vitest';
import { SubmissionStatus as Status } from '@prisma/client';
import {
  assertSubmissionTransition,
  canTransitionSubmission,
  InvalidSubmissionTransitionError,
  isTerminalSubmissionStatus,
} from './state-machine.js';

describe('submission state machine', () => {
  it.each([
    [Status.QUEUED, Status.ASSIGNED],
    [Status.ASSIGNED, Status.STARTING],
    [Status.ASSIGNED, Status.QUEUED],
    [Status.STARTING, Status.COMPILING],
    [Status.STARTING, Status.RUNNING],
    [Status.STARTING, Status.QUEUED],
    [Status.COMPILING, Status.RUNNING],
    [Status.COMPILING, Status.QUEUED],
    [Status.COMPILING, Status.COMPILATION_ERROR],
    [Status.RUNNING, Status.ACCEPTED],
    [Status.RUNNING, Status.WRONG_ANSWER],
    [Status.RUNNING, Status.RUNTIME_ERROR],
    [Status.RUNNING, Status.TIME_LIMIT_EXCEEDED],
    [Status.RUNNING, Status.MEMORY_LIMIT_EXCEEDED],
    [Status.RUNNING, Status.QUEUED],
    [Status.QUEUED, Status.CANCELLED],
  ])('allows %s -> %s', (current, next) => {
    expect(canTransitionSubmission(current, next)).toBe(true);
    expect(() => assertSubmissionTransition(current, next)).not.toThrow();
  });

  it.each([
    [Status.QUEUED, Status.RUNNING],
    [Status.ASSIGNED, Status.ACCEPTED],
    [Status.COMPILING, Status.ACCEPTED],
    [Status.ACCEPTED, Status.RUNNING],
    [Status.WRONG_ANSWER, Status.QUEUED],
    [Status.CANCELLED, Status.ASSIGNED],
    [Status.SYSTEM_ERROR, Status.QUEUED],
  ])('rejects %s -> %s', (current, next) => {
    expect(canTransitionSubmission(current, next)).toBe(false);
    expect(() => assertSubmissionTransition(current, next)).toThrow(
      InvalidSubmissionTransitionError,
    );
  });

  it('marks only completed outcomes as terminal', () => {
    expect(isTerminalSubmissionStatus(Status.QUEUED)).toBe(false);
    expect(isTerminalSubmissionStatus(Status.RUNNING)).toBe(false);
    expect(isTerminalSubmissionStatus(Status.ACCEPTED)).toBe(true);
    expect(isTerminalSubmissionStatus(Status.SYSTEM_ERROR)).toBe(true);
  });
});
