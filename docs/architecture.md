# Architecture

The platform uses a modular monolith API and a separate worker process. PostgreSQL stores durable application and execution data. RabbitMQ transports durable execution jobs and short-lived progress events. Socket.IO delivers authenticated updates to the frontend. Docker creates a short-lived language-specific container for each submission.

```text
React + Vite
    │ REST + Socket.IO
    ▼
Express API + Socket.IO ─────────────► PostgreSQL
    │                                  ▲
    │ confirmed submission             │ execution and test results
    ▼                                  │
RabbitMQ ingress ──► API scheduler ──► capability queue ──► Worker ──► temporary container
    ▲                       │                                    │
    └──── delayed retry ────┘          transient events ─────────┘

Prometheus ──scrapes──► API and worker metrics ◄── Grafana dashboard
```

## Responsibilities

- **Frontend:** problem and contest pages, authentication, Monaco editor, submission history, live status and test verdicts, contest standings, and a worker status page. REST polling remains as a reconnect fallback.
- **API:** authentication, problem and contest access, submission validation, persistence, a small RabbitMQ scheduler, event consumption, and authenticated Socket.IO rooms. It never executes submitted code.
- **PostgreSQL:** source of truth for users, problems, test cases, contests, contest membership, submissions, executions, per-test results, worker snapshots, and heartbeat history.
- **RabbitMQ:** durable scheduler ingress, durable priority queues for matching worker capability groups, delayed bounded retries, a scheduler wait queue, a dead-letter queue, and a non-durable exchange for lifecycle and worker-control events.
- **Scheduler:** matches a submission language to live worker capability groups and selects the group with the lowest queued-plus-active load. The configured strategy uses FIFO by default or RabbitMQ priorities when enabled.
- **Worker:** advertises its language capabilities, consumes only its matching group queue, claims a queued submission, selects a language profile, runs the program in Docker, persists the result, and emits progress events.
- **Execution container:** receives only the submitted source file and test input. It has no network or host path mounts and does not receive the Docker socket.
- **Observability:** Pino emits structured JSON logs. Prometheus scrapes bounded API and worker metrics, and Grafana provisions an operations dashboard from checked-in configuration.

## Data flow

1. An authenticated user sends source for one of the four supported languages to `POST /api/submissions`.
2. The API validates the problem and source size, writes a `QUEUED` submission, emits a queued event, then publishes a persistent job to scheduler ingress and waits for confirmation.
3. The API scheduler finds fresh workers that support the language, reads each capability queue's depth, and forwards the job to the least-loaded eligible queue. With no eligible consumer, it parks the job briefly and checks again.
4. A matching worker claims the queued row with a conditional database update, advances it through the state machine, and publishes lifecycle events to the transient exchange.
5. The worker creates an `Execution` record, runs that profile's compile or syntax-check command, and evaluates test cases in order.
6. Each test verdict is persisted before its progress event; test input and expected output are never included in events.
7. The API's temporary event queue forwards submission events only to the authenticated owner's Socket.IO room. The final result is persisted before the worker acknowledges the job.
8. The frontend refreshes submission data on Socket.IO events and uses REST polling if the socket is unavailable. Persisted worker heartbeats power the status page, and the API recovers submissions whose leases expire.
9. Prometheus scrapes the API and worker metrics endpoints; Grafana queries Prometheus for request, scheduler, worker, and scrape health panels.
10. An admin groups published problems into a contest. Participants join, submit through the same worker pipeline during the event window, and read standings derived from accepted contest submissions.

## Learning notes

- **Problem solved:** compilation and test evaluation can take longer than a normal HTTP request and must not block the API process.
- **Why these tools:** PostgreSQL provides durable state, RabbitMQ provides asynchronous delivery, and a separate worker keeps execution concerns out of the API. Each choice is commonly used and can be explained without cloud-specific services.
- **Why events also use RabbitMQ:** the worker can report progress to the API without exposing broker access to the browser or adding Redis. Events are transient; PostgreSQL and the REST API remain authoritative.
- **Important failure cases:** the broker can be unavailable, a worker can exit mid-job, or Docker can fail to create a container. Current limitations and recovery behavior are in [failure handling](failure-handling.md).
- **Interview question — Why keep the API as a modular monolith?** The domain is still small, so one API deployable keeps code and transactions simple; the worker is separate because execution has different runtime and security needs.
- **Interview question — Why is PostgreSQL authoritative?** A broker message is a delivery signal, while the database record is the durable submission and result history.
