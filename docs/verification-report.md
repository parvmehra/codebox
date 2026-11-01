# CodeBox Verification Report (Phase 2 baseline)

Run date: 2026-11-01. Commit: `bc0f34f` (after the F-02 and F-05 fixes). Host: Windows 11, Docker Desktop (Engine 28.5.2, WSL2 backend), Node 24.11.1. Results below were actually executed; anything not listed was not run.

| Check | Command | Result |
|---|---|---|
| Lint | `npm run lint` | pass |
| Typecheck | `npm run typecheck` | pass |
| Production build (server + frontend) | `npm run build` | pass |
| Unit tests | `npm run test --workspace=@platform/server` | 92 passed, 14 Docker tests skipped without opt-in |
| Sandbox tests, real Docker (Python, Node) | `CODEBOX_DOCKER_TESTS=1 npx vitest run src/worker` | 28 passed |
| Compose config | `docker compose config -q` | valid |
| Image builds | `docker compose build api worker frontend` | pass |
| Stack start | `docker compose up -d postgres rabbitmq api worker prometheus grafana` | all started; postgres, rabbitmq, api healthy |
| Migrations | applied by the API container on start | 7 recorded, 7 finished (`_prisma_migrations`) |
| API readiness | `GET /health/ready` | `{"status":"ready","checks":{"database":true,"scheduler":true}}` |
| Worker readiness | compose healthcheck | healthy after ~1 min while pulling Java and C++ images |
| Worker e2e | `node scripts/worker-e2e.mjs` | pass for Java, Python, C++, Node.js, including Socket.IO |
| Observability e2e | `node scripts/observability-e2e.mjs` | pass: Prometheus scrapes API and worker, Grafana ready |
| Dashboard metric names | compared the 5 metric names in the dashboard JSON with live `/metrics` | all 5 exist |

## Not run or not covered

- `npm run format:check` (not in CI).
- The frontend container was not started (`docker compose up` here omitted it); only its image build was verified. The frontend was not exercised in a browser.
- Java and C++ were verified only through the e2e script (a correct program), not through the adversarial suite, which covers Python and Node.
- Dashboard panel *correctness* (expressions, units, rate windows) was not inspected, only that metric names exist. The dashboard covers HTTP, scheduler assignments and worker jobs; it has no queue-wait, retry or container-failure panel.
- Failure scenarios (worker crash mid-run, broker/DB outage, duplicate delivery), cancellation races, and concurrency were not run.
- GitHub Actions has not been run; its tag-pinned action versions are unverified.
- Rootfs, privilege and seccomp behavior on Docker Desktop/WSL2 may differ from a Linux host.

## Observations

- Documented setup works with the services above, but the worker takes several minutes on a cold machine to pull four language images; compose gives it a 10-minute start period.
- Docker Desktop stopped on its own twice between sessions, so builds were restarted.
- `wget http://localhost:9101` inside the worker container is refused while `127.0.0.1` works (IPv6 `localhost` resolution); the compose healthcheck uses `127.0.0.1`, so it is unaffected.

## Later verification (after the baseline above)

Run on the same Windows/Docker Desktop host, against the commits that introduced each suite. All results below were executed and passed; "not covered" lists what was not.

| Suite | Result |
|---|---|
| Unit tests | 103 passed |
| Sandbox, real Docker (Python, Node.js, Java, C++) | 31 passed |
| `scripts/correctness-e2e.mjs` | 6 of 6 scenarios passed |
| `scripts/scheduler-e2e.mjs` | 3 of 3 passed (FIFO order, PRIORITY order, capability matching) |
| `scripts/recovery-e2e.mjs` | 6 of 6 passed (duplicate delivery, stranded row, no worker, worker SIGKILL, RabbitMQ outage, PostgreSQL outage) |
| `scripts/benchmark.mjs` | 1 worker 0.90 jobs/s; 3 workers 2.27 jobs/s (see `docs/benchmarks.md`) |
| Dashboard | every panel query returns data on a live Prometheus |
| Frontend | served over HTTP with SPA fallback, CORS and security headers verified; **not tested in a browser** |

Not covered: GitHub Actions (never run), a real Linux host (Docker Desktop/WSL2 only), crashes at exact points inside compile or between tests, database or broker loss while a worker is mid-run, and a browser-level UI test.
