# Architecture

The platform uses a modular monolith API and a separate worker process. PostgreSQL stores durable application and execution data. RabbitMQ transports execution jobs. Docker creates a short-lived language-specific container for each submission.

```text
React + Vite
    │ REST
    ▼
Express API ───────► PostgreSQL
    │                 ▲
    │ durable job     │ execution and test results
    ▼                 │
RabbitMQ ───────► Worker ────────────► temporary language container
```

## Responsibilities

- **Frontend:** problem pages, authentication, Monaco editor, submission history, and polling for status and test verdicts.
- **API:** authentication, problem access, submission validation, persistence, and RabbitMQ publishing. It never executes submitted code.
- **PostgreSQL:** source of truth for users, problems, test cases, submissions, executions, and per-test results.
- **RabbitMQ:** durable asynchronous delivery from the API to workers.
- **Worker:** validates and claims a queued submission, selects a language profile, compiles or syntax-checks and runs the program in Docker, and persists the result.
- **Execution container:** receives only the submitted source file and test input. It has no network or host path mounts and does not receive the Docker socket.

## Data flow

1. An authenticated user sends source for one of the four supported languages to `POST /api/submissions`.
2. The API validates the problem and source size, writes a `QUEUED` submission, then publishes a persistent RabbitMQ message and waits for publisher confirmation.
3. A worker claims the queued row with a conditional database update and advances it through the state machine.
4. The worker creates an `Execution` record, runs that profile's compile or syntax-check command, and evaluates test cases in order.
5. Each test verdict is stored without persisting its input or expected output in the result row.
6. The worker stores the final status and acknowledges the message.
7. The frontend polls the submission endpoint until it reaches a terminal state.

## Learning notes

- **Problem solved:** compilation and test evaluation can take longer than a normal HTTP request and must not block the API process.
- **Why these tools:** PostgreSQL provides durable state, RabbitMQ provides asynchronous delivery, and a separate worker keeps execution concerns out of the API. Each choice is commonly used and can be explained without cloud-specific services.
- **Important failure cases:** the broker can be unavailable, a worker can exit mid-job, or Docker can fail to create a container. Current limitations and recovery behavior are in [failure handling](failure-handling.md).
- **Interview question — Why keep the API as a modular monolith?** The domain is still small, so one API deployable keeps code and transactions simple; the worker is separate because execution has different runtime and security needs.
- **Interview question — Why is PostgreSQL authoritative?** A broker message is a delivery signal, while the database record is the durable submission and result history.
