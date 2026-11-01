# CodeBox Audit Report (Phase 1)

Audit date: 2026-10-25. Commit audited: `06d50ab` (branch `main`, clean tree). No application code was modified.

## Method and limits

- Read: schema, all 6 migrations (names only), compose, Dockerfiles, CI, auth/problem/submission/contest/worker routes, processor, executor, language profiles, recovery, queue topology, socket server, rate limiter, scripts.
- Executed locally (Windows, Node 24.11.1): `npm run lint`, `npm run typecheck`, `npm run build`, `npm run test --workspace=@platform/server`.
- **Docker daemon was not running**, so nothing involving containers (sandbox, compose, e2e scripts, RabbitMQ, Postgres, migrations against a real DB) was executed. Those items are "unable to verify" below, not "working".
- Not yet read in depth: `scheduler-service.ts`, `event-consumer.ts`, `worker/index.ts` beyond ack/retry paths, contests scoring, frontend pages, Grafana JSON, `docs/*` (existing docs are not assumed accurate).
- `.env` exists locally and is git-ignored (`git check-ignore` confirms); only `.env.example` is tracked. Values were not read or reproduced.

## Architecture (as implemented)

```
React/Vite SPA ──HTTP/Socket.IO──> Express API (auth, problems, submissions, contests, workers/status, /metrics)
                                      │ Prisma                    │ amqplib
                                      ▼                           ▼
                                  PostgreSQL            RabbitMQ: submissions.scheduler (priority ingress)
                          (Submission = job + lease)       → scheduler-service (in API) → per-capability
                                      ▲                      worker queues (submissions.worker.<langs>)
                                      │                       + retry / wait / dead queues, control fanout
                                  Worker(s) ◄──────────────────────┘
                     claim via DB lease → `docker create/start/exec` (docker CLI, host socket)
                     one sandbox container per attempt, source piped via stdin, tests run via `docker exec`
                     publishes realtime events + heartbeats via RabbitMQ → API → Socket.IO rooms `user:<id>`
Prometheus scrapes API + worker; Grafana provisioned dashboard.
```

Key design points: the DB row (`Submission`) is the job record, with `status`, `attemptCount`, `leaseToken`, `leaseExpiresAt`; claims are compare-and-set `updateMany`. Executions, per-test results and test-case versions are stored per attempt. A recovery loop in the API re-queues expired leases.

## Feature inventory

| # | Feature | Status | Basis |
|---|---|---|---|
| 1 | Authentication / authorization | Implemented, partially tested | bcrypt(12), JWT 1h, role middleware; weaknesses F-06. No admin bootstrap path exists (seed creates no admin) |
| 2 | Problem management | Partially implemented | Admin create only; no update/delete/publish endpoint; list unpaginated |
| 3 | Test-case management | Implemented, partially tested | Admin CRUD with optimistic versioning + immutable `TestCaseVersion` |
| 4 | Submission API | Implemented, unit-tested (mocked) | Validated, rate-limited, 202 async; see F-02 |
| 5 | State machine | Implemented and unit-tested | 24 tests pass |
| 6 | RabbitMQ publish/consume | Implemented, **not verified live** | Topology reviewed; no broker run |
| 7 | Worker lifecycle | Implemented, unit-tested with mocks | processor tests mock Prisma/Docker |
| 8 | Sandbox creation/cleanup | Implemented, **unable to verify** | Hardened flags present (below); cleanup in `finally` |
| 9–12 | Java / Python / C++ / Node | Implemented, **unable to verify** | Profiles pinned by tag; CI e2e script exists but was not run here |
| 13 | CPU/mem/time/output limits | Partially implemented | `--cpus 1`, memory+swap, pids, `timeout`, output cap at capture; memory *usage* never measured (F-04) |
| 14 | Hidden test-case protection | Implemented, thin tests | Problem endpoints omit test cases; admin-only listing; submission detail returns only status/time/message per test |
| 15 | Result persistence | Implemented, unit-tested (mocked) | |
| 16 | Retries / dead-letter | Implemented, **not verified live** | Bounded (2 retries, 5s TTL, attempt cap 3) |
| 17 | Heartbeat / failure detection | Implemented, partly tested | TTL 45s; lease 60s |
| 18 | Idempotency | Partially implemented | CAS claim + lease token protect against duplicates/stale writers; `Execution` unique on (submission, attempt) |
| 19 | Cancellation | Implemented, race semantics under-tested | DB flip + control fanout + 1 poll loop |
| 20 | Scheduler | Implemented, 6 unit tests | FIFO/priority strategies exist; behavior unmeasured |
| 21 | WebSocket auth/events | Implemented; e2e script covers it (not run) | Token verified at handshake; user-room scoping |
| 22 | Snapshots / reruns | Partially implemented | Snapshot good; rerun is a new Submission, not an attempt (F-10) |
| 23 | Contests / leaderboard | Implemented, 5 tests | Not audited in depth |
| 24 | Metrics / Grafana | Implemented, **not verified** | Dashboard queries not yet checked against metric names |
| 25 | Logging / health | Implemented | pino, request IDs, live/ready |
| 26 | Validation / rate limiting | Implemented; limiter in-memory per process | F-06 |
| 27 | Indexes / constraints | Reasonable | FKs and composite uniques present; not checked with EXPLAIN |
| 28 | Compose startup | Unable to verify | Healthchecks and `depends_on` conditions present |
| 29 | Automated tests | 92 pass, all mocked | No real DB/queue/Docker test in the test suite; no frontend tests |
| 30 | CI | Present; not verified | Runs lint, typecheck, unit, build, compose e2e scripts |

## Existing test and build results (executed)

| Check | Result |
|---|---|
| `npm run lint` (both workspaces) | pass |
| `npm run typecheck` | pass |
| `npm run build` (server `tsc`, frontend Vite) | pass |
| Server unit tests | 19 files, **92 passed**, 0 failed (1.5 s) |
| Docker image builds, compose, e2e scripts, migrations on a real DB | **not run** (no Docker daemon) |
| `prettier --check` (`format:check`) | not run; not part of CI |

## Findings

### Confirmed (from code)

**F-01 — High — Worker holds the host Docker socket** (`docker-compose.yml` worker `volumes`; `server/Dockerfile.worker` has no `USER`, so root)
Evidence: bind mount of `/var/run/docker.sock`; worker image installs `docker-cli`. Why it matters: user code is *not* given the socket (the sandbox has no mounts), but any bug in the worker process (it also holds DB and broker credentials) is host-root equivalent. Fix: document the trust boundary now; later options are a socket proxy that allows only `create/start/exec/kill/rm/inspect/image` on `codebox-exec-*`, a dedicated rootless Docker daemon, or running the worker non-root in the docker group. Risk: low-effort proxy is realistic; rootless/gVisor is future work.

**F-02 — High — Publish/persist window: accepted submissions can be stranded** (`submissions/routes.ts` POST `/`, schema `needsDispatch @default(false)`, `recovery.ts`)
Evidence: row is created with `needsDispatch=false`, then published. Recovery only re-publishes rows with `needsDispatch=true`. If the API dies (or the process is killed) between `prisma.submission.create` and `publishSubmission`, the row stays `QUEUED` forever with nothing to find it. The same happens if the broker accepts the message and it is later lost. The in-request failure path marks `SYSTEM_ERROR` (reasonable) but only for the case where the process survives. The same applies to `/rerun`.
Reproduce: `kill -9` the API after the insert (or stop RabbitMQ and kill the API before the catch block runs); inspect `Submission` for `status=QUEUED, needsDispatch=false`.
Fix: create with `needsDispatch=true`; clear it only after confirmed publish (recovery already handles the rest). This is a small change and effectively a transactional-outbox-lite; a separate outbox table is not needed. Add a test.

**F-03 — Medium — Hardcoded fallback secrets and exposed infra ports in Compose** (`docker-compose.yml`)
Evidence: defaults `change-me` for Postgres/RabbitMQ/Grafana; `JWT_SECRET` falls back to `development-only-secret-change-before-production` (which satisfies the `min(32)` check, so the API will start in production with it). Postgres 5432, RabbitMQ 5672/15672, Prometheus 9090 and Grafana 3000 are published on all interfaces. Fix: bind to 127.0.0.1, remove the JWT fallback (fail if unset), fail fast on a known-default secret when `NODE_ENV=production`.

**F-04 — Medium — Resource usage is not measured** (`docker-executor.ts` `completedResult`)
`memoryUsedKb` is always `null`. Reported execution time is wall-clock around `docker exec`, so it includes exec/JVM start overhead. Limits are enforced by Docker/`timeout` (good), but nothing reports usage, so "memory used" in the UI/DB is empty. Fix: read cgroup peak (`memory.peak`) or `docker stats`/inspect; document timing semantics.

**F-05 — Medium — All test cases of an attempt share one container** (`executeSubmission`)
Source, compile output (`/workspace`, `/exec`) and any background process persist across tests. A submission can leave a process or file during test 1 that influences test N (e.g. recording inputs, consuming the shared 64-PID budget). It cannot reach expected outputs (not in the container), so hidden answers stay protected, but isolation between tests is weaker than it appears. `timeout` kills the process group of the command, but a process that calls `setsid`/double-forks can survive until container removal. Fix options: kill all processes between tests (`docker exec ... kill -9 -1` as the sandbox user) or use a fresh container per test with a compile artifact. Needs an adversarial test to confirm severity.

**F-06 — Medium — Auth hardening gaps** (`middleware/auth.ts`, `auth/routes.ts`, `rate-limit.ts`, frontend)
- Role and id come from the JWT only; a demoted/deleted user keeps privileges until expiry (1 h). No revocation.
- `jwt.verify` does not pin `algorithms`; token stored in `localStorage` (XSS-readable); passed in the socket handshake.
- Rate limiter is in-memory and per process (resets on restart, not shared across API replicas) and keyed by IP only. Login limit is per IP, not per account.
- Register returns 409 for existing emails (account enumeration; low).
- There is no way to create an admin without editing the DB.

**F-07 — Withdrawn (false positive)** (`server/package.json`)
I initially flagged `@prometheus-io/client` as a possible non-canonical package. Checking the npm registry showed it is published by the Prometheus team (`prombot`, `prometheus-team@googlegroups.com`) from `prometheus/client_js`, and the older `prom-client` is marked deprecated in its favor. No change needed.

**F-08 — Medium — Unauthenticated operational endpoints**
`GET /metrics` (API) and `GET /api/workers/status` have no auth and are published on port 4000. Data is low-sensitivity (no IDs in labels from what I read) but exposes route names, worker counts and process internals. Fix: restrict `/metrics` to the internal network.

**F-09 — Medium — Test suite does not exercise the risky paths**
All 92 tests mock Prisma and Docker. No vitest test touches a real Postgres, RabbitMQ or container. The only coverage of real behavior is `scripts/worker-e2e.mjs` and `observability-e2e.mjs` in CI, and I did not run them. `worker-e2e.mjs` includes `while (true) {}`; I have not checked it for fork bombs, memory bombs, network access, output floods or traversal, which Phase 3 requires. No frontend tests.

**F-10 — Low/Medium — Reruns are new Submissions, not attempts of the original** (`submissions/routes.ts` `/rerun`)
The original is preserved (good) and the rerun references `rerunOfExecutionId`, but it appears as a separate submission in history/leaderboards-adjacent queries and ignores `contestId`. Reproducibility is also limited because profile images are pinned by tag, not digest, and a locally built image with no `RepoDigest` falls back to a local image ID that other hosts cannot pull. Document as a limitation; decide on the intended model.

**F-11 — Low — Pagination and bounds**
`GET /api/problems` is unbounded. Submission history is bounded (max 50). Checked only problems and submissions so far.

**F-12 — Low — CI hygiene**
Actions are referenced by tag (`checkout@v6`, `setup-node@v7`), not commit SHA; I cannot confirm those tags exist as written. Compose `docker compose up` in CI does not run `format:check`. No Docker layer cache, no separate integration job, no test result artifacts.

### Suspected / needs verification

- **S-01** Cancellation race semantics (cancel vs. completion) rely on a DB compare-and-set plus a 1 s-ish poll; orphan container removal on a killed worker is not covered (containers named `codebox-exec-*` could survive a worker crash — `docs/deployment.md` mentions cleanup; unverified).
- **S-02** Lease (60 s) is renewed only on phase change and per-test result. A single slow compile/test near its limits plus Docker latency could expire the lease during active work, producing a duplicate attempt. Plausible but not reproduced.
- **S-03** Output cap: capture limits memory correctly (verified in code) but the *program* is only stopped by killing the whole container; confirm that the following tests and cleanup behave.
- **S-04** `seccomp` is Docker's default profile only (no explicit profile); documented requirement is an explicit profile.
- **S-05** Socket.IO: only `user:<id>` rooms and handshake JWT verified in code; reconnect and missed-event recovery relies on the UI refetching, unverified.
- **S-06** Grafana dashboard queries vs. registered metric names unchecked.
- **S-07** `.env` is untracked, but I did not scan git history for previously committed secrets (`git log -p` search is pending).

## Strengths worth preserving

Sandbox create flags are already strong: `--network none`, memory = memory-swap, pids limit, read-only rootfs, `--cap-drop ALL`, `no-new-privileges`, uid 65534, noexec tmpfs, no host mounts, `docker kill`/`rm --force` cleanup in `finally`. Claiming uses compare-and-set with lease tokens; test-case versioning is immutable; hidden-case handling and ownership checks (`findFirst({id, userId})`) look right; error handler does not leak stacks.

## Proposed remediation order

1. **Phase 3 (sandbox) verification with Docker running**, including adversarial tests, and a decision on F-05 and F-01.
2. **F-02** dispatch-window fix (small, high value) with a test.
3. **F-03, F-08** secrets/ports/metrics exposure (F-07 withdrawn).
4. **Phase 2 baseline** with Docker: compose up, migrations, e2e scripts; write `verification-report.md`.
5. **F-04** measured memory; **F-06** auth hardening (algorithm pin, DB-backed role check, admin bootstrap).
6. Real-integration tests (Postgres + RabbitMQ in CI), cancellation/lease races (S-01, S-02).
7. Observability check (S-06), docs reconciliation, then benchmarking.

## Recommended first change set (after your approval)

1. Start Docker Desktop (or tell me it's unavailable) so I can run Phase 2 baseline and the existing e2e scripts, and record real results.
2. Add adversarial sandbox tests (fork bomb, memory bomb, output flood, network, traversal, persistence across tests), run them, and report before changing the executor.
3. Fix F-02 (`needsDispatch` default + test) as the first code change, in its own commit.

## Status update (2026-10-25, after approval)

Docker Desktop (Engine 28.5.2) was available, so the sandbox was exercised for real. Only Python and Node images were pulled; **Java and C++ are still unverified.**

- **Sandbox adversarial tests** (`server/src/worker/docker-executor.integration.test.ts`, opt-in with `CODEBOX_DOCKER_TESTS=1`, otherwise skipped): infinite loop, memory bomb, output flood, fork bomb, network, read-only rootfs, secret/socket exposure, non-root user, container cleanup, syntax/runtime/wrong-answer classification. All pass on Python and Node (14 tests). Rootfs/privilege/seccomp behavior on Docker Desktop (WSL2) may differ from a Linux host.
- **F-05 confirmed and fixed**: a process and file from test 1 were visible in test 2. The executor now kills all sandbox-user processes and clears `/tmp` between tests. The new test fails without the change and passes with it. `/workspace` (source/binary) is not reset.
- **F-02 fixed**: submissions and reruns are created with `needsDispatch=true` and cleared after a confirmed publish, so recovery re-publishes anything stranded by a crash. Unit tests updated; a crash-injection test against a real broker is still to do.
- Server unit tests: 92 passed, 14 Docker tests skipped without the opt-in flag; lint and typecheck clean. Changes are uncommitted.

## Status update: auth hardening (F-06)

Fixed and verified (unit tests plus a live check against a running API container): JWT algorithm pinned to HS256 for signing, API verification and Socket.IO; admin routes now read the role from the database, so promotions and demotions apply immediately (tested for a demoted admin); per-account login rate limit in addition to per-IP (live: 429 on the 11th attempt); operator command `promote-admin` to create the first admin (live: 403 before, 201 after, same token).

Still open from F-06: tokens remain in `localStorage` (XSS-readable) and cannot be revoked before expiry for non-admin routes; the rate limiter is in-memory per process, so it resets on restart and is not shared across replicas; registration still reveals whether an email exists (409). These are documented limitations, not fixed.
