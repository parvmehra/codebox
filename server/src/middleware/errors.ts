import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { logger } from '../observability/logger.js';
import { HttpError } from '../utils/http-error.js';

export const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  void _next;
  if (error instanceof ZodError)
    return response.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed.',
        details: error.flatten(),
      },
    });
  if (error instanceof HttpError)
    return response
      .status(error.status)
      .json({ error: { code: error.code, message: error.message } });
  logger.error({ error }, 'Unhandled API error');
  return response
    .status(500)
    .json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } });
};
