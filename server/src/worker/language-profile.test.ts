import { SubmissionLanguage } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  JAVA_21_PROFILE,
  getLanguageProfile,
  UnsupportedLanguageError,
  withTimeout,
} from './language-profile.js';

describe('language profiles', () => {
  it('defines the Java 21 compile and run commands with bounded resources', () => {
    expect(JAVA_21_PROFILE).toMatchObject({
      language: SubmissionLanguage.JAVA,
      languageVersion: '21',
      sourceFileName: 'Main.java',
      compileCommand: ['javac', '-encoding', 'UTF-8', '-d', '/workspace', '/workspace/Main.java'],
      runCommand: ['java', '-cp', '/workspace', 'Main'],
      timeLimitMs: 2_000,
      memoryLimitMb: 256,
      networkPolicy: 'none',
      pidsLimit: 64,
      sourceLimitBytes: 100_000,
      outputLimitBytes: 1_000_000,
    });
    expect(getLanguageProfile(SubmissionLanguage.JAVA)).toBe(JAVA_21_PROFILE);
  });

  it('keeps the execution timeout and command as separate arguments', () => {
    expect(withTimeout(['java', '-cp', '/workspace', 'Main'], 1_250)).toEqual([
      'timeout',
      '--signal=KILL',
      '--kill-after=1s',
      '1.25s',
      'java',
      '-cp',
      '/workspace',
      'Main',
    ]);
  });

  it('fails clearly when a language has no profile yet', () => {
    expect(() => getLanguageProfile(SubmissionLanguage.PYTHON)).toThrow(UnsupportedLanguageError);
  });
});
