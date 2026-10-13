import axios from 'axios';
export const api = axios.create({ baseURL: import.meta.env.VITE_API_URL ?? 'http://localhost:4000/api' });
export type ProblemSummary = { id: string; slug: string; title: string; difficulty: 'EASY' | 'MEDIUM' | 'HARD' };
export type Problem = ProblemSummary & { description: string; constraints: string; inputFormat: string; outputFormat: string; examples: { input: string; output: string; explanation?: string }[] };
