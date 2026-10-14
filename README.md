# Distributed Code Execution & Evaluation Platform

The project has a React client with a Monaco code editor, a modular Express API, PostgreSQL with Prisma, JWT authentication, problem browsing, and a Java 21 submission worker. Authenticated users can enqueue submissions; the worker compiles and evaluates them in short-lived Docker containers and stores per-test verdicts.

## Architecture

```text
React + Vite  --->  Express API  --->  PostgreSQL
     :5173             :4000              :5432
                          |
                          v
                    RabbitMQ queue  --->  Worker  --->  Java sandbox
                       :5672                |          (short-lived)
                                            +----------> PostgreSQL
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
6. Make sure the Docker daemon is running, then run `npm run dev`. This starts the API, worker, and frontend; the worker pulls the Java image if it is not already available.

Open `http://localhost:5173`. The API health endpoint is `http://localhost:4000/health`.

RabbitMQ's management UI is available at `http://localhost:15672` with the credentials in `.env` (the development defaults are `code_platform` / `change-me`).

## Docker Compose

For the full containerized application, run:

```bash
docker compose up --build
```

Before starting, set a safe `JWT_SECRET` in `.env`. Compose waits for healthy Postgres and RabbitMQ services; the API applies checked-in migrations and seeds the sample problem at startup. The worker needs access to `/var/run/docker.sock` so it can create isolated execution containers. The submitted-code containers do not receive the socket.

## Continuous integration

GitHub Actions runs linting, TypeScript checks, server tests, application builds, Docker image builds, and a Docker-backed Java worker end-to-end flow on pushes to `main` and pull requests.

## Implemented endpoints

| Method | Endpoint               | Purpose                                          |
| ------ | ---------------------- | ------------------------------------------------ |
| POST   | `/api/auth/register`   | Register a user                                  |
| POST   | `/api/auth/login`      | Log in and receive a JWT                         |
| GET    | `/api/auth/me`         | Return the authenticated user                    |
| GET    | `/api/problems`        | List published problems                          |
| GET    | `/api/problems/:id`    | Get a problem without hidden tests               |
| POST   | `/api/problems`        | Create a problem (admin only)                    |
| POST   | `/api/submissions`     | Save and enqueue a submission (JWT required)     |
| GET    | `/api/submissions`     | List the authenticated user's submissions        |
| GET    | `/api/submissions/:id` | Read one of the authenticated user's submissions |

## Submission lifecycle contract

Submission statuses are persisted with each record. The state machine in `server/src/modules/submissions/state-machine.ts` rejects transitions that are not listed here:

| Current status | Allowed next statuses                                                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QUEUED`       | `ASSIGNED`, `CANCELLED`, `SYSTEM_ERROR`                                                                                                                                     |
| `ASSIGNED`     | `STARTING`, `QUEUED` (retry), `CANCELLED`, `SYSTEM_ERROR`                                                                                                                   |
| `STARTING`     | `COMPILING`, `RUNNING`, `CANCELLED`, `SYSTEM_ERROR`                                                                                                                         |
| `COMPILING`    | `RUNNING`, `COMPILATION_ERROR`, `TIME_LIMIT_EXCEEDED`, `MEMORY_LIMIT_EXCEEDED`, `CANCELLED`, `SYSTEM_ERROR`                                                                 |
| `RUNNING`      | `ACCEPTED`, `WRONG_ANSWER`, `TIME_LIMIT_EXCEEDED`, `MEMORY_LIMIT_EXCEEDED`, `RUNTIME_ERROR`, `CANCELLED`, `SYSTEM_ERROR`                                                    |
| Final outcomes | `ACCEPTED`, `WRONG_ANSWER`, `TIME_LIMIT_EXCEEDED`, `MEMORY_LIMIT_EXCEEDED`, `COMPILATION_ERROR`, `RUNTIME_ERROR`, `SYSTEM_ERROR`, `CANCELLED` have no outgoing transitions. |

The `ASSIGNED → QUEUED` transition is reserved for a retry before execution starts. Each final outcome is terminal. Unit tests cover allowed and rejected transitions.

## Current execution support

Java 21 is the only enabled language profile. The worker records compile or run outcomes and per-test verdicts. Test input and expected output are never returned from the submission API. Other language choices remain disabled until their Phase 3 profiles are implemented.

## Security note

Passwords are hashed with bcrypt and protected endpoints require JWTs. Java runs with no network, a read-only root filesystem, non-root UID, dropped Linux capabilities, CPU, memory, process, time, source-size, and output limits. A Docker container is educational isolation; it is not a guarantee against all hostile code. Worker heartbeats, retry/dead-letter behavior, cancellation, Socket.IO updates, Redis, metrics, and contests are not implemented yet.

## Learning notes

- [Architecture](docs/architecture.md)
- [Execution flow](docs/execution-flow.md)
- [Worker design](docs/worker-design.md)
- [Sandbox security](docs/sandbox-security.md)
- [Failure handling](docs/failure-handling.md)
- [Database design](docs/database.md)

## Next phase

Phase 3 adds Python, C++, and Node.js profiles through the same `LanguageProfile` abstraction.
