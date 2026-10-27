import { SubmissionStatus, TestResultStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { executeSubmission, type PersistedTestResult } from './docker-executor.js';
import { NODE_22_PROFILE, PYTHON_3_12_PROFILE } from './language-profile.js';

// Runs real Docker containers. Opt in with CODEBOX_DOCKER_TESTS=1 (images must be pullable).
const describeDocker = process.env.CODEBOX_DOCKER_TESTS === '1' ? describe : describe.skip;

type Case = { input: string; expectedOut: string };

async function run(profile: typeof PYTHON_3_12_PROFILE, sourceCode: string, cases: Case[]) {
  const results: PersistedTestResult[] = [];
  const result = await executeSubmission(profile, {
    sourceCode,
    testCases: cases.map((testCase, index) => ({ id: `case-${index}`, ...testCase })),
    onPhase: async () => undefined,
    onTestResult: async (testResult) => {
      results.push(testResult);
    },
  });
  return { result, results };
}

const one: Case[] = [{ input: '', expectedOut: 'ok' }];

describeDocker('sandbox (real Docker)', () => {
  const py = PYTHON_3_12_PROFILE;

  it('accepts a correct program', async () => {
    const { result } = await run(py, 'print("ok")', one);
    expect(result.status).toBe(SubmissionStatus.ACCEPTED);
  });

  it('reports wrong answers and runtime errors separately', async () => {
    expect((await run(py, 'print("no")', one)).result.status).toBe(SubmissionStatus.WRONG_ANSWER);
    expect((await run(py, 'import sys; sys.exit(3)', one)).result.status).toBe(
      SubmissionStatus.RUNTIME_ERROR,
    );
    expect((await run(py, 'raise Exception("x")', one)).result.status).toBe(
      SubmissionStatus.RUNTIME_ERROR,
    );
  });

  it('reports a syntax error as a compilation error', async () => {
    expect((await run(py, 'def (', one)).result.status).toBe(SubmissionStatus.COMPILATION_ERROR);
  });

  it('stops an infinite loop with a time limit', async () => {
    const { result } = await run(py, 'while True: pass', one);
    expect(result.status).toBe(SubmissionStatus.TIME_LIMIT_EXCEEDED);
  }, 60_000);

  it('stops a memory bomb', async () => {
    const { result } = await run(py, 'x = bytearray(2 * 1024**3)\nprint("ok")', one);
    expect([SubmissionStatus.MEMORY_LIMIT_EXCEEDED, SubmissionStatus.RUNTIME_ERROR]).toContain(
      result.status,
    );
    expect(result.status).not.toBe(SubmissionStatus.ACCEPTED);
  }, 60_000);

  it('caps an output flood', async () => {
    const { result, results } = await run(py, 'while True: print("A" * 1000)', one);
    expect(result.status).toBe(SubmissionStatus.RUNTIME_ERROR);
    expect(results[0]?.errorMessage).toMatch(/output/i);
  }, 60_000);

  it('contains a fork bomb', async () => {
    const source = 'import os\nwhile True:\n  try: os.fork()\n  except OSError: pass';
    const { result } = await run(py, source, one);
    expect(result.status).not.toBe(SubmissionStatus.ACCEPTED);
    expect(result.status).not.toBe(SubmissionStatus.SYSTEM_ERROR);
  }, 90_000);

  it('has no network access', async () => {
    const source =
      'import socket\ntry:\n  socket.create_connection(("1.1.1.1", 80), timeout=2)\n  print("net")\nexcept OSError:\n  print("ok")';
    expect((await run(py, source, one)).result.status).toBe(SubmissionStatus.ACCEPTED);
  }, 30_000);

  it('cannot write to the read-only root filesystem', async () => {
    const source =
      'try:\n  open("/etc/pwned","w").write("x")\n  print("wrote")\nexcept OSError:\n  print("ok")';
    expect((await run(py, source, one)).result.status).toBe(SubmissionStatus.ACCEPTED);
  }, 30_000);

  it('does not expose host secrets, the Docker socket or app environment', async () => {
    const source = [
      'import os',
      'bad = os.path.exists("/var/run/docker.sock") or os.path.exists("/app") or "JWT_SECRET" in os.environ or "DATABASE_URL" in os.environ',
      'print("leak" if bad else "ok")',
    ].join('\n');
    expect((await run(py, source, one)).result.status).toBe(SubmissionStatus.ACCEPTED);
  }, 30_000);

  it('runs as an unprivileged user', async () => {
    const { result } = await run(
      py,
      'import os\nprint("ok" if os.getuid() == 65534 else "root")',
      one,
    );
    expect(result.status).toBe(SubmissionStatus.ACCEPTED);
  }, 30_000);

  it('removes the container afterwards', async () => {
    await run(py, 'print("ok")', one);
    const { execFileSync } = await import('node:child_process');
    const leftover = execFileSync('docker', ['ps', '-aq', '--filter', 'name=codebox-exec-'], {
      encoding: 'utf8',
    });
    expect(leftover.trim()).toBe('');
  }, 30_000);

  it('does not let one test case leave state for the next (F-05)', async () => {
    const source = [
      'import os, subprocess, sys',
      'mode = sys.stdin.read().strip()',
      'flag = "/tmp/flag"',
      'if mode == "write":',
      '  open(flag, "w").write("x")',
      '  subprocess.Popen(["sleep", "600"], start_new_session=True)',
      '  print("ok")',
      'else:',
      '  n = sum(1 for p in os.listdir("/proc") if p.isdigit() and "600" in open(f"/proc/{p}/cmdline").read())',
      '  print("leak" if os.path.exists(flag) or n else "ok")',
    ].join('\n');
    const { result } = await run(py, source, [
      { input: 'write', expectedOut: 'ok' },
      { input: 'read', expectedOut: 'ok' },
    ]);
    expect(result.status).toBe(SubmissionStatus.ACCEPTED);
  }, 60_000);

  it('runs Node.js programs', async () => {
    const { result } = await run(NODE_22_PROFILE, 'console.log("ok")', one);
    expect(result.status).toBe(SubmissionStatus.ACCEPTED);
    const tle = await run(NODE_22_PROFILE, 'while(true){}', one);
    expect(tle.result.status).toBe(SubmissionStatus.TIME_LIMIT_EXCEEDED);
    expect(TestResultStatus.TIME_LIMIT_EXCEEDED).toBe('TIME_LIMIT_EXCEEDED');
  }, 90_000);
});
