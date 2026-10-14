import { SubmissionLanguage } from '@prisma/client';

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
};

export const JAVA_21_PROFILE: LanguageProfile = {
  language: SubmissionLanguage.JAVA,
  languageVersion: '21',
  dockerImage: 'eclipse-temurin:21-jdk-jammy',
  sourceFileName: 'Main.java',
  compileCommand: ['javac', '-encoding', 'UTF-8', '-d', '/workspace', '/workspace/Main.java'],
  runCommand: ['java', '-cp', '/workspace', 'Main'],
  compileLimitMs: 15_000,
  timeLimitMs: 2_000,
  memoryLimitMb: 256,
  networkPolicy: 'none',
  pidsLimit: 64,
  sourceLimitBytes: 100_000,
  outputLimitBytes: 1_000_000,
};

const languageProfiles: Partial<Record<SubmissionLanguage, LanguageProfile>> = {
  [SubmissionLanguage.JAVA]: JAVA_21_PROFILE,
};

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
