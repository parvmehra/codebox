import pino from 'pino';
import { runtimeEnv } from '../config/runtime-env.js';

export const logger = pino({
  level: runtimeEnv.LOG_LEVEL,
  formatters: { level: (label) => ({ level: label }) },
  serializers: { error: pino.stdSerializers.err },
  redact: {
    paths: [
      'authorization',
      'password',
      'sourceCode',
      'token',
      'req.headers.authorization',
      'req.headers.cookie',
    ],
    censor: '[REDACTED]',
  },
});
