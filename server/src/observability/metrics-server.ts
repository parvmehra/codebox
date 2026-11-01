import { createServer, type Server } from 'node:http';
import { metricsRegistry } from './metrics.js';

// Metrics are served on their own port so they are never reachable through the public API port.
export function createMetricsServer(): Server {
  return createServer((request, response) => {
    if (request.method !== 'GET' || request.url?.split('?')[0] !== '/metrics') {
      response.writeHead(404).end();
      return;
    }
    metricsRegistry
      .metrics()
      .then((body) => {
        response.writeHead(200, {
          'content-type': metricsRegistry.contentType,
          'cache-control': 'no-store',
        });
        response.end(body);
      })
      .catch(() => response.writeHead(500).end());
  });
}
