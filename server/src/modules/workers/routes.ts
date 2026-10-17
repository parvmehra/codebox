import { Router } from 'express';
import { getWorkerStatus } from '../../realtime/worker-status.js';

export const workersRouter = Router();

workersRouter.get('/status', async (_request, response) => {
  return response.json({ data: await getWorkerStatus() });
});
