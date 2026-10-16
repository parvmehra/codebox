import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { SubmissionStatus, TestResultStatus } from '@prisma/client';
import { JAVA_21_PROFILE, type LanguageProfile, withTimeout } from './language-profile.js';

const INTERNAL_OUTPUT_LIMIT_BYTES = 64_000;
const ERROR_MESSAGE_LIMIT = 4_000;
const IMAGE_PULL_TIMEOUT_MS = 10 * 60 * 1_000;

export type ExecutionTestCase = {
  id: string;
  input: string;
  expectedOut: string;
};

export type PersistedTestResult = {
  testCaseId: string;
  testIndex: number;
  status: TestResultStatus;
  executionTimeMs: number;
  errorMessage: string | null;
};

export type JavaExecutionResult = {
  status: SubmissionStatus;
  executionTimeMs: number | null;
  memoryUsedKb: number | null;
  errorMessage: string | null;
};

export type ExecuteJavaSubmissionOptions = {
  sourceCode: string;
  testCases: ExecutionTestCase[];
  onPhase: (status: Extract<SubmissionStatus, 'COMPILING' | 'RUNNING'>) => Promise<void>;
  onTestResult: (result: PersistedTestResult) => Promise<void>;
};

type DockerCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  outputLimitExceeded: boolean;
};

type DockerCommandOptions = {
  input?: string;
  timeoutMs: number;
  outputLimitBytes?: number;
  containerId?: string;
};

export class DockerCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DockerCommandError';
  }
}

export class DockerCommandTimeoutError extends DockerCommandError {
  constructor(command: string) {
    super(`Docker command exceeded its ${command} watchdog.`);
    this.name = 'DockerCommandTimeoutError';
  }
}

export class SourceSizeLimitError extends Error {
  constructor() {
    super(`Source code exceeds the ${JAVA_21_PROFILE.sourceLimitBytes}-byte limit.`);
    this.name = 'SourceSizeLimitError';
  }
}

export function buildSandboxCreateArgs(containerName: string, profile: LanguageProfile): string[] {
  return [
    'create',
    '--name',
    containerName,
    '--network',
    profile.networkPolicy,
    '--memory',
    `${profile.memoryLimitMb}m`,
    '--memory-swap',
    `${profile.memoryLimitMb}m`,
    '--cpus',
    '1',
    '--pids-limit',
    String(profile.pidsLimit),
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--user',
    '65534:65534',
    '--workdir',
    '/workspace',
    '--env',
    'HOME=/tmp',
    '--env',
    'TMPDIR=/tmp',
    '--tmpfs',
    '/workspace:rw,noexec,nosuid,nodev,size=64m,uid=65534,gid=65534',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=16m,uid=65534,gid=65534',
    '--entrypoint',
    '/usr/bin/sleep',
    profile.dockerImage,
    'infinity',
  ];
}

export function normalizeOutput(output: string): string {
  const trimmed = output.replace(/\r\n/g, '\n').trim();
  return trimmed ? trimmed.split(/\s+/).join(' ') : '';
}

export async function ensureJavaImage(): Promise<void> {
  const profile = JAVA_21_PROFILE;
  const inspect = await runDocker(['image', 'inspect', profile.dockerImage], {
    timeoutMs: 15_000,
  });
  if (inspect.exitCode === 0) return;

  console.info({ image: profile.dockerImage }, 'Pulling Java execution image');
  const pull = await runDocker(['pull', '--quiet', profile.dockerImage], {
    timeoutMs: IMAGE_PULL_TIMEOUT_MS,
  });
  requireDockerSuccess(pull, 'pull Java execution image');
  console.info({ image: profile.dockerImage }, 'Java execution image is ready');
}

export async function executeJavaSubmission(
  options: ExecuteJavaSubmissionOptions,
): Promise<JavaExecutionResult> {
  const profile = JAVA_21_PROFILE;
  if (Buffer.byteLength(options.sourceCode, 'utf8') > profile.sourceLimitBytes) {
    throw new SourceSizeLimitError();
  }

  const containerName = `codebox-exec-${randomUUID()}`;
  let containerId: string | undefined;

  try {
    const create = await runDocker(buildSandboxCreateArgs(containerName, profile), {
      timeoutMs: 30_000,
    });
    requireDockerSuccess(create, 'create isolated execution container');
    containerId = create.stdout.trim();
    if (!containerId)
      throw new DockerCommandError('Docker did not return the execution container ID.');

    const start = await runDocker(['start', containerId], { timeoutMs: 30_000 });
    requireDockerSuccess(start, 'start isolated execution container');

    const writeSource = await runDocker(
      ['exec', '-i', containerId, 'sh', '-c', `cat > /workspace/${profile.sourceFileName}`],
      { input: options.sourceCode, timeoutMs: 30_000 },
    );
    requireDockerSuccess(writeSource, 'write source into isolated execution container');

    await options.onPhase(SubmissionStatus.COMPILING);
    const compile = await runDocker(
      ['exec', containerId, ...withTimeout(profile.compileCommand, profile.compileLimitMs)],
      {
        timeoutMs: profile.compileLimitMs + 10_000,
        outputLimitBytes: profile.outputLimitBytes,
        containerId,
      },
    );

    if (compile.outputLimitExceeded) {
      return completedResult(
        SubmissionStatus.COMPILATION_ERROR,
        null,
        'Compiler output exceeded the configured output limit.',
      );
    }
    if (compile.exitCode === 124 || compile.exitCode === 137) {
      const outOfMemory = await containerWasOutOfMemoryKilled(containerId);
      return completedResult(
        outOfMemory ? SubmissionStatus.MEMORY_LIMIT_EXCEEDED : SubmissionStatus.TIME_LIMIT_EXCEEDED,
        null,
        outOfMemory
          ? 'The compiler exceeded the memory limit.'
          : 'Compilation exceeded its time limit.',
      );
    }
    if (compile.exitCode !== 0) {
      if (compile.exitCode >= 125 && compile.exitCode <= 127) {
        throw commandExecutionError('run Java compiler', compile);
      }
      return completedResult(
        SubmissionStatus.COMPILATION_ERROR,
        null,
        limitMessage(compile.stderr || compile.stdout) || 'The source code did not compile.',
      );
    }

    await options.onPhase(SubmissionStatus.RUNNING);
    let totalExecutionTimeMs = 0;

    for (const [index, testCase] of options.testCases.entries()) {
      const startedAt = performance.now();
      const run = await runDocker(
        ['exec', '-i', containerId, ...withTimeout(profile.runCommand, profile.timeLimitMs)],
        {
          input: testCase.input,
          timeoutMs: profile.timeLimitMs + 10_000,
          outputLimitBytes: profile.outputLimitBytes,
          containerId,
        },
      );
      const executionTimeMs = Math.max(0, Math.round(performance.now() - startedAt));
      totalExecutionTimeMs += executionTimeMs;

      let status: TestResultStatus;
      let errorMessage: string | null = null;
      if (run.outputLimitExceeded) {
        status = TestResultStatus.RUNTIME_ERROR;
        errorMessage = 'Program output exceeded the configured output limit.';
      } else if (run.exitCode === 124 || run.exitCode === 137) {
        const outOfMemory = await containerWasOutOfMemoryKilled(containerId);
        status = outOfMemory
          ? TestResultStatus.MEMORY_LIMIT_EXCEEDED
          : TestResultStatus.TIME_LIMIT_EXCEEDED;
        errorMessage = outOfMemory
          ? 'The program exceeded the memory limit.'
          : `The program exceeded its ${profile.timeLimitMs} ms time limit.`;
      } else if (run.exitCode !== 0) {
        if (run.exitCode >= 125 && run.exitCode <= 127) {
          throw commandExecutionError('run submitted Java program', run);
        }
        status = TestResultStatus.RUNTIME_ERROR;
        errorMessage = 'The program exited with a runtime error.';
      } else if (normalizeOutput(run.stdout) !== normalizeOutput(testCase.expectedOut)) {
        status = TestResultStatus.WRONG_ANSWER;
      } else {
        status = TestResultStatus.PASSED;
      }

      await options.onTestResult({
        testCaseId: testCase.id,
        testIndex: index + 1,
        status,
        executionTimeMs,
        errorMessage,
      });

      if (status !== TestResultStatus.PASSED) {
        return completedResult(toSubmissionStatus(status), totalExecutionTimeMs, errorMessage);
      }
    }

    return completedResult(SubmissionStatus.ACCEPTED, totalExecutionTimeMs, null);
  } finally {
    try {
      if (containerId) {
        const cleanup = await runDocker(['rm', '--force', containerId], { timeoutMs: 15_000 });
        if (cleanup.exitCode !== 0) {
          console.error(
            { containerId, error: cleanup.stderr },
            'Could not remove execution container',
          );
        }
      }
    } catch (error) {
      console.error({ containerId, error }, 'Could not clean up execution container');
    }
  }
}

function completedResult(
  status: SubmissionStatus,
  executionTimeMs: number | null,
  errorMessage: string | null,
): JavaExecutionResult {
  return { status, executionTimeMs, memoryUsedKb: null, errorMessage: limitMessage(errorMessage) };
}

function toSubmissionStatus(status: TestResultStatus): SubmissionStatus {
  return status === TestResultStatus.PASSED ? SubmissionStatus.ACCEPTED : status;
}

function limitMessage(message: string | null | undefined): string | null {
  const trimmed = message?.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, ERROR_MESSAGE_LIMIT);
}

async function containerWasOutOfMemoryKilled(containerId: string): Promise<boolean> {
  const result = await runDocker(['inspect', '--format={{.State.OOMKilled}}', containerId], {
    timeoutMs: 10_000,
  });
  requireDockerSuccess(result, 'inspect execution container memory status');
  return result.stdout.trim() === 'true';
}

function commandExecutionError(label: string, result: DockerCommandResult): DockerCommandError {
  return new DockerCommandError(
    `Could not ${label}: ${limitMessage(result.stderr) ?? `Docker exited with code ${result.exitCode}.`}`,
  );
}

function requireDockerSuccess(result: DockerCommandResult, label: string): void {
  if (result.exitCode !== 0) throw commandExecutionError(label, result);
}

function runDocker(args: string[], options: DockerCommandOptions): Promise<DockerCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const outputLimitBytes = options.outputLimitBytes ?? INTERNAL_OUTPUT_LIMIT_BYTES;
    let outputBytes = 0;
    let outputLimitExceeded = false;
    let watchdogExpired = false;
    let completed = false;

    const stopContainer = () => {
      if (options.containerId) {
        void runDocker(['kill', options.containerId], { timeoutMs: 5_000 }).catch(() => undefined);
      }
      child.kill();
    };

    const capture = (target: Buffer[], chunk: Buffer) => {
      const remaining = Math.max(0, outputLimitBytes - outputBytes);
      if (remaining > 0) target.push(chunk.subarray(0, remaining));
      outputBytes += chunk.length;
      if (outputBytes > outputLimitBytes && !outputLimitExceeded) {
        outputLimitExceeded = true;
        stopContainer();
      }
    };

    const timer = setTimeout(() => {
      watchdogExpired = true;
      stopContainer();
    }, options.timeoutMs);

    const finish = (error?: Error, code?: number | null) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      if (watchdogExpired) {
        reject(new DockerCommandTimeoutError(args[0] ?? 'unknown Docker command'));
        return;
      }
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        outputLimitExceeded,
      });
    };

    child.stdout.on('data', (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => capture(stderr, chunk));
    child.once('error', (error) => finish(new DockerCommandError(error.message)));
    child.once('close', (code) => finish(undefined, code));
    child.stdin.end(options.input ?? '');
  });
}
