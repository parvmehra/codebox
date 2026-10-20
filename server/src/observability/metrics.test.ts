import { describe, expect, it } from 'vitest';
import {
  httpRequestDurationSeconds,
  httpRequestsTotal,
  metricsRegistry,
  schedulerAssignmentsTotal,
  submissionEnqueuesTotal,
  workerJobsProcessedTotal,
} from './metrics.js';

describe('Prometheus metrics', () => {
  it('registers bounded API, scheduler, and worker metrics', async () => {
    httpRequestsTotal.inc({ method: 'GET', route: '/health/live', status_code: '200' });
    httpRequestDurationSeconds.observe({ method: 'GET', route: '/health/live' }, 0.01);
    submissionEnqueuesTotal.inc({ language: 'JAVA' });
    schedulerAssignmentsTotal.inc({ language: 'JAVA', strategy: 'FIFO', destination: 'worker' });
    workerJobsProcessedTotal.inc({ status: 'ACCEPTED' });

    const text = await metricsRegistry.metrics();
    expect(text).toContain(
      'codebox_http_requests_total{method="GET",route="/health/live",status_code="200"}',
    );
    expect(text).toContain('codebox_http_request_duration_seconds_bucket');
    expect(text).toContain('codebox_submission_enqueues_total{language="JAVA"}');
    expect(text).toContain('codebox_scheduler_assignments_total');
    expect(text).toContain('codebox_worker_jobs_processed_total{status="ACCEPTED"}');
  });
});
