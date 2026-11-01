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

For deployment configuration, reverse-proxy routing, persistent data, and operational limits, see [Deployment](docs/deployment.md). The frontend's API URL is set at build time with `VITE_API_URL`; set `CLIENT_ORIGIN` to the browser's origin and configure `TRUST_PROXY_HOPS` when using a trusted reverse proxy.

The scheduler defaults to FIFO. Set `SCHEDULER_STRATEGY=PRIORITY` to honor admin-set priorities from 0 to 10. Set `WORKER_LANGUAGES` to a comma-separated supported language list when running a specialized worker; it defaults to all four languages.

### Creating the first admin

No account is an admin by default. Register through the app, then promote that account from the command line (done this way so nobody can claim admin by signing up first):

```bash
docker compose exec api node server/dist/scripts/promote-admin.js you@example.com
```

The role is checked against the database on admin routes, so the change applies immediately and a demoted admin loses access without waiting for the token to expire.

The Compose stack also starts Prometheus at `http://localhost:9090` and Grafana at `http://localhost:3000`. Grafana provisions the Codebox Operations dashboard and uses `GRAFANA_USER` / `GRAFANA_PASSWORD`; change the development defaults before sharing the host. The API exposes `/health/live` and `/health/ready` publicly and `/metrics` only on internal port 9100; the worker exposes equivalent health routes and metrics on its internal port 9101.

## Testing

| Suite | Command | What it proves |
| --- | --- | --- |
| Unit tests (103) | `npm run test --workspace=@platform/server` | State machine, validation, scoring, scheduler, retries, auth, rate limits, metrics (database and broker mocked) |
| Sandbox tests (31, real Docker) | `CODEBOX_DOCKER_TESTS=1 npx vitest run src/worker/docker-executor.integration.test.ts` (from `server/`) | Hostile programs for Python, Node.js, Java and C++: loops, memory/fork bombs, output floods, no network, read-only root, non-root user, no state between test cases, kernel-measured memory |
| `scripts/worker-e2e.mjs` | needs the Compose stack | A correct program per language, Socket.IO authentication and event isolation |
| `scripts/correctness-e2e.mjs` | needs the Compose stack | Validation, hidden test cases never exposed, ownership, rerun immutability and snapshot replay, cancellation at every stage, concurrent burst without loss or duplicates |
| `scripts/scheduler-e2e.mjs` | needs the Compose stack | FIFO vs PRIORITY ordering, language-capability matching |
| `scripts/recovery-e2e.mjs` | needs the Compose stack (kills services) | Duplicate delivery, stranded rows, worker SIGKILL, RabbitMQ and PostgreSQL outages |
| `scripts/observability-e2e.mjs` | needs the Compose stack | Prometheus scrapes the API and worker, Grafana is ready |
| `scripts/benchmark.mjs` | needs the Compose stack | Throughput and latency, see [Benchmarks](docs/benchmarks.md) |

The e2e suites create their own problems and accounts and restart services on purpose, so run them against a disposable local stack. Registration is limited to 5 per hour per IP and the limiter is in memory, so restart the API (`docker compose restart api`) between suites. If port 5432 is already used on your machine, set `POSTGRES_HOST_PORT=5433`.

## Continuous integration

GitHub Actions (`.github/workflows/ci.yml`) runs three jobs on pushes to `main` and pull requests: `verify` (lint, typecheck, unit tests, build), `sandbox` (the real-Docker adversarial suite on Linux) and `e2e` (builds the images, starts the stack, and runs every live suite above). The workflow has not yet been run on GitHub; its action versions are pinned by tag, not by commit SHA.

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

Passwords are hashed with bcrypt and protected endpoints require JWTs. Registration, login, submission, and re-run requests have per-IP rate limits; the current in-memory limits are per API process. Each language runs with no network, a read-only root filesystem, non-root UID, dropped Linux capabilities, CPU, memory, process, time, source-size, and output limits. C++ gets a separate bounded executable tmpfs for its compiled binary; source stays on a no-exec workspace mount. Docker is educational isolation, not a guarantee against hostile code. The retry limit is three total execution attempts; dead-letter messages currently require operator inspection and have no replay UI. `/metrics` is served on a separate internal port (API 9100, worker 9101) that Compose does not publish; published ports bind to `127.0.0.1`. The JWT algorithm is pinned to HS256, admin routes read the role from the database, and logins are rate limited per IP and per account. Redis is not implemented because the current single API process does not need a shared limit store.

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
- [Request rate limits](docs/rate-limiting.md)
- [Input validation](docs/input-validation.md)
- [Deployment](docs/deployment.md)

## Verified status and known limitations

What has been run and observed, not just written: the sandbox against hostile programs in all four languages (on Docker Desktop with WSL2), duplicate delivery, worker SIGKILL, broker and database outages, cancellation at each stage, scheduling order and capability matching, a concurrent burst, reruns replaying recorded test-case versions, and one-vs-three-worker throughput. See [verification report](docs/verification-report.md), [failure handling](docs/failure-handling.md) and [benchmarks](docs/benchmarks.md).

Known limitations, stated plainly:

- **Isolation is Docker, not a VM.** A kernel or runtime vulnerability is out of scope. The worker holds the Docker socket, so a worker compromise is host-level; run workers on a dedicated host. See [sandbox security](docs/sandbox-security.md). gVisor, Sysbox or a microVM are the next step.
- **At-least-once delivery, not exactly-once.** Duplicates are made harmless by a compare-and-set claim and a unique attempt number.
- **A broker outage fails new submissions** with `503` after about 12 s and marks them `SYSTEM_ERROR`; the user must resubmit. Jobs already queued survive.
- **Recovery of a killed worker takes about 75 s** (60 s lease plus the 15 s recovery sweep).
- **Memory usage** is the container cgroup peak. For Java and C++ it includes the compiler. Execution time is wall-clock around `docker exec`, so it includes process start-up.
- **Rate limits are in memory** and per API process; they reset on restart and are not shared across replicas. Redis is not used.
- **JWTs live in `localStorage`** and cannot be revoked before the 1 h expiry on non-admin routes. Registration reveals whether an email exists.
- **The Monaco editor loads from a CDN** (`@monaco-editor/react` default), so the editor needs internet access and a strict Content-Security-Policy would break it.
- **The UI was not tested in a real browser.** The frontend build, serving, routing, CORS and headers were checked over HTTP only; there are no frontend tests.
- **Per-job overhead dominates** (about 1.1 s for a 0.25 s program). A pool is saturated quickly; see the benchmark bottleneck notes.
- **Results above were produced on one Windows laptop.** Rerun the sandbox and e2e suites on the deployment host.
- Dead-lettered messages need operator inspection; there is no replay UI. Prettier reports 20 files that were unformatted before this work.

Future improvements: a warm-container pool, a stronger isolation runtime, shared rate limiting, a browser-level test suite, bundling Monaco locally, and a replay tool for the dead-letter queue.
