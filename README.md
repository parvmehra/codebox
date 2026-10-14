# Distributed Code Execution & Evaluation Platform

The project has a React client with a Monaco code editor, a modular Express API, PostgreSQL with Prisma, JWT authentication, and problem browsing. Authenticated users can now create durable submissions and enqueue them in RabbitMQ. The submission worker and code execution are the next module.

## Architecture

```text
React + Vite  --->  Express API  --->  PostgreSQL
     :5173             :4000              :5432
                          |
                          v
                    RabbitMQ queue  --->  Worker (next module)
                       :5672
```

PostgreSQL is the durable source of truth for users, problems, and submissions. The API publishes persistent jobs to a durable RabbitMQ queue and waits for publisher confirmation. The API remains a modular monolith; workers run as separate processes.

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
6. Run the API and frontend with `npm run dev`.

Open `http://localhost:5173`. The API health endpoint is `http://localhost:4000/health`.

RabbitMQ's management UI is available at `http://localhost:15672` with the credentials in `.env` (the development defaults are `code_platform` / `change-me`).

## Docker Compose

For a containerized Phase 1 environment, run:

```bash
docker compose up --build
```

Before starting, set a safe `JWT_SECRET` in `.env`. Compose waits for healthy Postgres and RabbitMQ services; the API applies checked-in migrations and seeds the sample problem at startup. The worker container will be added with the execution module.

## Continuous integration

GitHub Actions runs linting, TypeScript checks, server tests, application builds, and Docker image builds for the API and frontend on pushes to `main` and pull requests.

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

## Security note

Passwords are hashed with bcrypt and protected endpoints require JWTs. Submissions are only queued today; no worker consumes them and no submitted code is executed. The worker will run code in Docker containers with documented resource limits. Redis, metrics, contests, and real-time updates are not implemented.

## Next phase

Next, add one Java worker that consumes the queue and evaluates submissions in Docker-isolated containers.
