// Failure-recovery checks against a running Compose stack (postgres, rabbitmq, api, worker).
// It stops and kills services on purpose: run it only against a disposable local stack.
//   docker compose up -d postgres rabbitmq api worker && node scripts/recovery-e2e.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

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

async function until(label, check, timeoutMs = 180_000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await check();
      if (last) return last;
    } catch {
      // The dependency under test may be down while we poll.
    }
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

async function api(path, { token, method = 'GET', body, timeoutMs = 20_000 } = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

const waitReady = () =>
  until(
    'API ready',
    async () => (await fetch(`${apiBase.replace(/\/api$/, '')}/health/ready`)).ok,
    120_000,
    1_000,
  );
const waitWorkerHealthy = () =>
  until(
    'worker healthy',
    () => compose('ps', 'worker', '--format', '{{.Status}}').includes('(healthy)'),
    300_000,
    2_000,
  );

const slowPython = `import time
time.sleep(1.7)
print("0 1")`;
const quickPython = 'print("0 1")';

async function setup() {
  await waitReady();
  const email = `recovery-${randomUUID()}@example.test`;
  const registered = await api('/auth/register', {
    method: 'POST',
    body: { email, password: 'Recovery-E2E-Password-123!' },
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const { data: problems } = (await api('/problems')).body;
  const problem = problems.find((candidate) => candidate.slug === 'two-sum');
  assert.ok(problem, 'seed problem two-sum is required');
  return { token: registered.body.token, problemId: problem.id };
}

const ctx = await setup();

const submit = (sourceCode, extra = {}) =>
  api('/submissions', {
    method: 'POST',
    token: ctx.token,
    body: { problemId: ctx.problemId, language: 'PYTHON', sourceCode, ...extra },
  });
const status = async (id) =>
  (await api(`/submissions/${id}`, { token: ctx.token })).body.data.status;
const waitTerminal = (id, timeoutMs) =>
  until(
    `submission ${id} terminal`,
    async () => {
      const current = await status(id);
      return terminal.has(current) ? current : null;
    },
    timeoutMs,
  );
const rows = (table, id) =>
  Number(psql(`select count(*) from "${table}" where "submissionId" = '${id}'`));
const execCount = (id) => rows('Execution', id);
const sandboxes = () =>
  compose('exec', '-T', 'worker', 'docker', 'ps', '-aq', '--filter', 'name=codebox-exec-').trim();
const killSandboxes = () => {
  try {
    execFileSync(
      'docker',
      [
        'rm',
        '-f',
        ...execFileSync('docker', ['ps', '-aq', '--filter', 'name=codebox-exec-'], {
          encoding: 'utf8',
        })
          .split(/\s+/)
          .filter(Boolean),
      ],
      { stdio: 'ignore' },
    );
  } catch {
    // none to remove
  }
};

const results = [];
// RECOVERY_ONLY="^C.|^D." runs a subset of scenarios.
const only = process.env.RECOVERY_ONLY ? new RegExp(process.env.RECOVERY_ONLY) : null;
async function scenario(name, run) {
  if (only && !only.test(name)) return;
  const startedAt = Date.now();
  try {
    await run();
    results.push({ name, ok: true, seconds: Math.round((Date.now() - startedAt) / 1000) });
  } catch (error) {
    results.push({
      name,
      ok: false,
      seconds: Math.round((Date.now() - startedAt) / 1000),
      error: String(error.message ?? error).slice(0, 400),
    });
  }
  const last = results.at(-1);
  console.log(
    `${last.ok ? 'PASS' : 'FAIL'}  ${name} (${last.seconds}s)${last.error ? `\n      ${last.error}` : ''}`,
  );
}

await scenario('F. duplicate delivery produces one logical result', async () => {
  const { body } = await submit(quickPython);
  const id = body.data.id;
  assert.equal(await waitTerminal(id, 120_000), 'ACCEPTED');
  const before = { executions: execCount(id), results: rows('Execution', id) };
  // Re-deliver the same job twice, as a broker would after a lost ack.
  for (let i = 0; i < 2; i += 1) {
    compose(
      'exec',
      '-T',
      'api',
      'node',
      '--input-type=module',
      '-e',
      `import { publishSubmission } from '/app/server/dist/queue/submissions.js'; await publishSubmission('${id}', 0); process.exit(0);`,
    );
  }
  await delay(8_000);
  assert.equal(await status(id), 'ACCEPTED');
  assert.equal(
    execCount(id),
    before.executions,
    'duplicate delivery must not create another execution',
  );
  const testResults = Number(
    psql(
      `select count(*) from "ExecutionTestResult" r join "Execution" e on e.id = r."executionId" where e."submissionId" = '${id}'`,
    ),
  );
  assert.equal(testResults, 1, 'exactly one test result row for the single test case');
});

await scenario('E. row stranded before publish is recovered (F-02)', async () => {
  const id = randomUUID();
  const userId = psql(`select id from "User" order by "createdAt" desc limit 1`);
  psql(
    `insert into "Submission" (id, "userId", "problemId", language, "sourceCode", status, "needsDispatch", "lastEnqueuedAt", "updatedAt") values ('${id}', '${userId}', '${ctx.problemId}', 'PYTHON', '${quickPython}', 'QUEUED', true, now() - interval '1 minute', now())`,
  );
  assert.equal(await waitTerminal(id, 120_000), 'ACCEPTED');
});

await scenario(
  'B. job submitted while no worker is running completes after worker starts',
  async () => {
    compose('stop', 'worker');
    const { status: code, body } = await submit(quickPython);
    assert.equal(code, 202);
    const id = body.data.id;
    await delay(5_000);
    assert.ok(
      ['QUEUED'].includes(await status(id)),
      'job must wait in QUEUED while no worker exists',
    );
    compose('start', 'worker');
    await waitWorkerHealthy();
    assert.equal(await waitTerminal(id, 180_000), 'ACCEPTED');
    assert.equal(execCount(id), 1);
  },
);

await scenario('A. worker killed mid-run: job is recovered and finishes once', async () => {
  const { body } = await submit(slowPython);
  const id = body.data.id;
  await until('RUNNING', async () => (await status(id)) === 'RUNNING', 60_000, 100);
  compose('kill', 'worker');
  const orphansAfterKill = execFileSync('docker', ['ps', '-aq', '--filter', 'name=codebox-exec-'], {
    encoding: 'utf8',
  }).trim();
  compose('start', 'worker');
  await waitWorkerHealthy();
  const final = await waitTerminal(id, 240_000);
  const attempts = execCount(id);
  const open = Number(
    psql(
      `select count(*) from "Execution" where "submissionId" = '${id}' and "completedAt" is null`,
    ),
  );
  // The reaper removes sandboxes once their worker has missed heartbeats (45 s TTL, 30 s sweep).
  const orphansNow = await until(
    'orphaned sandbox removed',
    () => {
      const left = execFileSync('docker', ['ps', '-aq', '--filter', 'name=codebox-exec-'], {
        encoding: 'utf8',
      }).trim();
      return left === '' ? 'none' : null;
    },
    150_000,
    3_000,
  ).then(() => '');
  console.log(
    `      final=${final} attempts=${attempts} openExecutions=${open} orphansAfterKill=${orphansAfterKill ? orphansAfterKill.split(/\s+/).length : 0} orphansAtEnd=${orphansNow ? orphansNow.split(/\s+/).length : 0}`,
  );
  assert.equal(final, 'ACCEPTED');
  assert.ok(attempts >= 2, 'a second attempt must have been recorded');
  assert.equal(open, 0, 'no execution may stay open after the submission finished');
  assert.equal(orphansNow, '', 'killed worker must not leave sandbox containers behind');
});
killSandboxes();

await scenario('C. RabbitMQ outage: submissions fail fast and service recovers', async () => {
  compose('stop', 'rabbitmq');
  const startedAt = Date.now();
  const outage = await submit(quickPython, {}).catch((error) => ({
    status: 0,
    body: String(error),
  }));
  console.log(
    `      during outage: HTTP ${outage.status} after ${Math.round((Date.now() - startedAt) / 1000)}s`,
  );
  assert.ok([202, 503].includes(outage.status), `unexpected status ${outage.status}`);
  const outageId = outage.body?.submissionId ?? outage.body?.data?.id;
  compose('start', 'rabbitmq');
  await until(
    'RabbitMQ healthy',
    () => compose('ps', 'rabbitmq', '--format', '{{.Status}}').includes('(healthy)'),
    120_000,
    2_000,
  );
  await waitReady();
  await waitWorkerHealthy();
  const after = await until(
    'new submission accepted after recovery',
    async () => {
      const response = await submit(quickPython);
      return response.status === 202 ? response : null;
    },
    120_000,
    3_000,
  );
  assert.equal(await waitTerminal(after.body.data.id, 180_000), 'ACCEPTED');
  if (outageId) {
    const outageFinal = await status(outageId);
    console.log(`      outage submission ended as ${outageFinal}`);
    assert.ok(
      terminal.has(outageFinal) || outageFinal === 'QUEUED',
      'outage submission must not be stuck mid-flight',
    );
  }
});

await scenario('D. PostgreSQL outage: requests fail cleanly and service recovers', async () => {
  compose('stop', 'postgres');
  const outage = await api('/problems', { timeoutMs: 30_000 }).catch((error) => ({
    status: 0,
    body: String(error),
  }));
  console.log(`      during outage: GET /problems -> HTTP ${outage.status}`);
  assert.ok(outage.status >= 500 || outage.status === 0, 'must not succeed without a database');
  const ready = await fetch(`${apiBase.replace(/\/api$/, '')}/health/ready`).catch(() => null);
  assert.ok(
    !ready || ready.status === 503,
    'readiness must report not ready while the database is down',
  );
  compose('start', 'postgres');
  await until(
    'postgres healthy',
    () => compose('ps', 'postgres', '--format', '{{.Status}}').includes('(healthy)'),
    120_000,
    2_000,
  );
  await waitReady();
  const { status: code, body } = await until(
    'submission accepted after DB recovery',
    async () => {
      const response = await submit(quickPython);
      return response.status === 202 ? response : null;
    },
    120_000,
    3_000,
  );
  assert.equal(code, 202);
  assert.equal(await waitTerminal(body.data.id, 180_000), 'ACCEPTED');
});

console.log('\nSummary');
for (const result of results) console.log(`  ${result.ok ? 'PASS' : 'FAIL'}  ${result.name}`);
process.exit(results.every((result) => result.ok) ? 0 : 1);
