import axios from 'axios';

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? 'http://localhost:4000/api',
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export type ProblemSummary = {
  id: string;
  slug: string;
  title: string;
  difficulty: 'EASY' | 'MEDIUM' | 'HARD';
};

export type Problem = ProblemSummary & {
  description: string;
  constraints: string;
  inputFormat: string;
  outputFormat: string;
  examples: { input: string; output: string; explanation?: string }[];
};

export type SubmissionLanguage = 'JAVA' | 'PYTHON' | 'CPP' | 'NODEJS';

export type SubmissionStatus =
  | 'QUEUED'
  | 'ASSIGNED'
  | 'STARTING'
  | 'COMPILING'
  | 'RUNNING'
  | 'ACCEPTED'
  | 'WRONG_ANSWER'
  | 'TIME_LIMIT_EXCEEDED'
  | 'MEMORY_LIMIT_EXCEEDED'
  | 'COMPILATION_ERROR'
  | 'RUNTIME_ERROR'
  | 'SYSTEM_ERROR'
  | 'CANCELLED';

export type QueuedSubmission = {
  id: string;
  language: SubmissionLanguage;
  status: SubmissionStatus;
  createdAt: string;
};

export type SubmissionSummary = {
  id: string;
  language: SubmissionLanguage;
  status: SubmissionStatus;
  executionTimeMs: number | null;
  memoryUsedKb: number | null;
  createdAt: string;
  updatedAt: string;
  problem: Pick<ProblemSummary, 'id' | 'slug' | 'title'>;
};

export type TestResultStatus =
  'PASSED' | 'WRONG_ANSWER' | 'TIME_LIMIT_EXCEEDED' | 'MEMORY_LIMIT_EXCEEDED' | 'RUNTIME_ERROR';

export type SubmissionTestResult = {
  testIndex: number;
  status: TestResultStatus;
  executionTimeMs: number | null;
  errorMessage: string | null;
};

export type SubmissionDetails = SubmissionSummary & {
  sourceCode: string;
  errorMessage: string | null;
  testResults: SubmissionTestResult[];
};
