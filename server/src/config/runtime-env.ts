import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

const schema = z.object({
  DATABASE_URL: z.string().url(),
  RABBITMQ_URL: z.string().url().default('amqp://code_platform:change-me@localhost:5672'),
});

export const runtimeEnv = schema.parse(process.env);
