import { SubmissionStatus, TestResultStatus } from '@prisma/client';
import { z } from 'zod';

const submissionIdentity = {
  submissionId: z.string().uuid(),
  userId: z.string().uuid(),
  status: z.nativeEnum(SubmissionStatus),
  updatedAt: z.string().datetime(),
};

const submissionStateEvent = z.object({
  type: z.enum([
    'submission:queued',
    'submission:assigned',
    'submission:starting',
    'submission:compiling',
    'submission:running',
    'submission:completed',
    'submission:failed',
    'submission:cancelled',
  ]),
  ...submissionIdentity,
  errorMessage: z.string().max(4_000).optional(),
});

const submissionTestProgressEvent = z.object({
  type: z.literal('submission:test-progress'),
  ...submissionIdentity,
  testIndex: z.number().int().positive(),
  resultStatus: z.nativeEnum(TestResultStatus),
  executionTimeMs: z.number().int().nonnegative(),
  errorMessage: z.string().max(4_000).nullable(),
});

const workerHeartbeatEvent = z.object({
  type: z.literal('worker:heartbeat'),
  workerId: z.string().uuid(),
  status: z.enum(['online', 'offline']),
  activeJobs: z.number().int().nonnegative(),
  sentAt: z.string().datetime(),
});

export const realtimeEventSchema = z.discriminatedUnion('type', [
  submissionStateEvent,
  submissionTestProgressEvent,
  workerHeartbeatEvent,
]);

export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;
export type SubmissionRealtimeEvent = Exclude<RealtimeEvent, { type: 'worker:heartbeat' }>;
export type SubmissionStateEvent = z.infer<typeof submissionStateEvent>;

export const SUBMISSION_EVENTS_EXCHANGE = 'submissions.events';

export function realtimeRoutingKey(event: RealtimeEvent): string {
  return event.type.replace(':', '.');
}
