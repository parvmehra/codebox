import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

const schema = z.object({
  DATABASE_URL: z.string().url(),
  RABBITMQ_URL: z.string().url().default('amqp://code_platform:change-me@localhost:5672'),
  SCHEDULER_STRATEGY: z.enum(['FIFO', 'PRIORITY']).default('FIFO'),
  WORKER_LANGUAGES: z.string().default('JAVA,PYTHON,CPP,NODEJS'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  WORKER_METRICS_PORT: z.coerce.number().int().positive().default(9101),
});

export const runtimeEnv = schema.parse(process.env);
