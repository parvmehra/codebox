# Benchmarks

These numbers describe **one machine and one synthetic workload**. They show how this implementation behaves and where its bottleneck is. They are not a capacity claim and will not transfer to other hardware, to Java/C++ workloads, or to a real Linux server.

## Environment

- Windows 11 laptop, Docker Desktop (Engine 28.5.2, WSL2 backend), 20 logical CPUs and 11.5 GiB visible to Docker, load generator and all services on the same machine.
- Only `postgres`, `rabbitmq`, `api` and `worker` were running (Prometheus, Grafana and the frontend were stopped).
- Date: 2026-11. Commit: the one that added `scripts/benchmark.mjs`.

## Workload and method

- Language: Python 3.12. One problem with one test case. Each submission runs a fixed CPU loop (`for i in range(3_000_000): total += i`, roughly 0.25 s of CPU) and prints the expected answer.
- 3 batches of 18 simultaneous submissions per configuration (54 samples). Submissions are limited to 20 per minute per IP, so batches are 61 s apart and every batch starts against an idle pool. This measures a burst, not sustained load.
- Every job was required to finish `ACCEPTED` with exactly one execution; the run aborts otherwise.
- All timings come from PostgreSQL timestamps (`Submission.createdAt`, `Execution.startedAt`, `Execution.completedAt`), except submission acceptance latency, which is the client-side `POST /api/submissions` round trip.
- Queue wait = `startedAt - createdAt`. Execution = `completedAt - startedAt` (container create, start, compile check, run, cleanup bookkeeping). End-to-end = `completedAt - createdAt`. Utilisation = total execution time / (workers x batch makespan).
- Each worker runs one job at a time (`prefetch(1)`).

Reproduce:

```bash
docker compose up -d postgres rabbitmq api worker
docker compose restart api                       # clears the in-memory rate limiter
node scripts/benchmark.mjs single-worker 3 18
docker compose up -d --scale worker=3 worker
docker compose restart api
node scripts/benchmark.mjs three-workers 3 18
```

## Results

| Metric | 1 worker | 3 workers |
|---|---|---|
| Samples | 54 | 54 |
| Submission acceptance p50 / p95 | 49 ms / 113 ms | 53 ms / 128 ms |
| Queue wait p50 / p95 | 8.9 s / 18.5 s | 2.8 s / 6.7 s |
| Execution p50 / p95 | 1.09 s / 1.18 s | 1.30 s / 1.37 s |
| End-to-end p50 / p95 | 10.0 s / 19.7 s | 4.1 s / 7.9 s |
| Batch makespan (18 jobs) | 19.7 to 20.5 s | 7.9 to 8.0 s |
| Throughput | 0.90 jobs/s | 2.27 jobs/s |
| Worker utilisation | 0.98 | 0.97 |

## What this shows

- **Acceptance is cheap and independent of execution.** The API answers in about 50 ms (p95 about 130 ms) while jobs are still queued; it never waits for execution.
- **Throughput scaled 2.5x with 3x the workers (about 84% efficiency).** p95 end-to-end latency fell from 19.7 s to 7.9 s. Per-job execution time rose about 20% (1.09 s to 1.30 s), which is contention for the same CPU and the single Docker daemon, so scaling is sub-linear on one machine. Scaling beyond one host was not measured.
- **The bottleneck is fixed per-job overhead, not the program.** The program needs roughly 0.25 s of CPU but a job takes about 1.1 s. The executor spends the rest on roughly ten `docker` CLI invocations per job (create, inspect, image inspect, start, write source, compile check, run, inspect, remove). Both configurations were close to fully utilised (0.97 to 0.98), so the pool was saturated, and adding workers was the only lever in this run.
- **Not measured:** sustained load, Java or C++ (JVM and compiler start-up are much more expensive than Python), larger test-case counts, p99, memory per worker under load, or a multi-host deployment.

## Possible optimisations (not done, not measured)

Reuse a warm container per worker instead of one per job; batch the image-identity inspect calls (they are only needed once per image); skip the `py_compile` step for interpreted languages. Each should be profiled before it is attempted.
