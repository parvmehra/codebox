import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
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
