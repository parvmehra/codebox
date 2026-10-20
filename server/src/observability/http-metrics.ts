import type { NextFunction, Request, Response } from 'express';
import { httpRequestDurationSeconds, httpRequestsTotal } from './metrics.js';

export function collectHttpMetrics(request: Request, response: Response, next: NextFunction): void {
  if (request.path === '/metrics') {
    next();
    return;
  }

  const startedAt = process.hrtime.bigint();
  response.once('finish', () => {
    const routePath = request.route?.path;
    const route = routePath
      ? `${request.baseUrl}${Array.isArray(routePath) ? routePath.join('|') : routePath}`
      : 'unmatched';
    const method = request.method;
    const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;

    httpRequestsTotal.inc({ method, route, status_code: String(response.statusCode) });
    httpRequestDurationSeconds.observe({ method, route }, durationSeconds);
  });
  next();
}
