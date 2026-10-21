# Deployment guide

This guide describes a single-host Docker Compose deployment. The checked-in Compose file is designed for local development and evaluation; it publishes application, database, broker, and observability ports on the host and uses one API process. Treat the steps below as a controlled, single-host deployment baseline, not as a hardened multi-tenant production design.

## Host and configuration

- Use a Linux host with Docker Engine and the Docker Compose plugin. The worker binds `/var/run/docker.sock` to launch language containers. Anyone who can control that socket can effectively control the host, so run this stack only on a dedicated host or VM and restrict access to the Docker group and deployment account.
- Copy `.env.example` to `.env` and replace every development credential. Use a random `JWT_SECRET` of at least 32 characters, unique PostgreSQL and RabbitMQ passwords, and a unique Grafana password. Keep `.env` out of source control and restrict its file permissions.
- Set `CLIENT_ORIGIN` to the browser-visible origin, such as `https://code.example.org`. Set `VITE_API_URL` before building the frontend. For a reverse proxy routing `/api` and `/socket.io/` to the API on the same hostname, use `VITE_API_URL=/api`. For a separate API hostname, use its full HTTPS API URL ending in `/api`.
- Set `TRUST_PROXY_HOPS` to the exact number of trusted proxies in front of the API. Keep it at `0` when clients connect directly. Never trust arbitrary forwarded headers.
- Keep `DATABASE_URL` and `RABBITMQ_URL` private to the Compose network. If credentials contain URL-reserved characters, percent-encode them in connection URLs.

Example production-oriented values (replace the hostnames and secrets):

```dotenv
JWT_SECRET=<random-secret-at-least-32-characters>
POSTGRES_PASSWORD=<unique-database-password>
RABBITMQ_PASSWORD=<unique-broker-password>
GRAFANA_PASSWORD=<unique-grafana-password>
CLIENT_ORIGIN=https://code.example.org
VITE_API_URL=/api
TRUST_PROXY_HOPS=1
```

## Build and start

Review the Compose port mappings before starting. The base file publishes Postgres (`5432`), RabbitMQ (`5672`, `15672`), API (`4000`), Prometheus (`9090`), Grafana (`3000`), and frontend (`5173`) to host interfaces for local access. For an internet-facing host, restrict those mappings with a deployment-specific Compose override or firewall rules; expose only the TLS reverse proxy publicly. Do not expose PostgreSQL, RabbitMQ, Prometheus, Grafana, or `/metrics` to the public internet.

Route browser traffic through a TLS reverse proxy. It should serve the frontend and forward `/api` and the Socket.IO `/socket.io/` path, including WebSocket upgrades, to the API. Configure the proxy to preserve the original host and protocol and match `TRUST_PROXY_HOPS` to the actual trusted proxy chain.

Build and start the services after reviewing environment values and network exposure:

```bash
docker compose build
docker compose up -d
docker compose ps
```

The API container applies checked-in Prisma migrations and seeds the example problems when it starts. Back up the database before deploying a release that includes a migration. The frontend API URL is embedded at build time, so rebuild the frontend after changing `VITE_API_URL`.

## Data, upgrades, and operations

- Keep the `postgres_data`, `rabbitmq_data`, and `grafana_data` volumes on persistent storage. Prometheus data is also persisted in `prometheus_data` and has a configured 15-day retention period.
- Back up PostgreSQL regularly to storage outside the host and test restores. Protect backups as sensitive data: accounts, submissions, source code, contest participation, and results are stored in PostgreSQL. Back up broker data if queued work must survive loss of the host.
- Deploy updates with `docker compose pull` where images are remote, or `docker compose build` for locally built application images, followed by `docker compose up -d`. Check `docker compose ps`, API readiness at `/health/ready`, worker readiness at its internal port `9101`, and service logs after each update. Keep the previous application image available until the migration and health checks are confirmed.
- The API startup command runs migrations and the seed script. Keep a single API instance: request limits are in memory, and the scheduler and cleanup timer are process-local. Horizontal API scaling requires a shared rate-limit store and a deliberate singleton or distributed design for background services.
- Restrict Grafana and Prometheus to trusted operator networks. Change Grafana credentials and do not use its development defaults. Limit who can read metrics, logs, database backups, and worker logs.
- The worker's Docker socket provides substantial host privilege. Submitted programs run in restricted containers without the socket, but Docker-based isolation is not a guarantee against hostile code escaping. Use this project for controlled educational workloads, monitor the host, and do not place untrusted multi-tenant workloads on a sensitive machine.

## Current deployment limits

The Compose stack has one API and worker service, local named volumes, and no automated backup, TLS proxy, centralized secret manager, autoscaling, or high-availability database setup. Rate limits reset on API restart and do not coordinate replicas. Heartbeat history is retained for seven days by the API cleanup task. These limits should be addressed before treating the service as a production platform for public or sensitive workloads.
