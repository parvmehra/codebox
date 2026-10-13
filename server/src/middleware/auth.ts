import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';
import { env } from '../config/env.js';
import { HttpError } from '../utils/http-error.js';

export interface AuthenticatedRequest extends Request { user?: { id: string; role: Role }; }
export function requireAuth(request: AuthenticatedRequest, _response: Response, next: NextFunction) {
  const token = request.header('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return next(new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required.'));
  try { request.user = jwt.verify(token, env.JWT_SECRET) as { id: string; role: Role }; return next(); }
  catch { return next(new HttpError(401, 'INVALID_TOKEN', 'The authentication token is invalid or expired.')); }
}
export function requireRole(...roles: Role[]) {
  return (request: AuthenticatedRequest, _response: Response, next: NextFunction) => !request.user || !roles.includes(request.user.role) ? next(new HttpError(403, 'FORBIDDEN', 'You do not have permission to perform this action.')) : next();
}
