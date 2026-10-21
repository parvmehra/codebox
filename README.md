# Distributed Code Execution & Evaluation Platform

The project has a React client with a Monaco code editor, a modular Express API, PostgreSQL with Prisma, JWT authentication, problem browsing, a queue-depth-aware scheduler, and language-aware workers. Authenticated users can enqueue Java 21, Python 3.12, C++23, and Node.js 22 submissions; matching workers compile or check and evaluate them in short-lived Docker containers and store per-test verdicts. Submission details receive live Socket.IO status and test-progress events, with REST polling as a fallback.

## Architecture

```text
React + Vite  --->  Express API + scheduler  --->  PostgreSQL
     :5173                  :4000                    :5432
                                  |
                                  v
                         RabbitMQ ingress queue
                                  |
                         compatible worker queue
                                  |
                                  v
                            Worker group  --->  Language sandbox
                                                   (short-lived)
```

PostgreSQL is the durable source of truth for users, problems, submissions, executions, and test results. The API publishes persistent jobs to a durable RabbitMQ queue and waits for publisher confirmation. The API remains a modular monolith; workers run as separate processes. Only the trusted worker can access the Docker daemon socket. Submitted programs run in containers without that socket or host path mounts.

## Local setup

1. Copy `.env.example` to `.env` and replace the development secrets.
2. Install dependencies with `npm install`.
3. Start PostgreSQL and RabbitMQ with `docker compose up postgres rabbitmq -d`.
4. Generate the Prisma client and apply the checked-in migrations:

   ```bash
   npm run prisma:generate --workspace=server
   npm run prisma:deploy --workspace=server
   ```

5. Seed example problems with `npm run prisma:seed --workspace=server`.
6. Make sure the Docker daemon is running, then run `npm run dev`. This starts the API, worker, and frontend; the worker pulls the four language images in parallel if they are not already available.

Open `http://localhost:5173`. The API health endpoint is `http://localhost:4000/health`.

RabbitMQ's management UI is available at `http://localhost:15672` with the credentials in `.env` (the development defaults are `code_platform` / `change-me`).

## Docker Compose

For the full containerized application, run:

```bash
docker compose up --build
```

Before starting, set a safe `JWT_SECRET` in `.env`. Compose waits for healthy Postgres and RabbitMQ services; the API applies checked-in migrations and seeds the sample problem at startup. The worker needs access to `/var/run/docker.sock` so it can create isolated execution containers. The submitted-code containers do not receive the socket.

The scheduler defaults to FIFO. Set `SCHEDULER_STRATEGY=PRIORITY` to honor admin-set priorities from 0 to 10. Set `WORKER_LANGUAGES` to a comma-separated supported language list when running a specialized worker; it defaults to all four languages.

The Compose stack also starts Prometheus at `http://localhost:9090` and Grafana at `http://localhost:3000`. Grafana provisions the Codebox Operations dashboard and uses `GRAFANA_USER` / `GRAFANA_PASSWORD`; change the development defaults before sharing the host. The API exposes `/health/live`, `/health/ready`, and `/metrics`; the worker exposes equivalent health routes and metrics on its internal port 9101.

## Continuous integration

GitHub Actions runs linting, TypeScript checks, server tests, application builds, Docker image builds, a Docker-backed end-to-end submission for each supported language, and Prometheus/Grafana integration checks on pushes to `main` and pull requests.

## Implemented endpoints

| Method | Endpoint                                   | Purpose                                                              |
| ------ | ------------------------------------------ | -------------------------------------------------------------------- |
| POST   | `/api/auth/register`                       | Register a user                                                      |
| POST   | `/api/auth/login`                          | Log in and receive a JWT                                             |
| GET    | `/api/auth/me`                             | Return the authenticated user                                        |
| GET    | `/api/problems`                            | List published problems                                              |
| GET    | `/api/problems/:id`                        | Get a problem without hidden tests                                   |
| POST   | `/api/problems`                            | Create a problem (admin only)                                        |
| GET    | `/api/problems/:id/test-cases`             | List test-case revisions (admin only)                                |
| POST   | `/api/problems/:id/test-cases`             | Create a test case and its version 1 (admin only)                    |
| PATCH  | `/api/problems/:id/test-cases/:testCaseId` | Add a test-case revision using `expectedVersion` (admin only)        |
| POST   | `/api/submissions`                         | Save and enqueue a submission (JWT required; priority is admin-only) |
| GET    | `/api/submissions`                         | List the authenticated user's submissions                            |
| GET    | `/api/submissions/:id`                     | Read one of the authenticated user's submissions                     |
| POST   | `/api/submissions/:id/cancel`              | Cancel an owned queued or active submission                          |
| POST   | `/api/submissions/:id/rerun`               | Create a new run from a completed owned execution                    |

## Submission lifecycle contract

Submission statuses are persisted with each record. The state machine in `server/src/modules/submissions/state-machine.ts` rejects transitions that are not listed here:

| Current status | Allowed next statuses                                                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QUEUED`       | `ASSIGNED`, `CANCELLED`, `SYSTEM_ERROR`                                                                                                                                     |
| `ASSIGNED`     | `STARTING`, `QUEUED` (retry), `CANCELLED`, `SYSTEM_ERROR`                                                                                                                   |
| `STARTING`     | `COMPILING`, `RUNNING`, `QUEUED` (retry), `CANCELLED`, `SYSTEM_ERROR`                                                                                                       |
| `COMPILING`    | `RUNNING`, `COMPILATION_ERROR`, `TIME_LIMIT_EXCEEDED`, `MEMORY_LIMIT_EXCEEDED`, `QUEUED` (retry), `CANCELLED`, `SYSTEM_ERROR`                                               |
| `RUNNING`      | `ACCEPTED`, `WRONG_ANSWER`, `TIME_LIMIT_EXCEEDED`, `MEMORY_LIMIT_EXCEEDED`, `RUNTIME_ERROR`, `QUEUED` (retry), `CANCELLED`, `SYSTEM_ERROR`                                  |
| Final outcomes | `ACCEPTED`, `WRONG_ANSWER`, `TIME_LIMIT_EXCEEDED`, `MEMORY_LIMIT_EXCEEDED`, `COMPILATION_ERROR`, `RUNTIME_ERROR`, `SYSTEM_ERROR`, `CANCELLED` have no outgoing transitions. |

Retries can return any active state to `QUEUED` while the current lease is still owned. Each final outcome is terminal. Unit tests cover allowed and rejected transitions.

## Current execution support

The worker supports Java 21, Python 3.12, C++23, and Node.js 22 through explicit execution profiles. It records compile or syntax-check outcomes and per-test verdicts. Each execution captures its source hash, profile, Docker image identity, and exact test-case revisions. Owners can re-run a completed submission without replacing the original result. Test input and expected output are never returned from the submission API or realtime events. Persisted worker heartbeats power the status page, while expiring submission leases allow stale-job recovery.

## Security note

Passwords are hashed with bcrypt and protected endpoints require JWTs. Each language runs with no network, a read-only root filesystem, non-root UID, dropped Linux capabilities, CPU, memory, process, time, source-size, and output limits. C++ gets a separate bounded executable tmpfs for its compiled binary; source stays on a no-exec workspace mount. Docker is educational isolation, not a guarantee against hostile code. The retry limit is three total execution attempts; dead-letter messages currently require operator inspection and have no replay UI. Metrics endpoints should stay on a trusted network. Redis is not implemented because the current core does not need it.

## Learning notes

- [Architecture](docs/architecture.md)
- [Execution flow](docs/execution-flow.md)
- [Worker design](docs/worker-design.md)
- [Scheduling](docs/scheduling.md)
- [Sandbox security](docs/sandbox-security.md)
- [Failure handling](docs/failure-handling.md)
- [Database design](docs/database.md)
- [Observability](docs/observability.md)
- [Reproducibility](docs/reproducibility.md)
- [Contests and standings](docs/contests.md)

## Next phase

Phases 5–9 are implemented: bounded retries, lease-based recovery, scheduling, observability, immutable execution provenance, test-case revisions, re-runs, and basic timed contests with score-derived standings. Phase 10 is production hardening: rate limiting, cleanup jobs, stronger validation, CI/CD improvements, and deployment documentation. No deployment or paid service is authorized without explicit approval.
