import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { SubmissionStatus, TestResultStatus } from '@prisma/client';
import {
  type LanguageProfile,
  supportedLanguageProfiles,
  withTimeout,
} from './language-profile.js';

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

export type ExecutionResult = {
  status: SubmissionStatus;
  executionTimeMs: number | null;
  memoryUsedKb: number | null;
  errorMessage: string | null;
};

export type ExecuteSubmissionOptions = {
  sourceCode: string;
  testCases: ExecutionTestCase[];
  signal?: AbortSignal;
  onPhase: (status: Extract<SubmissionStatus, 'COMPILING' | 'RUNNING'>) => Promise<void>;
  onTestResult: (result: PersistedTestResult) => Promise<void>;
};

export type DockerCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  outputLimitExceeded: boolean;
};

export type DockerCommandOptions = {
  input?: string;
  timeoutMs: number;
  outputLimitBytes?: number;
  containerId?: string;
  signal?: AbortSignal;
};
export type DockerCommandRunner = (
  args: string[],
  options: DockerCommandOptions,
) => Promise<DockerCommandResult>;

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

export class DockerCommandAbortedError extends DockerCommandError {
  constructor() {
    super('Docker command was stopped because submission processing was interrupted.');
    this.name = 'DockerCommandAbortedError';
  }
}

export class SourceSizeLimitError extends Error {
  constructor(limitBytes: number) {
    super(`Source code exceeds the ${limitBytes}-byte limit.`);
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
    ...(profile.requiresExecutableTmpfs
      ? ['--tmpfs', '/exec:rw,exec,nosuid,nodev,size=64m,uid=65534,gid=65534']
      : []),
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

export async function ensureLanguageImages(): Promise<void> {
  await Promise.all(supportedLanguageProfiles.map(ensureLanguageImage));
}

async function ensureLanguageImage(profile: LanguageProfile): Promise<void> {
  const inspect = await runDocker(['image', 'inspect', profile.dockerImage], {
    timeoutMs: 15_000,
  });
  if (inspect.exitCode === 0) return;

  console.info({ image: profile.dockerImage }, 'Pulling language execution image');
  const pull = await runDocker(['pull', '--quiet', profile.dockerImage], {
    timeoutMs: IMAGE_PULL_TIMEOUT_MS,
  });
  requireDockerSuccess(pull, `pull ${profile.language} execution image`);
  console.info({ image: profile.dockerImage }, 'Language execution image is ready');
}

export async function executeSubmission(
  profile: LanguageProfile,
  options: ExecuteSubmissionOptions,
  runCommand: DockerCommandRunner = runDocker,
): Promise<ExecutionResult> {
  if (Buffer.byteLength(options.sourceCode, 'utf8') > profile.sourceLimitBytes) {
    throw new SourceSizeLimitError(profile.sourceLimitBytes);
  }

  const containerName = `codebox-exec-${randomUUID()}`;
  let containerId: string | undefined;

  try {
    const create = await runCommand(buildSandboxCreateArgs(containerName, profile), {
      timeoutMs: 30_000,
      signal: options.signal,
    });
    requireDockerSuccess(create, 'create isolated execution container');
    containerId = create.stdout.trim();
    if (!containerId)
      throw new DockerCommandError('Docker did not return the execution container ID.');

    const start = await runCommand(['start', containerId], {
      timeoutMs: 30_000,
      signal: options.signal,
    });
    requireDockerSuccess(start, 'start isolated execution container');

    const writeSource = await runCommand(
      ['exec', '-i', containerId, 'sh', '-c', `cat > /workspace/${profile.sourceFileName}`],
      { input: options.sourceCode, timeoutMs: 30_000, signal: options.signal },
    );
    requireDockerSuccess(writeSource, 'write source into isolated execution container');

    await options.onPhase(SubmissionStatus.COMPILING);
    const compile = await runCommand(
      ['exec', containerId, ...withTimeout(profile.compileCommand, profile.compileLimitMs)],
      {
        timeoutMs: profile.compileLimitMs + 10_000,
        outputLimitBytes: profile.outputLimitBytes,
        containerId,
        signal: options.signal,
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
      const outOfMemory = await containerWasOutOfMemoryKilled(
        containerId,
        options.signal,
        runCommand,
      );
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
        throw commandExecutionError(`run ${profile.language} compiler`, compile);
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
      const run = await runCommand(
        ['exec', '-i', containerId, ...withTimeout(profile.runCommand, profile.timeLimitMs)],
        {
          input: testCase.input,
          timeoutMs: profile.timeLimitMs + 10_000,
          outputLimitBytes: profile.outputLimitBytes,
          containerId,
          signal: options.signal,
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
        const outOfMemory = await containerWasOutOfMemoryKilled(
          containerId,
          options.signal,
          runCommand,
        );
        status = outOfMemory
          ? TestResultStatus.MEMORY_LIMIT_EXCEEDED
          : TestResultStatus.TIME_LIMIT_EXCEEDED;
        errorMessage = outOfMemory
          ? 'The program exceeded the memory limit.'
          : `The program exceeded its ${profile.timeLimitMs} ms time limit.`;
      } else if (run.exitCode !== 0) {
        if (run.exitCode >= 125 && run.exitCode <= 127) {
          throw commandExecutionError(`run submitted ${profile.language} program`, run);
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
      const cleanup = await runCommand(['rm', '--force', containerName], { timeoutMs: 15_000 });
      if (cleanup.exitCode !== 0 && !cleanup.stderr.includes('No such container')) {
        console.error(
          { containerName, error: cleanup.stderr },
          'Could not remove execution container',
        );
      }
    } catch (error) {
      console.error({ containerName, error }, 'Could not clean up execution container');
    }
  }
}

function completedResult(
  status: SubmissionStatus,
  executionTimeMs: number | null,
  errorMessage: string | null,
): ExecutionResult {
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

async function containerWasOutOfMemoryKilled(
  containerId: string,
  signal?: AbortSignal,
  runCommand: DockerCommandRunner = runDocker,
): Promise<boolean> {
  const result = await runCommand(['inspect', '--format={{.State.OOMKilled}}', containerId], {
    timeoutMs: 10_000,
    signal,
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

export function createDockerCommandRunner(spawnChild: typeof spawn = spawn): DockerCommandRunner {
  const runCommand: DockerCommandRunner = (args, options) =>
    new Promise((resolve, reject) => {
      const child = spawnChild('docker', args, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const outputLimitBytes = options.outputLimitBytes ?? INTERNAL_OUTPUT_LIMIT_BYTES;
      let outputBytes = 0;
      let outputLimitExceeded = false;
      let watchdogExpired = false;
      let completed = false;
      let abort = () => undefined;

      const stopContainer = () => {
        if (options.containerId) {
          void runCommand(['kill', options.containerId], { timeoutMs: 5_000 }).catch(
            () => undefined,
          );
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
        options.signal?.removeEventListener('abort', abort);
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
      abort = () => {
        stopContainer();
        finish(new DockerCommandAbortedError());
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) {
        abort();
        return;
      }
      child.stdin.end(options.input ?? '');
    });
  return runCommand;
}

const runDocker: DockerCommandRunner = createDockerCommandRunner();
