import { SubmissionStatus } from '@prisma/client';

const allowedTransitions: Record<SubmissionStatus, readonly SubmissionStatus[]> = {
  [SubmissionStatus.QUEUED]: [SubmissionStatus.ASSIGNED, SubmissionStatus.CANCELLED, SubmissionStatus.SYSTEM_ERROR],
  [SubmissionStatus.ASSIGNED]: [SubmissionStatus.STARTING, SubmissionStatus.QUEUED, SubmissionStatus.CANCELLED, SubmissionStatus.SYSTEM_ERROR],
  [SubmissionStatus.STARTING]: [SubmissionStatus.COMPILING, SubmissionStatus.RUNNING, SubmissionStatus.CANCELLED, SubmissionStatus.SYSTEM_ERROR],
  [SubmissionStatus.COMPILING]: [SubmissionStatus.RUNNING, SubmissionStatus.COMPILATION_ERROR, SubmissionStatus.TIME_LIMIT_EXCEEDED, SubmissionStatus.MEMORY_LIMIT_EXCEEDED, SubmissionStatus.CANCELLED, SubmissionStatus.SYSTEM_ERROR],
  [SubmissionStatus.RUNNING]: [SubmissionStatus.ACCEPTED, SubmissionStatus.WRONG_ANSWER, SubmissionStatus.TIME_LIMIT_EXCEEDED, SubmissionStatus.MEMORY_LIMIT_EXCEEDED, SubmissionStatus.RUNTIME_ERROR, SubmissionStatus.CANCELLED, SubmissionStatus.SYSTEM_ERROR],
  [SubmissionStatus.ACCEPTED]: [],
  [SubmissionStatus.WRONG_ANSWER]: [],
  [SubmissionStatus.TIME_LIMIT_EXCEEDED]: [],
  [SubmissionStatus.MEMORY_LIMIT_EXCEEDED]: [],
  [SubmissionStatus.COMPILATION_ERROR]: [],
  [SubmissionStatus.RUNTIME_ERROR]: [],
  [SubmissionStatus.SYSTEM_ERROR]: [],
  [SubmissionStatus.CANCELLED]: [],
};

export class InvalidSubmissionTransitionError extends Error {
  constructor(readonly current: SubmissionStatus, readonly next: SubmissionStatus) {
    super(`Submission cannot move from ${current} to ${next}.`);
    this.name = 'InvalidSubmissionTransitionError';
  }
}

export function canTransitionSubmission(current: SubmissionStatus, next: SubmissionStatus): boolean {
  return allowedTransitions[current].includes(next);
}

export function assertSubmissionTransition(current: SubmissionStatus, next: SubmissionStatus): void {
  if (!canTransitionSubmission(current, next)) {
    throw new InvalidSubmissionTransitionError(current, next);
  }
}

export function isTerminalSubmissionStatus(status: SubmissionStatus): boolean {
  return allowedTransitions[status].length === 0;
}
