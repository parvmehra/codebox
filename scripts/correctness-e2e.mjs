// Live correctness checks against a running Compose stack (postgres, rabbitmq, api, worker).
//   docker compose up -d postgres rabbitmq api worker && node scripts/correctness-e2e.mjs
// It restarts the worker and waits ~60 s for the submission rate limit window. Use a disposable stack
// with a freshly started API (registration is limited to 5 per hour per IP, in memory).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { io } from 'socket.io-client';

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

async function until(label, check, timeoutMs = 120_000, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      // The dependency under test may be restarting while we poll.
    }
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

async function api(path, { token, method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON body
  }
  return { status: response.status, body: json, text };
}

const password = 'Correctness-E2E-Password-123!';
async function register(label) {
  const email = `${label}-${randomUUID()}@example.test`;
  const response = await api('/auth/register', { method: 'POST', body: { email, password } });
  assert.equal(response.status, 201, response.text);
  return { email, token: response.body.token, id: response.body.user.id };
}

const workerHealthy = () =>
  compose('ps', 'worker', '--format', '{{.Status}}').includes('(healthy)');
const sandboxCount = () =>
  execFileSync('docker', ['ps', '-aq', '--filter', 'name=codebox-exec-'], { encoding: 'utf8' })
    .split(/\s+/)
    .filter(Boolean).length;

const quick = 'print("0 1")';
const slow = 'import time\ntime.sleep(1.7)\nprint("0 1")';

let seedProblemId;
const submitTo = async (token, problemId, sourceCode, extra = {}) => {
  const response = await api('/submissions', {
    method: 'POST',
    token,
    body: { problemId, language: 'PYTHON', sourceCode, ...extra },
  });
  if (response.status === 429) throw new Error('submission rate limit hit: pace the script');
  return response;
};
const detail = async (token, id) => (await api(`/submissions/${id}`, { token })).body?.data;
const statusOf = async (token, id) => (await detail(token, id))?.status;
const waitTerminal = (token, id, timeoutMs = 120_000) =>
  until(
    `submission ${id} terminal`,
    async () => {
      const status = await statusOf(token, id);
      return terminal.has(status) ? status : null;
    },
    timeoutMs,
  );
const executionCount = (id) =>
  Number(psql(`select count(*) from "Execution" where "submissionId" = '${id}'`));

const results = [];
async function scenario(name, run) {
  const startedAt = Date.now();
  try {
    await run();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: String(error.message ?? error).slice(0, 500) });
  }
  const last = results.at(-1);
  console.log(
    `${last.ok ? 'PASS' : 'FAIL'}  ${name} (${Math.round((Date.now() - startedAt) / 1000)}s)${last.error ? `\n      ${last.error}` : ''}`,
  );
}

// ---- setup -------------------------------------------------------------------------------------
await until(
  'API ready',
  async () => (await fetch(`${apiBase.replace(/\/api$/, '')}/health/ready`)).ok,
  120_000,
  1_000,
);
const admin = await register('admin');
const alice = await register('alice');
const bob = await register('bob');
psql(`update "User" set role = 'ADMIN' where id = '${admin.id}'`);

// A private single-test problem keeps this script independent of whatever data the database holds.
const simple = await api('/problems', {
  method: 'POST',
  token: admin.token,
  body: {
    slug: `simple-e2e-${randomUUID().slice(0, 8)}`,
    title: 'Simple output check',
    description: 'Print 0 1.',
    difficulty: 'EASY',
    constraints: 'n/a',
    inputFormat: 'none',
    outputFormat: 'one line',
    examples: [],
    isPublished: true,
  },
});
assert.equal(simple.status, 201, simple.text);
seedProblemId = simple.body.data.id;
assert.equal(
  (
    await api(`/problems/${seedProblemId}/test-cases`, {
      method: 'POST',
      token: admin.token,
      body: { input: '', expectedOut: '0 1', isHidden: false },
    })
  ).status,
  201,
);

const hiddenSecret = `SECRET-hidden-out-${randomUUID()}`;
const created = await api('/problems', {
  method: 'POST',
  token: admin.token,
  body: {
    slug: `hidden-e2e-${randomUUID().slice(0, 8)}`,
    title: 'Hidden case check',
    description: 'Print visible-out-5 for input 5, and the secret for input 7.',
    difficulty: 'EASY',
    constraints: 'n/a',
    inputFormat: 'one integer',
    outputFormat: 'one line',
    examples: [{ input: '5', output: 'visible-out-5' }],
    isPublished: true,
  },
});
assert.equal(created.status, 201, created.text);
const hiddenProblemId = created.body.data.id;
const caseResponses = [];
for (const testCase of [
  { input: '5', expectedOut: 'visible-out-5', isHidden: false },
  { input: '7', expectedOut: hiddenSecret, isHidden: true },
]) {
  const response = await api(`/problems/${hiddenProblemId}/test-cases`, {
    method: 'POST',
    token: admin.token,
    body: testCase,
  });
  assert.equal(response.status, 201, response.text);
  caseResponses.push(response.body.data);
}
const hiddenCaseId = caseResponses[1].id;
const correctHidden = `n = int(input())\nprint("visible-out-5" if n == 5 else "${hiddenSecret}")`;
const wrongHidden = 'n = int(input())\nprint("visible-out-5" if n == 5 else "nope")';

// ---- scenarios ---------------------------------------------------------------------------------
await scenario(
  'validation: bad input is rejected and unauthenticated access is refused',
  async () => {
    assert.equal((await api('/submissions', { method: 'POST', body: {} })).status, 401);
    assert.equal((await submitTo(alice.token, seedProblemId, '')).status, 400);
    assert.equal(
      (
        await api('/submissions', {
          method: 'POST',
          token: alice.token,
          body: { problemId: seedProblemId, language: 'COBOL', sourceCode: 'x' },
        })
      ).status,
      400,
    );
    assert.equal((await submitTo(alice.token, seedProblemId, 'x'.repeat(100_001))).status, 400);
    assert.equal((await submitTo(alice.token, randomUUID(), quick)).status, 404);
    assert.equal((await submitTo(alice.token, 'not-a-uuid', quick)).status, 400);
    assert.equal((await api('/submissions?limit=1000', { token: alice.token })).status, 400);
    assert.equal((await api('/problems?limit=1000')).status, 400);
    const firstPage = await api('/problems?limit=1');
    assert.equal(firstPage.body.data.length, 1);
    assert.ok(
      firstPage.body.nextCursor,
      'a second page must exist (seed problem plus the new one)',
    );
    assert.equal(
      (await api('/problems', { method: 'POST', token: alice.token, body: {} })).status,
      403,
    );
    assert.equal(
      (await api(`/problems/${hiddenProblemId}/test-cases`, { token: alice.token })).status,
      403,
    );
  },
);

let aliceSubmissionId;
await scenario(
  'hidden test cases are never exposed and verdicts are classified correctly',
  async () => {
    const problem = await api(`/problems/${hiddenProblemId}`);
    assert.equal(problem.status, 200);
    assert.ok(
      !problem.text.includes(hiddenSecret),
      'problem details leaked the hidden expected output',
    );
    assert.ok(!('testCases' in problem.body.data));

    const wrong = (await submitTo(alice.token, hiddenProblemId, wrongHidden)).body.data.id;
    assert.equal(await waitTerminal(alice.token, wrong), 'WRONG_ANSWER');
    const wrongDetail = await api(`/submissions/${wrong}`, { token: alice.token });
    assert.ok(
      !wrongDetail.text.includes(hiddenSecret),
      'submission detail leaked the hidden expected output',
    );
    const failed = wrongDetail.body.data.testResults;
    assert.deepEqual(
      failed.map((result) => [result.testIndex, result.status]),
      [
        [1, 'PASSED'],
        [2, 'WRONG_ANSWER'],
      ],
    );
    assert.ok(!(await api('/submissions', { token: alice.token })).text.includes(hiddenSecret));

    const good = (await submitTo(alice.token, hiddenProblemId, correctHidden)).body.data.id;
    assert.equal(await waitTerminal(alice.token, good), 'ACCEPTED');
    aliceSubmissionId = good;

    const compile = (await submitTo(alice.token, hiddenProblemId, 'def (')).body.data.id;
    assert.equal(await waitTerminal(alice.token, compile), 'COMPILATION_ERROR');
    const crash = (await submitTo(alice.token, hiddenProblemId, 'raise SystemExit(3)')).body.data
      .id;
    assert.equal(await waitTerminal(alice.token, crash), 'RUNTIME_ERROR');
  },
);

await scenario(
  "ownership: users cannot see, cancel or rerun each other's submissions",
  async () => {
    assert.equal(
      (await api(`/submissions/${aliceSubmissionId}`, { token: bob.token })).status,
      404,
    );
    assert.equal(
      (await api(`/submissions/${aliceSubmissionId}/cancel`, { method: 'POST', token: bob.token }))
        .status,
      404,
    );
    assert.equal(
      (await api(`/submissions/${aliceSubmissionId}/rerun`, { method: 'POST', token: bob.token }))
        .status,
      404,
    );
    const bobList = await api('/submissions', { token: bob.token });
    assert.ok(
      !bobList.text.includes(aliceSubmissionId),
      "Bob's history contains Alice's submission",
    );
    assert.equal(
      (await api(`/submissions/${aliceSubmissionId}`, { token: alice.token })).status,
      200,
    );

    // Alice's realtime events must not reach Bob.
    const bobEvents = [];
    const bobSocket = io(new URL(apiBase).origin, { auth: { token: bob.token } });
    bobSocket.onAny((type) => bobEvents.push(type));
    await until('Bob socket connected', () => bobSocket.connected, 10_000, 100);
    const id = (await submitTo(alice.token, seedProblemId, quick)).body.data.id;
    await waitTerminal(alice.token, id);
    await delay(500);
    bobSocket.disconnect();
    assert.deepEqual(
      bobEvents.filter((type) => type.startsWith('submission:')),
      [],
    );
  },
);

await scenario(
  'rerun: original is untouched, snapshot is reused, works after a worker restart',
  async () => {
    const before = await detail(alice.token, aliceSubmissionId);
    const originalExecutions = executionCount(aliceSubmissionId);

    // Change the hidden case: new submissions now fail, but a rerun must replay the recorded version.
    const patched = await api(`/problems/${hiddenProblemId}/test-cases/${hiddenCaseId}`, {
      method: 'PATCH',
      token: admin.token,
      body: {
        input: '7',
        expectedOut: 'changed-after-the-fact',
        isHidden: true,
        expectedVersion: 1,
      },
    });
    assert.equal(patched.status, 200, patched.text);
    const fresh = (await submitTo(alice.token, hiddenProblemId, correctHidden)).body.data.id;
    assert.equal(
      await waitTerminal(alice.token, fresh),
      'WRONG_ANSWER',
      'new submissions must use the new case version',
    );

    compose('restart', 'worker');
    await until('worker healthy after restart', workerHealthy, 180_000, 2_000);

    const rerun = await api(`/submissions/${aliceSubmissionId}/rerun`, {
      method: 'POST',
      token: alice.token,
    });
    assert.equal(rerun.status, 202, rerun.text);
    const rerunId = rerun.body.data.id;
    assert.notEqual(rerunId, aliceSubmissionId);
    assert.equal(
      await waitTerminal(alice.token, rerunId),
      'ACCEPTED',
      'rerun must replay the original test case version',
    );

    const after = await detail(alice.token, aliceSubmissionId);
    assert.equal(after.status, before.status);
    assert.equal(
      executionCount(aliceSubmissionId),
      originalExecutions,
      'rerun must not add or rewrite original executions',
    );
    assert.deepEqual(after.executions, before.executions, 'original execution record changed');

    const rerunDetail = await detail(alice.token, rerunId);
    assert.equal(rerunDetail.rerunOfExecutionId, before.executions[0].id);
    const recorded = before.executions[0];
    const replayed = rerunDetail.executions[0];
    assert.equal(replayed.dockerImageId, recorded.dockerImageId);
    assert.equal(replayed.languageVersion, recorded.languageVersion);
    assert.deepEqual(replayed.testCases, recorded.testCases);
    assert.ok(
      recorded.sourceCodeSha256 && recorded.dockerImageId,
      'execution must record source hash and image id',
    );
  },
);

await scenario('cancellation: queued, running, completed, and cancel/complete races', async () => {
  await delay(61_000); // the per-IP submission limit is 20 per minute; earlier scenarios used most of it
  // Queued: no worker is running, so the job cannot have started.
  compose('stop', 'worker');
  const queued = (await submitTo(bob.token, seedProblemId, slow)).body.data.id;
  assert.equal(
    (await api(`/submissions/${queued}/cancel`, { method: 'POST', token: bob.token })).status,
    200,
  );
  compose('start', 'worker');
  await until('worker healthy', workerHealthy, 180_000, 2_000);
  await delay(8_000);
  assert.equal(await statusOf(bob.token, queued), 'CANCELLED');
  assert.equal(executionCount(queued), 0, 'a job cancelled while queued must never execute');

  // Running: cancel mid-execution, then confirm the sandbox is cleaned up and other work still runs.
  const running = (await submitTo(bob.token, seedProblemId, slow)).body.data.id;
  await until(
    'RUNNING',
    async () => (await statusOf(bob.token, running)) === 'RUNNING',
    60_000,
    100,
  );
  assert.equal(
    (await api(`/submissions/${running}/cancel`, { method: 'POST', token: bob.token })).status,
    200,
  );
  await until('sandbox removed after cancel', () => sandboxCount() === 0, 30_000, 500);
  await delay(3_000);
  assert.equal(await statusOf(bob.token, running), 'CANCELLED', 'status must stay CANCELLED');
  const next = (await submitTo(bob.token, seedProblemId, quick)).body.data.id;
  assert.equal(
    await waitTerminal(bob.token, next),
    'ACCEPTED',
    'cancellation must not disturb later work',
  );

  // Completed: cannot be cancelled.
  assert.equal(
    (await api(`/submissions/${next}/cancel`, { method: 'POST', token: bob.token })).status,
    409,
  );

  // Race: cancel while the job is finishing. Either outcome is fine, but it must be stable.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const id = (await submitTo(bob.token, seedProblemId, quick)).body.data.id;
    await delay(200 + attempt * 400);
    const cancel = await api(`/submissions/${id}/cancel`, { method: 'POST', token: bob.token });
    assert.ok([200, 409].includes(cancel.status), `unexpected cancel status ${cancel.status}`);
    const final = await waitTerminal(bob.token, id);
    assert.ok(['ACCEPTED', 'CANCELLED'].includes(final), `unexpected final status ${final}`);
    await delay(2_500);
    assert.equal(await statusOf(bob.token, id), final, 'terminal status changed after the race');
    if (cancel.status === 409) assert.equal(final, 'ACCEPTED');
  }
});

await scenario(
  'concurrency: a burst is neither lost nor duplicated and capacity is respected',
  async () => {
    await delay(61_000); // let the per-IP submission rate-limit window reset
    const total = 15;
    const users = [alice, bob];
    const startedAt = Date.now();
    const accepted = await Promise.all(
      Array.from({ length: total }, async (_, index) => {
        const owner = users[index % users.length];
        const sentAt = performance.now();
        const response = await submitTo(owner.token, seedProblemId, quick);
        return { owner, response, acceptanceMs: performance.now() - sentAt };
      }),
    );
    for (const { response } of accepted) assert.equal(response.status, 202, response.text);

    let maxActive = 0;
    const sampler = setInterval(async () => {
      const status = await api('/workers/status');
      maxActive = Math.max(maxActive, status.body?.data?.activeJobs ?? 0);
    }, 250);
    const finals = await Promise.all(
      accepted.map(({ owner, response }) =>
        waitTerminal(owner.token, response.body.data.id, 240_000),
      ),
    );
    clearInterval(sampler);

    assert.deepEqual([...new Set(finals)], ['ACCEPTED']);
    const ids = accepted.map(({ response }) => response.body.data.id);
    assert.equal(new Set(ids).size, total, 'duplicate submission ids');
    const idList = ids.map((id) => `'${id}'`).join(',');
    assert.equal(
      Number(psql(`select count(*) from "Execution" where "submissionId" in (${idList})`)),
      total,
      'each submission must have exactly one execution',
    );
    assert.equal(
      Number(
        psql(
          `select count(*) from "ExecutionTestResult" r join "Execution" e on e.id = r."executionId" where e."submissionId" in (${idList})`,
        ),
      ),
      total,
      'each execution must have exactly one test result',
    );
    assert.ok(maxActive <= 1, `worker prefetch is 1 but activeJobs reached ${maxActive}`);

    const acceptance = accepted.map((item) => item.acceptanceMs).sort((a, b) => a - b);
    console.log(
      `      ${total} jobs finished in ${Math.round((Date.now() - startedAt) / 1000)}s; POST latency p50=${Math.round(acceptance[Math.floor(total / 2)])}ms max=${Math.round(acceptance.at(-1))}ms; max activeJobs seen=${maxActive}`,
    );
  },
);

console.log('\nSummary');
for (const result of results) console.log(`  ${result.ok ? 'PASS' : 'FAIL'}  ${result.name}`);
process.exit(results.every((result) => result.ok) ? 0 : 1);
