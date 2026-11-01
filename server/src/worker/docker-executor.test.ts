import { describe, expect, it } from 'vitest';
import {
  buildSandboxCreateArgs,
  DockerCommandAbortedError,
  normalizeOutput,
  readPeakMemoryKb,
  type DockerCommandRunner,
} from './docker-executor.js';
import { CPP_23_PROFILE, JAVA_21_PROFILE } from './language-profile.js';

describe('Docker execution settings', () => {
  it('creates a networkless, resource-limited container without host mounts', () => {
    const args = buildSandboxCreateArgs('codebox-exec-test', JAVA_21_PROFILE);

    expect(args).toContain('--network');
    expect(args).toContain('none');
    expect(args).toContain('--memory');
    expect(args).toContain('256m');
    expect(args).toContain('--cpus');
    expect(args).toContain('--pids-limit');
    expect(args).toContain('--read-only');
    expect(args).toContain('--cap-drop');
    expect(args).toContain('ALL');
    expect(args).toContain('no-new-privileges:true');
    expect(args.some((arg) => arg === '-v' || arg === '--volume')).toBe(false);
    expect(args.some((arg) => arg.includes('docker.sock'))).toBe(false);
    expect(args).not.toContain('/exec:rw,exec,nosuid,nodev,size=64m,uid=65534,gid=65534');
  });

  it('gives compiled native code a private executable tmpfs', () => {
    const args = buildSandboxCreateArgs('codebox-exec-cpp-test', CPP_23_PROFILE);

    expect(args).toContain('--read-only');
    expect(args).toContain('--network');
    expect(args).toContain('none');
    expect(args).toContain('/exec:rw,exec,nosuid,nodev,size=64m,uid=65534,gid=65534');
    expect(args.some((arg) => arg === '-v' || arg === '--volume')).toBe(false);
  });

  it('compares outputs while ignoring line ending and whitespace differences', () => {
    expect(normalizeOutput('  1\t  2\r\n')).toBe('1 2');
    expect(normalizeOutput('\n  ')).toBe('');
  });

  describe('readPeakMemoryKb', () => {
    const result = (exitCode: number, stdout: string) => ({
      exitCode,
      stdout,
      stderr: '',
      outputLimitExceeded: false,
    });

    it('converts the cgroup byte count to kilobytes', async () => {
      const runner: DockerCommandRunner = async () => result(0, '104857600\n');
      expect(await readPeakMemoryKb('c', undefined, runner)).toBe(102_400);
    });

    it('returns null when the host has no cgroup v2 memory.peak', async () => {
      expect(await readPeakMemoryKb('c', undefined, async () => result(1, ''))).toBeNull();
      expect(await readPeakMemoryKb('c', undefined, async () => result(0, 'max'))).toBeNull();
      expect(
        await readPeakMemoryKb('c', undefined, async () => {
          throw new Error('docker unavailable');
        }),
      ).toBeNull();
    });

    it('still propagates cancellation', async () => {
      const runner: DockerCommandRunner = async () => {
        throw new DockerCommandAbortedError();
      };
      await expect(readPeakMemoryKb('c', undefined, runner)).rejects.toBeInstanceOf(
        DockerCommandAbortedError,
      );
    });
  });
});
