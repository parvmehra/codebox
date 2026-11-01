// Scheduler checks against a Compose stack: ordering under FIFO vs PRIORITY, and language
// capability matching. It recreates the api and worker containers with different settings.
//   docker compose up -d postgres rabbitmq api worker && node scripts/scheduler-e2e.mjs
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

const compose = (args, env = {}) =>
  execFileSync('docker', ['compose', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
const psql = (sql) =>
  compose([
    'exec',
    '-T',
    'postgres',
    'sh',
    '-c',
    `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "${sql.replaceAll('"', '\\"')}"`,
  ]).trim();

async function until(label, check, timeoutMs = 120_000, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      // services may be restarting
    }
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

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

const apiReady = () =>
  until(
    'API ready',
    async () => (await fetch(`${apiBase.replace(/\/api$/, '')}/health/ready`)).ok,
    120_000,
    1_000,
  );
const workerHealthy = () =>
  until(
    'worker healthy',
    () => compose(['ps', 'worker', '--format', '{{.Status}}']).includes('(healthy)'),
    240_000,
    2_000,
  );

await apiReady();
const email = `scheduler-${randomUUID()}@example.test`;
const registered = await api('/auth/register', {
  method: 'POST',
  body: { email, password: 'Scheduler-E2E-Password-123!' },
});
assert.equal(registered.status, 201, registered.text);
const token = registered.body.token;
psql(`update "User" set role = 'ADMIN' where id = '${registered.body.user.id}'`);

const problem = await api('/problems', {
  method: 'POST',
  token,
  body: {
    slug: `scheduler-e2e-${randomUUID().slice(0, 8)}`,
    title: 'Scheduler output check',
    description: 'Print 0 1.',
    difficulty: 'EASY',
    constraints: 'n/a',
    inputFormat: 'none',
    outputFormat: 'one line',
    examples: [],
    isPublished: true,
  },
});
assert.equal(problem.status, 201, problem.text);
const problemId = problem.body.data.id;
assert.equal(
  (
    await api(`/problems/${problemId}/test-cases`, {
      method: 'POST',
      token,
      body: { input: '', expectedOut: '0 1', isHidden: false },
    })
  ).status,
  201,
);

const submit = async (language, sourceCode, priority = 0) => {
  const response = await api('/submissions', {
    method: 'POST',
    token,
    body: { problemId, language, sourceCode, priority },
  });
  assert.equal(response.status, 202, response.text);
  return response.body.data.id;
};
const status = async (id) => (await api(`/submissions/${id}`, { token })).body.data.status;
const waitTerminal = (id, timeoutMs = 180_000) =>
  until(
    `submission ${id} terminal`,
    async () => {
      const current = await status(id);
      return terminal.has(current) ? current : null;
    },
    timeoutMs,
  );
const startedAtMs = (id) =>
  Number(
    psql(
      `select extract(epoch from min("startedAt")) * 1000 from "Execution" where "submissionId" = '${id}'`,
    ),
  );

const quick = 'print("0 1")';
const results = [];

async function orderingRun(strategy) {
  const name = `${strategy}: queued jobs start in the expected order`;
  try {
    compose(['up', '-d', '--force-recreate', 'api'], { SCHEDULER_STRATEGY: strategy });
    await apiReady();
    compose(['stop', 'worker']);
    // Submitted in this order while no worker exists: low, low, HIGH.
    const first = await submit('PYTHON', quick, 0);
    const second = await submit('PYTHON', quick, 0);
    const third = await submit('PYTHON', quick, 10);
    await delay(3_000); // let the scheduler place all three before any worker can run them
    compose(['start', 'worker']);
    await workerHealthy();
    await Promise.all([first, second, third].map((id) => waitTerminal(id)));
    const order = [first, second, third]
      .map((id, index) => ({
        label: ['first', 'second', 'third(priority 10)'][index],
        at: startedAtMs(id),
      }))
      .sort((a, b) => a.at - b.at)
      .map((item) => item.label);
    console.log(`      ${strategy} start order: ${order.join(' -> ')}`);
    if (strategy === 'FIFO') assert.deepEqual(order, ['first', 'second', 'third(priority 10)']);
    else assert.equal(order[0], 'third(priority 10)', 'the priority job must start first');
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}\n      ${String(error.message).slice(0, 400)}`);
  }
}

await orderingRun('FIFO');
await orderingRun('PRIORITY');

// Capability matching: a worker that only supports PYTHON must never receive a JAVA job.
{
  const name = 'capabilities: a Python-only worker never receives a Java job';
  try {
    compose(['up', '-d', '--force-recreate', 'api'], { SCHEDULER_STRATEGY: 'FIFO' });
    compose(['up', '-d', '--force-recreate', 'worker'], { WORKER_LANGUAGES: 'PYTHON' });
    await apiReady();
    await workerHealthy();
    const javaJob = await submit(
      'JAVA',
      'public class Main { public static void main(String[] a) { System.out.println("0 1"); } }',
    );
    const pythonJob = await submit('PYTHON', quick);
    assert.equal(await waitTerminal(pythonJob), 'ACCEPTED');
    await delay(8_000);
    assert.equal(await status(javaJob), 'QUEUED', 'the Java job must wait for an eligible worker');
    assert.equal(
      Number(psql(`select count(*) from "Execution" where "submissionId" = '${javaJob}'`)),
      0,
    );

    // An eligible worker arrives: the waiting job is then picked up.
    compose(['up', '-d', '--force-recreate', 'worker'], {
      WORKER_LANGUAGES: 'JAVA,PYTHON,CPP,NODEJS',
    });
    await workerHealthy();
    assert.equal(await waitTerminal(javaJob, 240_000), 'ACCEPTED');
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}\n      ${String(error.message).slice(0, 400)}`);
  }
}

// Leave the stack on its defaults.
compose(['up', '-d', '--force-recreate', 'api', 'worker'], {
  SCHEDULER_STRATEGY: 'FIFO',
  WORKER_LANGUAGES: 'JAVA,PYTHON,CPP,NODEJS',
});
console.log('\nSummary');
for (const result of results) console.log(`  ${result.ok ? 'PASS' : 'FAIL'}  ${result.name}`);
process.exit(results.every((result) => result.ok) ? 0 : 1);
