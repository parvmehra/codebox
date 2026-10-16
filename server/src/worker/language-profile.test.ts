import { SubmissionLanguage } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  CPP_23_PROFILE,
  getLanguageProfile,
  JAVA_21_PROFILE,
  NODE_22_PROFILE,
  PYTHON_3_12_PROFILE,
  supportedLanguageProfiles,
  UnsupportedLanguageError,
  withTimeout,
} from './language-profile.js';

describe('language profiles', () => {
  it('registers the four planned languages with explicit pinned runtimes', () => {
    expect(supportedLanguageProfiles.map(({ language }) => language)).toEqual([
      SubmissionLanguage.JAVA,
      SubmissionLanguage.PYTHON,
      SubmissionLanguage.CPP,
      SubmissionLanguage.NODEJS,
    ]);
    expect([JAVA_21_PROFILE, PYTHON_3_12_PROFILE, CPP_23_PROFILE, NODE_22_PROFILE]).toMatchObject([
      {
        languageVersion: '21',
        dockerImage: 'eclipse-temurin:21-jdk-jammy',
        sourceFileName: 'Main.java',
        compileCommand: ['javac', '-encoding', 'UTF-8', '-d', '/workspace', '/workspace/Main.java'],
        runCommand: ['java', '-cp', '/workspace', 'Main'],
      },
      {
        languageVersion: '3.12.15',
        dockerImage: 'python:3.12.15-slim-bookworm',
        sourceFileName: 'main.py',
        compileCommand: ['python3', '-m', 'py_compile', '/workspace/main.py'],
        runCommand: ['python3', '-B', '/workspace/main.py'],
      },
      {
        languageVersion: '14.3 (C++23)',
        dockerImage: 'gcc:14.3-bookworm',
        compileLimitMs: 30_000,
        memoryLimitMb: 512,
        sourceFileName: 'Main.cpp',
        compileCommand: [
          'g++',
          '-std=c++23',
          '-O2',
          '-pipe',
          '-o',
          '/exec/main',
          '/workspace/Main.cpp',
        ],
        runCommand: ['/exec/main'],
        requiresExecutableTmpfs: true,
      },
      {
        languageVersion: '22.23.2',
        dockerImage: 'node:22.23.2-bookworm-slim',
        sourceFileName: 'main.js',
        compileCommand: ['node', '--check', '/workspace/main.js'],
        runCommand: ['node', '/workspace/main.js'],
      },
    ]);
    expect(supportedLanguageProfiles.every((profile) => profile.networkPolicy === 'none')).toBe(
      true,
    );
    expect(JAVA_21_PROFILE.memoryLimitMb).toBe(256);
    expect(PYTHON_3_12_PROFILE.memoryLimitMb).toBe(256);
    expect(CPP_23_PROFILE.memoryLimitMb).toBe(512);
    expect(NODE_22_PROFILE.memoryLimitMb).toBe(256);
    expect(getLanguageProfile(SubmissionLanguage.JAVA)).toBe(JAVA_21_PROFILE);
    expect(getLanguageProfile(SubmissionLanguage.PYTHON)).toBe(PYTHON_3_12_PROFILE);
    expect(getLanguageProfile(SubmissionLanguage.CPP)).toBe(CPP_23_PROFILE);
    expect(getLanguageProfile(SubmissionLanguage.NODEJS)).toBe(NODE_22_PROFILE);
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

  it('fails clearly when an enum value has no registered profile', () => {
    expect(() => getLanguageProfile('RUST' as SubmissionLanguage)).toThrow(
      UnsupportedLanguageError,
    );
  });
});
