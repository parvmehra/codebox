import { createServer, type Server } from 'node:http';
import { runtimeEnv } from '../config/runtime-env.js';
import { logger } from './logger.js';
import { metricsRegistry, workerReady } from './metrics.js';

let server: Server | undefined;
let ready = false;

export function setWorkerReady(isReady: boolean): void {
  ready = isReady;
  workerReady.set(Number(isReady));
}

export async function startWorkerObservabilityServer(): Promise<void> {
  if (server) return;

  const nextServer = createServer((request, response) => {
    void handleRequest(request.url, response).catch((error: unknown) => {
      logger.error({ error }, 'Could not serve worker observability request');
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      nextServer.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      nextServer.off('error', onError);
      resolve();
    };
    nextServer.once('error', onError);
    nextServer.once('listening', onListening);
    nextServer.listen(runtimeEnv.WORKER_METRICS_PORT, '0.0.0.0');
  });

  server = nextServer;
  logger.info({ port: runtimeEnv.WORKER_METRICS_PORT }, 'Worker observability server is listening');
}

export async function stopWorkerObservabilityServer(): Promise<void> {
  const currentServer = server;
  server = undefined;
  setWorkerReady(false);
  if (!currentServer) return;
  await new Promise<void>((resolve) => currentServer.close(() => resolve()));
}

async function handleRequest(
  requestUrl: string | undefined,
  response: import('node:http').ServerResponse,
): Promise<void> {
  const pathname = new URL(requestUrl ?? '/', 'http://localhost').pathname;
  if (pathname === '/health/live') {
    sendJson(response, 200, { status: 'live' });
    return;
  }
  if (pathname === '/health/ready') {
    sendJson(response, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready' });
    return;
  }
  if (pathname === '/metrics') {
    response.writeHead(200, { 'content-type': metricsRegistry.contentType });
    response.end(await metricsRegistry.metrics());
    return;
  }

  sendJson(response, 404, { error: 'NOT_FOUND' });
}

function sendJson(
  response: import('node:http').ServerResponse,
  statusCode: number,
  body: object,
): void {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}
