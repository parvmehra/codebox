import assert from 'node:assert/strict';

const prometheusBase = process.env.PROMETHEUS_BASE_URL ?? 'http://127.0.0.1:9090';
const grafanaBase = process.env.GRAFANA_BASE_URL ?? 'http://127.0.0.1:3000';
const timeoutMs = 90_000;

async function waitFor(check, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await delay(1_000);
  }
  throw new Error(`${label} did not become ready within ${timeoutMs} ms.`, { cause: lastError });
}

async function queryPrometheus(query) {
  const response = await fetch(`${prometheusBase}/api/v1/query?query=${encodeURIComponent(query)}`);
  if (!response.ok) return undefined;
  const body = await response.json();
  return body.status === 'success' ? body.data.result : undefined;
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

await waitFor(async () => {
  const response = await fetch(`${prometheusBase}/-/ready`);
  return response.ok;
}, 'Prometheus');

await waitFor(async () => {
  const apiTarget = await queryPrometheus('up{job="api"}');
  const workerTarget = await queryPrometheus('up{job="worker"}');
  return Number(apiTarget?.[0]?.value?.[1]) === 1 && Number(workerTarget?.[0]?.value?.[1]) === 1;
}, 'Prometheus API and worker scrapes');

await waitFor(async () => {
  const response = await fetch(`${grafanaBase}/api/health`);
  if (!response.ok) return false;
  const body = await response.json();
  return body.database === 'ok';
}, 'Grafana');

const workerReadiness = await queryPrometheus('codebox_worker_ready');
assert.equal(Number(workerReadiness?.[0]?.value?.[1]), 1, 'The worker should report ready.');

console.info('Prometheus is scraping the API and worker; Grafana is ready.');
