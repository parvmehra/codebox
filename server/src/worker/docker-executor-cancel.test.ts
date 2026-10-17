import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  createDockerCommandRunner,
  DockerCommandAbortedError,
  executeSubmission,
} from './docker-executor.js';
import { NODE_22_PROFILE } from './language-profile.js';

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: { end: (value?: string) => void };
  kill: ReturnType<typeof vi.fn>;
};

function createChild(): FakeChild {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: { end: vi.fn() },
    kill: vi.fn(() => true),
  });
}

describe('Docker execution cancellation', () => {
  it('kills the execution container and removes it when its abort signal fires', async () => {
    const controller = new AbortController();
    const commands: string[][] = [];
    let runChild: FakeChild | undefined;

    const spawnChild = (...spawnArgs: unknown[]) => {
      const args = spawnArgs.find(Array.isArray) as string[] | undefined;
      if (!args)
        throw new Error(`Docker spawn did not receive an argument array: ${spawnArgs.length}`);
      commands.push(args);
      const child = createChild();
      const isRunCommand = args[0] === 'exec' && !args.includes('--check') && args.includes('node');

      if (isRunCommand) {
        runChild = child;
        child.stdin.end = () => controller.abort({ kind: 'user-cancel' });
      } else {
        setImmediate(() => {
          if (args[0] === 'create') child.stdout.write('container-123');
          child.stdout.end();
          child.stderr.end();
          child.emit('close', 0);
        });
      }
      return child;
    };
    const runCommand = createDockerCommandRunner(spawnChild as never);

    await expect(
      executeSubmission(
        NODE_22_PROFILE,
        {
          sourceCode: 'while (true) {}',
          testCases: [{ id: 'test-case', input: '', expectedOut: '' }],
          signal: controller.signal,
          onPhase: async () => undefined,
          onTestResult: async () => undefined,
        },
        runCommand,
      ),
    ).rejects.toBeInstanceOf(DockerCommandAbortedError);

    expect(runChild?.kill).toHaveBeenCalledOnce();
    expect(commands.some((args) => args[0] === 'kill' && args[1] === 'container-123')).toBe(true);
    expect(commands.some((args) => args[0] === 'rm' && args[1] === '--force')).toBe(true);
  });
});
