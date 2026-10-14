import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

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

const { data: problems } = await request('/problems');
const problem = problems.find((candidate) => candidate.slug === 'two-sum');
assert.ok(problem, 'The seed problem "two-sum" must be available.');

const sourceCode = `import java.util.*;

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
}`;

const queued = await request('/submissions', {
  method: 'POST',
  token,
  body: JSON.stringify({ problemId: problem.id, language: 'JAVA', sourceCode }),
});
assert.equal(queued.data.status, 'QUEUED');

const result = await waitForSubmission(queued.data.id, token);
assert.equal(result.status, 'ACCEPTED', `Unexpected final result: ${JSON.stringify(result)}`);
assert.deepEqual(
  result.testResults.map(({ status }) => status),
  ['PASSED'],
  'The worker should persist a passing verdict for the seeded test case.',
);
assert.equal(Object.hasOwn(result.testResults[0], 'input'), false);
assert.equal(Object.hasOwn(result.testResults[0], 'expectedOut'), false);

console.info('Worker end-to-end flow passed: submission queued, executed, and result persisted.');
