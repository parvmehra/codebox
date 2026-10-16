import { z } from 'zod';
import { runtimeEnv } from './runtime-env.js';

const schema = z.object({
  JWT_SECRET: z.string().min(32),
  PORT: z.coerce.number().int().positive().default(4000),
  CLIENT_ORIGIN: z.string().url().default('http://localhost:5173'),
});

export const env = { ...runtimeEnv, ...schema.parse(process.env) };
