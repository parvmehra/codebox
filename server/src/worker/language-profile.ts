import { SubmissionLanguage } from '@prisma/client';
import { z } from 'zod';

export type LanguageProfile = {
  language: SubmissionLanguage;
  languageVersion: string;
  dockerImage: string;
  sourceFileName: string;
  compileCommand: string[];
  runCommand: string[];
  compileLimitMs: number;
  timeLimitMs: number;
  memoryLimitMb: number;
  networkPolicy: 'none';
  pidsLimit: number;
  sourceLimitBytes: number;
  outputLimitBytes: number;
  requiresExecutableTmpfs: boolean;
};

const languageProfileSnapshotSchema = z.object({
  language: z.nativeEnum(SubmissionLanguage),
  languageVersion: z.string(),
  dockerImage: z.string(),
  sourceFileName: z.string(),
  compileCommand: z.array(z.string()),
  runCommand: z.array(z.string()),
  compileLimitMs: z.number().int().positive(),
  timeLimitMs: z.number().int().positive(),
  memoryLimitMb: z.number().int().positive(),
  networkPolicy: z.literal('none'),
  pidsLimit: z.number().int().positive(),
  sourceLimitBytes: z.number().int().positive(),
  outputLimitBytes: z.number().int().positive(),
  requiresExecutableTmpfs: z.boolean(),
});

export function restoreLanguageProfile(snapshot: unknown): LanguageProfile {
  return languageProfileSnapshotSchema.parse(snapshot);
}

const defaultLimits = {
  compileLimitMs: 15_000,
  timeLimitMs: 2_000,
  memoryLimitMb: 256,
  networkPolicy: 'none' as const,
  pidsLimit: 64,
  sourceLimitBytes: 100_000,
  outputLimitBytes: 1_000_000,
  requiresExecutableTmpfs: false,
};

export const JAVA_21_PROFILE: LanguageProfile = {
  ...defaultLimits,
  language: SubmissionLanguage.JAVA,
  languageVersion: '21',
  dockerImage: 'eclipse-temurin:21-jdk-jammy',
  sourceFileName: 'Main.java',
  compileCommand: ['javac', '-encoding', 'UTF-8', '-d', '/workspace', '/workspace/Main.java'],
  runCommand: ['java', '-cp', '/workspace', 'Main'],
};

export const PYTHON_3_12_PROFILE: LanguageProfile = {
  ...defaultLimits,
  language: SubmissionLanguage.PYTHON,
  languageVersion: '3.12.15',
  dockerImage: 'python:3.12.15-slim-bookworm',
  sourceFileName: 'main.py',
  compileCommand: ['python3', '-m', 'py_compile', '/workspace/main.py'],
  runCommand: ['python3', '-B', '/workspace/main.py'],
};

export const CPP_23_PROFILE: LanguageProfile = {
  ...defaultLimits,
  compileLimitMs: 30_000,
  memoryLimitMb: 512,
  language: SubmissionLanguage.CPP,
  languageVersion: '14.3 (C++23)',
  dockerImage: 'gcc:14.3-bookworm',
  sourceFileName: 'Main.cpp',
  compileCommand: ['g++', '-std=c++23', '-O2', '-pipe', '-o', '/exec/main', '/workspace/Main.cpp'],
  runCommand: ['/exec/main'],
  requiresExecutableTmpfs: true,
};

export const NODE_22_PROFILE: LanguageProfile = {
  ...defaultLimits,
  language: SubmissionLanguage.NODEJS,
  languageVersion: '22.23.2',
  dockerImage: 'node:22.23.2-bookworm-slim',
  sourceFileName: 'main.js',
  compileCommand: ['node', '--check', '/workspace/main.js'],
  runCommand: ['node', '/workspace/main.js'],
};

const languageProfiles: Partial<Record<SubmissionLanguage, LanguageProfile>> = {
  [SubmissionLanguage.JAVA]: JAVA_21_PROFILE,
  [SubmissionLanguage.PYTHON]: PYTHON_3_12_PROFILE,
  [SubmissionLanguage.CPP]: CPP_23_PROFILE,
  [SubmissionLanguage.NODEJS]: NODE_22_PROFILE,
};

export const supportedLanguageProfiles = Object.values(languageProfiles).filter(
  (profile): profile is LanguageProfile => profile !== undefined,
);

export class UnsupportedLanguageError extends Error {
  constructor(readonly language: SubmissionLanguage) {
    super(`The ${language} execution profile is not available yet.`);
    this.name = 'UnsupportedLanguageError';
  }
}

export function getLanguageProfile(language: SubmissionLanguage): LanguageProfile {
  const profile = languageProfiles[language];
  if (!profile) throw new UnsupportedLanguageError(language);
  return profile;
}

export function withTimeout(command: string[], timeoutMs: number): string[] {
  const seconds = (timeoutMs / 1_000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  return ['timeout', '--signal=KILL', '--kill-after=1s', `${seconds}s`, ...command];
}
