import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';

export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry, prefix: 'codebox_' });

export const httpRequestsTotal = new Counter({
  name: 'codebox_http_requests_total',
  help: 'Completed HTTP requests handled by the API.',
  labelNames: ['method', 'route', 'status_code'],
  registers: [metricsRegistry],
});

export const httpRequestDurationSeconds = new Histogram({
  name: 'codebox_http_request_duration_seconds',
  help: 'API request duration in seconds.',
  labelNames: ['method', 'route'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [metricsRegistry],
});

export const submissionEnqueuesTotal = new Counter({
  name: 'codebox_submission_enqueues_total',
  help: 'Submissions successfully published to scheduler ingress.',
  labelNames: ['language'],
  registers: [metricsRegistry],
});

export const submissionEnqueueFailuresTotal = new Counter({
  name: 'codebox_submission_enqueue_failures_total',
  help: 'Submission ingress publications that failed.',
  labelNames: ['language'],
  registers: [metricsRegistry],
});

export const schedulerAssignmentsTotal = new Counter({
  name: 'codebox_scheduler_assignments_total',
  help: 'Confirmed scheduler deliveries by language, strategy, and destination.',
  labelNames: ['language', 'strategy', 'destination'],
  registers: [metricsRegistry],
});

export const schedulerQueueDepth = new Histogram({
  name: 'codebox_scheduler_target_queue_depth',
  help: 'Waiting messages in the selected worker group queue when a job is routed.',
  labelNames: ['language', 'strategy'],
  buckets: [0, 1, 2, 5, 10, 25, 50, 100],
  registers: [metricsRegistry],
});

export const apiReady = new Gauge({
  name: 'codebox_api_ready',
  help: 'Whether the API database and scheduler dependencies are ready.',
  registers: [metricsRegistry],
});

export const schedulerReady = new Gauge({
  name: 'codebox_api_scheduler_ready',
  help: 'Whether the API scheduler has active RabbitMQ consumers.',
  registers: [metricsRegistry],
});

export const workerReady = new Gauge({
  name: 'codebox_worker_ready',
  help: 'Whether the worker is connected, consuming, and recording heartbeats.',
  registers: [metricsRegistry],
});

export const workerActiveSubmissions = new Gauge({
  name: 'codebox_worker_active_submissions',
  help: 'Submissions currently executing in this worker process.',
  registers: [metricsRegistry],
});

export const workerJobsProcessedTotal = new Counter({
  name: 'codebox_worker_jobs_processed_total',
  help: 'Worker job deliveries that returned a persisted submission status.',
  labelNames: ['status'],
  registers: [metricsRegistry],
});

export const workerJobRetriesTotal = new Counter({
  name: 'codebox_worker_job_retries_total',
  help: 'Worker job attempts copied to the delayed retry queue.',
  registers: [metricsRegistry],
});

export const workerJobDurationSeconds = new Histogram({
  name: 'codebox_worker_job_duration_seconds',
  help: 'Time spent processing a submission delivery in seconds.',
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
  registers: [metricsRegistry],
});
