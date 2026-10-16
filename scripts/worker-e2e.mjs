import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';

const apiBase = process.env.API_BASE_URL ?? 'http://127.0.0.1:4000/api';
const healthUrl = new URL('/health', apiBase).toString();
const terminalStatuses = new Set([
  'ACCEPTED',
  'WRONG_ANSWER',
  'TIME_LIMIT_EXCEEDED',
  'MEMORY_LIMIT_EXCEEDED',
  'COMPILATION_ERROR',
  'RUNTIME_ERROR',
  'SYSTEM_ERROR',
  'CANCELLED',
]);

async function waitForApi(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) return;
    } catch {
      // The API container may still be applying its database migrations.
    }
    await delay(1_000);
  }
  throw new Error(`The API did not become healthy within ${timeoutMs} ms.`);
}

async function request(path, { token, ...options } = {}) {
  const relativePath = path.replace(/^\/+/, '');
  const response = await fetch(new URL(relativePath, `${apiBase.replace(/\/$/, '')}/`), {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const body = await response.json();
  assert.equal(
    response.ok,
    true,
    `${options.method ?? 'GET'} ${path} failed: ${JSON.stringify(body)}`,
  );
  return body;
}

async function waitForSubmission(submissionId, token, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await request(`/submissions/${submissionId}`, { token });
    if (terminalStatuses.has(data.status)) return data;
    await delay(1_000);
  }
  throw new Error(`Submission ${submissionId} did not finish within ${timeoutMs} ms.`);
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function connectSocket(token) {
  const socket = io(new URL(apiBase).origin, { auth: { token }, timeout: 15_000 });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return socket;
}

async function isSocketRejected(token) {
  const socket = io(new URL(apiBase).origin, {
    auth: { token },
    reconnection: false,
    timeout: 5_000,
  });
  const rejected = await new Promise((resolve) => {
    socket.once('connect', () => resolve(false));
    socket.once('connect_error', () => resolve(true));
  });
  socket.disconnect();
  return rejected;
}

await waitForApi();

const account = await request('/auth/register', {
  method: 'POST',
  body: JSON.stringify({
    email: `worker-e2e-${randomUUID()}@example.test`,
    password: 'Worker-E2E-Password-123!',
  }),
});
const token = account.token;
assert.equal(typeof token, 'string');
assert.equal(await isSocketRejected('invalid-e2e-token'), true, 'Socket.IO must require a JWT.');
const otherAccount = await request('/auth/register', {
  method: 'POST',
  body: JSON.stringify({
    email: `worker-e2e-other-${randomUUID()}@example.test`,
    password: 'Worker-E2E-Password-123!',
  }),
});
const socket = await connectSocket(token);
const otherSocket = await connectSocket(otherAccount.token);
const submissionEvents = [];
const otherUserEvents = [];
socket.onAny((type, payload) => {
  if (type.startsWith('submission:')) submissionEvents.push({ type, ...payload });
});
otherSocket.onAny((type, payload) => {
  if (type.startsWith('submission:')) otherUserEvents.push({ type, ...payload });
});

const { data: problems } = await request('/problems');
const problem = problems.find((candidate) => candidate.slug === 'two-sum');
assert.ok(problem, 'The seed problem "two-sum" must be available.');

const solutions = [
  {
    language: 'JAVA',
    sourceCode: `import java.util.*;

public class Main {
    public static void main(String[] args) {
        Scanner scanner = new Scanner(System.in);
        int count = scanner.nextInt();
        int[] values = new int[count];
        for (int i = 0; i < count; i++) values[i] = scanner.nextInt();
        int target = scanner.nextInt();
        for (int i = 0; i < count; i++) {
            for (int j = i + 1; j < count; j++) {
                if (values[i] + values[j] == target) {
                    System.out.println(i + " " + j);
                    return;
                }
            }
        }
    }
}`,
  },
  {
    language: 'PYTHON',
    sourceCode: `import sys

values = list(map(int, sys.stdin.read().split()))
count = values[0]
numbers = values[1:count + 1]
target = values[count + 1]

for i in range(count):
    for j in range(i + 1, count):
        if numbers[i] + numbers[j] == target:
            print(i, j)
            raise SystemExit
`,
  },
  {
    language: 'CPP',
    sourceCode: `#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    int count;
    cin >> count;
    vector<int> numbers(count);
    for (int& number : numbers) cin >> number;
    int target;
    cin >> target;
    for (int i = 0; i < count; ++i) {
        for (int j = i + 1; j < count; ++j) {
            if (numbers[i] + numbers[j] == target) {
                cout << i << " " << j << "\\n";
                return 0;
            }
        }
    }
}`,
  },
  {
    language: 'NODEJS',
    sourceCode: `const fs = require('node:fs');
const values = fs.readFileSync(0, 'utf8').trim().split(/\\s+/).map(Number);
const count = values[0];
const numbers = values.slice(1, count + 1);
const target = values[count + 1];

for (let i = 0; i < count; i++) {
  for (let j = i + 1; j < count; j++) {
    if (numbers[i] + numbers[j] === target) {
      console.log(i, j);
      process.exit(0);
    }
  }
}`,
  },
];

try {
  for (const { language, sourceCode } of solutions) {
    const queued = await request('/submissions', {
      method: 'POST',
      token,
      body: JSON.stringify({ problemId: problem.id, language, sourceCode }),
    });
    assert.equal(queued.data.status, 'QUEUED');

    const result = await waitForSubmission(queued.data.id, token);
    assert.equal(
      result.status,
      'ACCEPTED',
      'Unexpected final result for ' + language + ': ' + JSON.stringify(result),
    );
    assert.deepEqual(
      result.testResults.map(({ status }) => status),
      ['PASSED'],
      'The ' + language + ' worker should persist a passing verdict for the seeded test case.',
    );
    assert.equal(Object.hasOwn(result.testResults[0], 'input'), false);
    assert.equal(Object.hasOwn(result.testResults[0], 'expectedOut'), false);

    const deadline = Date.now() + 5_000;
    while (
      Date.now() < deadline &&
      !submissionEvents.some(
        (event) => event.submissionId === queued.data.id && event.type === 'submission:completed',
      )
    ) {
      await delay(50);
    }
    const events = submissionEvents.filter((event) => event.submissionId === queued.data.id);
    assert.deepEqual(
      events.map(({ type }) => type),
      [
        'submission:queued',
        'submission:assigned',
        'submission:starting',
        'submission:compiling',
        'submission:running',
        'submission:test-progress',
        'submission:completed',
      ],
      'The owner should receive the ordered lifecycle and test progress events.',
    );
    for (const event of events) {
      assert.equal(Object.hasOwn(event, 'userId'), false);
      assert.equal(Object.hasOwn(event, 'input'), false);
      assert.equal(Object.hasOwn(event, 'expectedOut'), false);
      assert.equal(Object.hasOwn(event, 'sourceCode'), false);
    }
  }

  await delay(250);
  assert.deepEqual(otherUserEvents, [], 'Another user must not receive submission events.');
  const { data: workerStatus } = await request('/workers/status');
  assert.equal(workerStatus.status, 'online');
  assert.ok(workerStatus.workerCount >= 1);
} finally {
  socket.disconnect();
  otherSocket.disconnect();
}

console.info('Worker and Socket.IO end-to-end flow passed for Java, Python, C++, and Node.js.');
