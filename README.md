# Distributed Code Execution & Evaluation Platform

The foundation includes a React client, a modular Express API, PostgreSQL with Prisma, JWT authentication, and problem browsing. The submission record and lifecycle contract are now defined; queue delivery and code execution are the next module.

## Architecture

```text
React + Vite  --->  Express API  --->  PostgreSQL
     :5173             :4000              :5432
```

PostgreSQL is the durable source of truth. The API is a modular monolith so future queue, worker, and WebSocket modules can be added without splitting services prematurely.

## Local setup

1. Copy `.env.example` to `.env` and replace the development secrets.
2. Install dependencies with `npm install`.
3. Start PostgreSQL with `docker compose up postgres -d`.
4. Generate the Prisma client and apply the checked-in migrations:

   ```bash
   npm run prisma:generate --workspace=server
   npm run prisma:deploy --workspace=server
   ```

5. Seed example problems with `npm run prisma:seed --workspace=server`.
6. Run the API and frontend with `npm run dev`.

Open `http://localhost:5173`. The API health endpoint is `http://localhost:4000/health`.

## Docker Compose

For a containerized Phase 1 environment, run:

```bash
docker compose up --build
```

Before starting, ensure `.env` contains a safe `JWT_SECRET`. Prisma migrations are deliberately run as an explicit development step for now.

## Implemented endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/auth/register` | Register a user |
| POST | `/api/auth/login` | Log in and receive a JWT |
| GET | `/api/auth/me` | Return the authenticated user |
| GET | `/api/problems` | List published problems |
| GET | `/api/problems/:id` | Get a problem without hidden tests |
| POST | `/api/problems` | Create a problem (admin only) |

## Submission lifecycle contract

Submission statuses are persisted with each record. The state machine in `server/src/modules/submissions/state-machine.ts` rejects transitions that are not listed here:

| Current status | Allowed next statuses |
| --- | --- |
| `QUEUED` | `ASSIGNED`, `CANCELLED`, `SYSTEM_ERROR` |
| `ASSIGNED` | `STARTING`, `QUEUED` (retry), `CANCELLED`, `SYSTEM_ERROR` |
| `STARTING` | `COMPILING`, `RUNNING`, `CANCELLED`, `SYSTEM_ERROR` |
| `COMPILING` | `RUNNING`, `COMPILATION_ERROR`, `TIME_LIMIT_EXCEEDED`, `MEMORY_LIMIT_EXCEEDED`, `CANCELLED`, `SYSTEM_ERROR` |
| `RUNNING` | `ACCEPTED`, `WRONG_ANSWER`, `TIME_LIMIT_EXCEEDED`, `MEMORY_LIMIT_EXCEEDED`, `RUNTIME_ERROR`, `CANCELLED`, `SYSTEM_ERROR` |
| Final outcomes | `ACCEPTED`, `WRONG_ANSWER`, `TIME_LIMIT_EXCEEDED`, `MEMORY_LIMIT_EXCEEDED`, `COMPILATION_ERROR`, `RUNTIME_ERROR`, `SYSTEM_ERROR`, `CANCELLED` have no outgoing transitions. |

The `ASSIGNED → QUEUED` transition is reserved for a retry before execution starts. Each final outcome is terminal. Unit tests cover allowed and rejected transitions.

## Security note

Passwords are hashed with bcrypt and protected endpoints require JWTs. Source submissions are not accepted or executed yet; RabbitMQ, workers, Redis, metrics, contests, and real-time updates are also not implemented.

## Next phase

Next, the API will accept submissions and queue them for one Java worker, followed by Docker-isolated evaluation.
