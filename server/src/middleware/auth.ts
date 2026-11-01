import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';
import { prisma } from '../database/prisma.js';
import { env } from '../config/env.js';
import { HttpError } from '../utils/http-error.js';

export interface AuthenticatedRequest extends Request {
  user?: { id: string; role: Role };
}
export function optionalAuth(
  request: AuthenticatedRequest,
  _response: Response,
  next: NextFunction,
) {
  const token = request.header('authorization')?.replace(/^Bearer\s+/i, '');
  if (token) {
    try {
      request.user = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as {
        id: string;
        role: Role;
      };
    } catch {
      /* Public reads remain available when an optional token is stale. */
    }
  }
  return next();
}
export function requireAuth(
  request: AuthenticatedRequest,
  _response: Response,
  next: NextFunction,
) {
  const token = request.header('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return next(new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required.'));
  try {
    request.user = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as {
      id: string;
      role: Role;
    };
    return next();
  } catch {
    return next(
      new HttpError(401, 'INVALID_TOKEN', 'The authentication token is invalid or expired.'),
    );
  }
}
// The role in the token can be up to an hour old, so privileged routes re-read it from the database.
export function requireRole(...roles: Role[]) {
  return async (request: AuthenticatedRequest, _response: Response, next: NextFunction) => {
    try {
      const account = request.user
        ? await prisma.user.findUnique({ where: { id: request.user.id }, select: { role: true } })
        : null;
      if (!account || !roles.includes(account.role)) {
        return next(
          new HttpError(403, 'FORBIDDEN', 'You do not have permission to perform this action.'),
        );
      }
      request.user = { id: request.user!.id, role: account.role };
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
