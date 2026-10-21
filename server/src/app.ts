import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { prisma } from './database/prisma.js';
import { errorHandler } from './middleware/errors.js';
import { authRouter } from './modules/auth/routes.js';
import { contestsRouter } from './modules/contests/routes.js';
import { problemsRouter } from './modules/problems/routes.js';
import { submissionsRouter } from './modules/submissions/routes.js';
import { workersRouter } from './modules/workers/routes.js';
import { collectHttpMetrics } from './observability/http-metrics.js';
import { logger } from './observability/logger.js';
import { apiReady, metricsRegistry, schedulerReady } from './observability/metrics.js';
import { isSubmissionSchedulerReady } from './queue/scheduler-service.js';

export const app = express();
app.set('trust proxy', env.TRUST_PROXY_HOPS);
app.use(cors({ origin: env.CLIENT_ORIGIN }));
app.use(
  pinoHttp({
    logger,
    genReqId: (_request, response) => {
      const requestId = randomUUID();
      response.setHeader('x-request-id', requestId);
      return requestId;
    },
    autoLogging: { ignore: (request) => request.url?.split('?')[0] === '/metrics' },
    serializers: {
      req: (request) => ({
        method: request.method,
        url: request.url?.split('?')[0],
        remoteAddress: (request as unknown as { remoteAddress?: string }).remoteAddress,
      }),
    },
  }),
);
app.use(collectHttpMetrics);
app.use(express.json({ limit: '1mb' }));
app.get('/health', (_request, response) => response.json({ status: 'ok' }));
app.get('/health/live', (_request, response) => response.json({ status: 'live' }));
app.get('/health/ready', async (_request, response) => {
  let databaseIsReady = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseIsReady = true;
  } catch {
    // Report the failed dependency without exposing connection details.
  }

  const schedulerIsReady = isSubmissionSchedulerReady();
  const ready = databaseIsReady && schedulerIsReady;
  apiReady.set(Number(ready));
  schedulerReady.set(Number(schedulerIsReady));
  response.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    checks: { database: databaseIsReady, scheduler: schedulerIsReady },
  });
});
app.get('/metrics', async (_request, response, next) => {
  try {
    response.setHeader('content-type', metricsRegistry.contentType);
    response.setHeader('cache-control', 'no-store');
    response.send(await metricsRegistry.metrics());
  } catch (error) {
    next(error);
  }
});
app.use('/api/auth', authRouter);
app.use('/api/contests', contestsRouter);
app.use('/api/problems', problemsRouter);
app.use('/api/submissions', submissionsRouter);
app.use('/api/workers', workersRouter);
app.use(errorHandler);
