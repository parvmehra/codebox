# Observability

Phase 7 adds operational visibility without changing the API/worker architecture. The API and each worker process emit structured JSON logs and expose Prometheus text metrics. Grafana reads Prometheus and provisions the Codebox Operations dashboard.

## Local services

`docker compose up --build` starts the full stack:

- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3000`
- API liveness: `http://localhost:4000/health/live`
- API readiness: `http://localhost:4000/health/ready`
- API metrics: `/metrics` on the internal metrics port `9100` (`METRICS_PORT`); it is not served on the public API port and Compose does not publish it
- Worker health and metrics: `/health/live`, `/health/ready`, and `/metrics` on internal port `9101`

Grafana provisions the Prometheus datasource and dashboard from `observability/grafana/`. The initial dashboard is **Codebox Operations**. Configure `GRAFANA_USER` and `GRAFANA_PASSWORD` in `.env`; the checked-in defaults are for local development. Prometheus retains 15 days of samples in its Compose volume.

## Logs

The server uses Pino and writes one JSON object per log line to stdout. Set `LOG_LEVEL` to `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent`. API access logs include a generated `x-request-id`, HTTP method, path without query parameters, response status, and duration. Request bodies and headers are not logged. Common credential and source fields are redacted before output.

Docker captures stdout, so local logs can be filtered by service, for example:

```bash
docker compose logs -f api worker
```

## Health checks

`/health/live` answers whether the process can serve requests. `/health/ready` answers whether the API can reach PostgreSQL and its RabbitMQ scheduler consumers are active. The worker's readiness endpoint becomes healthy after it has a queue consumer and successfully persists its online heartbeat. Docker Compose uses readiness for the API and worker health checks; Prometheus also tracks each scrape target with the `up` metric.

The legacy API `/health` endpoint remains a simple liveness response for existing clients and the worker E2E script.

## Metrics

Prometheus scrapes the API at `api:9100/metrics` and the worker at `worker:9101/metrics` every 15 seconds. Custom metric labels use HTTP route templates, supported language enums, scheduler strategies, bounded submission statuses, and routing destinations. They do not use user IDs, submission IDs, source code, or raw URLs as labels.

| Metric                                                                     | Process    | Meaning                                                       |
| -------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------- |
| `codebox_http_requests_total`                                              | API        | Completed requests by method, route template, and status code |
| `codebox_http_request_duration_seconds`                                    | API        | Request latency histogram for rate and percentile queries     |
| `codebox_submission_enqueues_total`                                        | API        | Submission jobs published to scheduler ingress                |
| `codebox_submission_enqueue_failures_total`                                | API        | Failed ingress publishes                                      |
| `codebox_scheduler_assignments_total`                                      | API        | Confirmed routes to a worker queue or the delayed wait queue  |
| `codebox_scheduler_target_queue_depth`                                     | API        | Selected worker queue depth at assignment time                |
| `codebox_worker_jobs_processed_total`                                      | Worker     | Deliveries that returned a persisted submission status        |
| `codebox_worker_job_retries_total`                                         | Worker     | Attempts copied to delayed retry                              |
| `codebox_worker_job_duration_seconds`                                      | Worker     | Time spent processing a delivery                              |
| `codebox_worker_active_submissions`                                        | Worker     | Current active execution count                                |
| `codebox_api_ready`, `codebox_api_scheduler_ready`, `codebox_worker_ready` | API/worker | Dependency and process readiness gauges                       |

The dashboard shows API request rate and p95 latency, scheduler destinations, worker outcomes and active submissions, and Prometheus scrape health. Prometheus also collects Node.js process and runtime metrics.

## Limits and operations

The metrics endpoints do not require authentication. Keep ports `4000`, `9090`, and `3000` behind a trusted network or reverse proxy; do not publish them directly to an untrusted network. Grafana's development password must be changed before exposing the service. Logs and metrics are diagnostic signals, not an audit trail; PostgreSQL remains authoritative for submission and execution history.

### Learning notes

- **Problem solved:** operators need to distinguish API request failures, unassigned work, worker load, and scrape failures without inspecting every container manually.
- **Why these tools:** structured stdout logs work with Docker, Prometheus provides pull-based metrics without a cloud service, and Grafana turns those metrics into a readable dashboard.
- **Data flow:** API and workers record bounded counters, histograms, and gauges; Prometheus scrapes each process; Grafana reads Prometheus using the provisioned datasource.
- **Important failure cases:** a failed database or scheduler probe makes API readiness return `503`; a stopped worker makes its Prometheus target report `up = 0`; metrics scraping does not replace durable database records.
- **Interview question — Why keep metrics separate from logs?** Logs explain an individual event, while counters and histograms show how behavior changes over time.
- **Interview question — Why use bounded labels?** User IDs and submission IDs would create a new time series for every request. Route templates, language names, and result enums keep metric cardinality predictable.

## Metric reference and limitations

Every process registers every metric, but only the owning process sets it. A gauge read from the wrong job shows a misleading `0`, so always scope gauges by job (the dashboard does: `{job="worker"}`, `{job="api"}`). The API serves `/metrics` on `METRICS_PORT` (9100, not published); the worker on 9101.

| Metric | Type | Owner | Meaning and limits |
|---|---|---|---|
| `codebox_http_requests_total`, `codebox_http_request_duration_seconds` | counter, histogram | api | Completed requests by method, route template and status. Labels use route templates, never raw URLs or IDs. |
| `codebox_submission_enqueues_total`, `codebox_submission_enqueue_failures_total` | counters | api | Publishes to the scheduler ingress that succeeded or failed, by language. A failed publish marks the submission `SYSTEM_ERROR`. The failure series does not exist until the first failure. |
| `codebox_scheduler_assignments_total` | counter | api | Jobs routed to a worker queue (or the wait queue), by language, strategy, destination. |
| `codebox_scheduler_target_queue_depth` | histogram | api | Depth of the chosen worker queue **at the moment of assignment**. This is a sample per assignment, not a continuous queue-depth gauge. |
| `codebox_submission_queue_wait_seconds` | histogram | worker | Seconds from the last enqueue time to a worker claiming the job. Approximate: recovery re-publishing resets the start time, and retries restart it. |
| `codebox_worker_jobs_processed_total` | counter | worker | Deliveries that ended with a persisted status, by status. This is the submission outcome count (`ACCEPTED`, `WRONG_ANSWER`, ...). |
| `codebox_worker_job_duration_seconds` | histogram | worker | Wall-clock time of one delivery, including compile and all test cases. |
| `codebox_worker_job_retries_total` | counter | worker | Deliveries copied to the delayed retry queue after a transient failure. |
| `codebox_sandbox_failures_total{reason}` | counter | worker | Attempts that failed for infrastructure reasons (`docker_error`, `unexpected`), not because of the submitted code. Absent until the first failure. |
| `codebox_worker_active_submissions` | gauge | worker | Submissions executing in this worker process (limited to 1 by prefetch). |
| `codebox_worker_ready`, `codebox_api_ready`, `codebox_api_scheduler_ready` | gauges | worker / api | 1 when the owning process considers itself ready. `codebox_api_ready` is refreshed when `/health/ready` is called. |

Worker count comes from `up{job="worker"}` (a Prometheus scrape, so it counts reachable processes, not heartbeat-healthy ones). Worker heartbeats are stored in PostgreSQL and exposed through `GET /api/workers/status`, not as a metric. Container execution failures are the `docker_error` reason above; there is no per-language failure breakdown.

There is no user, submission or source-code label anywhere, and no secrets or personal data in any metric.

### Realtime events are not the source of truth

Socket.IO events are only hints. The frontend refetches the submission from the API on every event and on every (re)connect, so duplicate, missed or out-of-order events cannot corrupt what the user sees; the database stays authoritative. The e2e suites verify that a user receives only their own events.
