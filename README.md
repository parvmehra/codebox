# Distributed Code Execution & Evaluation Platform

Phase 1 establishes the foundation for a distributed code execution platform: a React client, a modular Express API, PostgreSQL with Prisma, JWT authentication, and problem browsing. The execution pipeline is intentionally not present yet.

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
4. Generate the Prisma client and apply the first migration:

   ```bash
   npm run prisma:generate --workspace=server
   npm run prisma:migrate --workspace=server -- --name init
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

## Security note

Passwords are hashed with bcrypt and protected endpoints require JWTs. This phase has no code execution capability, queues, workers, Redis, RabbitMQ, metrics, contests, or real-time updates.

## Next phase

Phase 2 will add asynchronous submissions, RabbitMQ, one Java worker, and Docker-isolated evaluation.
