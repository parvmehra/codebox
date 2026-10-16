# Architecture

The platform uses a modular monolith API and a separate worker process. PostgreSQL stores durable application and execution data. RabbitMQ transports durable execution jobs and short-lived progress events. Socket.IO delivers authenticated updates to the frontend. Docker creates a short-lived language-specific container for each submission.

```text
React + Vite
    │ REST + Socket.IO
    ▼
Express API + Socket.IO ─────────────► PostgreSQL
    ▲                                  ▲
    │ transient progress events       │ execution and test results
    ├────────────── RabbitMQ ◄──── Worker ───► temporary language container
    │                  durable job ─────►
```

## Responsibilities

- **Frontend:** problem pages, authentication, Monaco editor, submission history, live status and test verdicts, and a worker status page. REST polling remains as a reconnect fallback.
- **API:** authentication, problem access, submission validation, persistence, RabbitMQ publishing and event consumption, and authenticated Socket.IO rooms. It never executes submitted code.
- **PostgreSQL:** source of truth for users, problems, test cases, submissions, executions, and per-test results.
- **RabbitMQ:** durable asynchronous job delivery plus a non-durable topic exchange for lifecycle, test-progress, and worker-heartbeat events.
- **Worker:** validates and claims a queued submission, selects a language profile, compiles or syntax-checks and runs the program in Docker, persists the result, and emits progress events.
- **Execution container:** receives only the submitted source file and test input. It has no network or host path mounts and does not receive the Docker socket.

## Data flow

1. An authenticated user sends source for one of the four supported languages to `POST /api/submissions`.
2. The API validates the problem and source size, writes a `QUEUED` submission, emits a queued event, then publishes a persistent RabbitMQ job and waits for confirmation.
3. A worker claims the queued row with a conditional database update, advances it through the state machine, and publishes lifecycle events to the transient exchange.
4. The worker creates an `Execution` record, runs that profile's compile or syntax-check command, and evaluates test cases in order.
5. Each test verdict is persisted before its progress event; test input and expected output are never included in events.
6. The API's temporary event queue forwards submission events only to the authenticated owner's Socket.IO room. The final result is persisted before the worker acknowledges the job.
7. The frontend refreshes submission data on Socket.IO events and uses REST polling if the socket is unavailable. A worker heartbeat endpoint powers the basic status page.

## Learning notes

- **Problem solved:** compilation and test evaluation can take longer than a normal HTTP request and must not block the API process.
- **Why these tools:** PostgreSQL provides durable state, RabbitMQ provides asynchronous delivery, and a separate worker keeps execution concerns out of the API. Each choice is commonly used and can be explained without cloud-specific services.
- **Why events also use RabbitMQ:** the worker can report progress to the API without exposing broker access to the browser or adding Redis. Events are transient; PostgreSQL and the REST API remain authoritative.
- **Important failure cases:** the broker can be unavailable, a worker can exit mid-job, or Docker can fail to create a container. Current limitations and recovery behavior are in [failure handling](failure-handling.md).
- **Interview question — Why keep the API as a modular monolith?** The domain is still small, so one API deployable keeps code and transactions simple; the worker is separate because execution has different runtime and security needs.
- **Interview question — Why is PostgreSQL authoritative?** A broker message is a delivery signal, while the database record is the durable submission and result history.
