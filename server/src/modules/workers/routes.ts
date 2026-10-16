import { Router } from 'express';
import { getWorkerStatus } from '../../realtime/worker-status.js';

export const workersRouter = Router();

workersRouter.get('/status', (_request, response) => {
  return response.json({ data: getWorkerStatus() });
});
