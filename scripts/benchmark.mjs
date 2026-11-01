// Controlled throughput benchmark. It measures; it does not tune.
//   node scripts/benchmark.mjs <label> [batches=3] [jobsPerBatch=18]
// Run against a stack with the worker count you want to measure (docker compose up -d --scale worker=N).
// Submissions are limited to 20 per minute per IP, so jobs are sent in batches with a pause between
// them; every batch is a burst of simultaneous submissions to a worker pool that starts idle.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const label = process.argv[2] ?? 'run';
const batches = Number(process.argv[3] ?? 3);
const jobsPerBatch = Number(process.argv[4] ?? 18);
const apiBase = process.env.API_BASE_URL ?? 'http://127.0.0.1:4000/api';
const terminal = new Set([
  'ACCEPTED',
  'WRONG_ANSWER',
  'TIME_LIMIT_EXCEEDED',
  'MEMORY_LIMIT_EXCEEDED',
  'COMPILATION_ERROR',
  'RUNTIME_ERROR',
  'SYSTEM_ERROR',
  'CANCELLED',
]);

const compose = (...args) =>
  execFileSync('docker', ['compose', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const psql = (sql) =>
  compose(
    'exec',
    '-T',
    'postgres',
    'sh',
    '-c',
    `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "${sql.replaceAll('"', '\\"')}"`,
  ).trim();

async function api(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, text };
}

const workerCount = compose('ps', 'worker', '--format', '{{.Service}}')
  .trim()
  .split('\n')
  .filter(Boolean).length;
const registered = await api('/auth/register', {
  method: 'POST',
  body: { email: `bench-${randomUUID()}@example.test`, password: 'Benchmark-Password-123!' },
});
assert.equal(registered.status, 201, registered.text);
const token = registered.body.token;
psql(`update "User" set role = 'ADMIN' where id = '${registered.body.user.id}'`);
const problem = await api('/problems', {
  method: 'POST',
  token,
  body: {
    slug: `bench-${randomUUID().slice(0, 8)}`,
    title: 'Benchmark workload',
    description: 'Print 0 1.',
    difficulty: 'EASY',
    constraints: 'n/a',
    inputFormat: 'none',
    outputFormat: 'one line',
    examples: [],
    isPublished: true,
  },
});
const problemId = problem.body.data.id;
await api(`/problems/${problemId}/test-cases`, {
  method: 'POST',
  token,
  body: { input: '', expectedOut: '0 1', isHidden: false },
});

// A fixed ~0.2-0.3 s CPU workload so execution time is not dominated by process start-up alone.
const workload = 'total = 0\nfor i in range(3_000_000):\n    total += i\nprint("0 1")';

const percentile = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const ms = (value) => Math.round(value);
const all = { accept: [], wait: [], exec: [], endToEnd: [] };
const batchSummaries = [];

for (let batch = 0; batch < batches; batch += 1) {
  if (batch > 0) await delay(61_000); // per-IP submission limit window
  const wallStart = Date.now();
  const sent = await Promise.all(
    Array.from({ length: jobsPerBatch }, async () => {
      const at = performance.now();
      const response = await api('/submissions', {
        method: 'POST',
        token,
        body: { problemId, language: 'PYTHON', sourceCode: workload },
      });
      assert.equal(response.status, 202, response.text);
      return { id: response.body.data.id, acceptMs: performance.now() - at };
    }),
  );
  const ids = sent.map((item) => `'${item.id}'`).join(',');
  const deadline = Date.now() + 600_000;
  for (;;) {
    const done = Number(
      psql(
        `select count(*) from "Submission" where id in (${ids}) and status in ('ACCEPTED','WRONG_ANSWER','RUNTIME_ERROR','TIME_LIMIT_EXCEEDED','MEMORY_LIMIT_EXCEEDED','COMPILATION_ERROR','SYSTEM_ERROR','CANCELLED')`,
      ),
    );
    if (done === jobsPerBatch) break;
    assert.ok(Date.now() < deadline, 'batch did not finish');
    await delay(500);
  }
  const rows = psql(
    `select extract(epoch from (e."startedAt" - s."createdAt")) * 1000, extract(epoch from (e."completedAt" - e."startedAt")) * 1000, extract(epoch from (e."completedAt" - s."createdAt")) * 1000, s.status, extract(epoch from s."createdAt") * 1000, extract(epoch from e."completedAt") * 1000 from "Submission" s join "Execution" e on e."submissionId" = s.id where s.id in (${ids})`,
  )
    .split('\n')
    .map((line) => line.split('|'));
  assert.equal(rows.length, jobsPerBatch, 'each submission must have exactly one execution');
  assert.ok(
    rows.every((row) => row[3] === 'ACCEPTED'),
    'every benchmark job must be ACCEPTED',
  );
  const wait = rows.map((row) => Number(row[0]));
  const exec = rows.map((row) => Number(row[1]));
  const endToEnd = rows.map((row) => Number(row[2]));
  const makespanMs =
    Math.max(...rows.map((row) => Number(row[5]))) - Math.min(...rows.map((row) => Number(row[4])));
  all.accept.push(...sent.map((item) => item.acceptMs));
  all.wait.push(...wait);
  all.exec.push(...exec);
  all.endToEnd.push(...endToEnd);
  batchSummaries.push({
    batch: batch + 1,
    makespanSeconds: +(makespanMs / 1000).toFixed(1),
    throughputJobsPerSecond: +(jobsPerBatch / (makespanMs / 1000)).toFixed(2),
    utilisation: +(exec.reduce((a, b) => a + b, 0) / (workerCount * makespanMs)).toFixed(2),
  });
  console.log(
    `batch ${batch + 1}/${batches}: ${jobsPerBatch} jobs in ${(makespanMs / 1000).toFixed(1)} s`,
  );
}

const summarise = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: ms(percentile(sorted, 50)),
    p95: ms(percentile(sorted, 95)),
    max: ms(sorted.at(-1)),
  };
};
const meanOf = (key) =>
  +(batchSummaries.reduce((sum, item) => sum + item[key], 0) / batchSummaries.length).toFixed(2);
const report = {
  label,
  workers: workerCount,
  samples: all.endToEnd.length,
  jobsPerBatch,
  batches,
  acceptanceMs: summarise(all.accept),
  queueWaitMs: summarise(all.wait),
  executionMs: summarise(all.exec),
  endToEndMs: summarise(all.endToEnd),
  meanThroughputJobsPerSecond: meanOf('throughputJobsPerSecond'),
  meanWorkerUtilisation: meanOf('utilisation'),
  batchSummaries,
};
console.log(JSON.stringify(report, null, 2));
