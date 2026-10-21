import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { prisma } from '../../database/prisma.js';
import { requireAuth, type AuthenticatedRequest } from '../../middleware/auth.js';
import { loginRateLimiter, registrationRateLimiter } from '../../middleware/rate-limit.js';
import { HttpError } from '../../utils/http-error.js';
import { credentials } from './validation.js';
const publicUser = (user: { id: string; email: string; role: string }) => ({
  id: user.id,
  email: user.email,
  role: user.role,
});
const tokenFor = (user: { id: string; role: string }) =>
  jwt.sign({ id: user.id, role: user.role }, env.JWT_SECRET, { expiresIn: '1h' });
export const authRouter = Router();
authRouter.post('/register', registrationRateLimiter, async (request, response) => {
  const input = credentials.parse(request.body);
  const existing = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
  if (existing)
    throw new HttpError(409, 'EMAIL_IN_USE', 'An account already exists for that email address.');
  const user = await prisma.user.create({
    data: { email: input.email.toLowerCase(), passwordHash: await bcrypt.hash(input.password, 12) },
  });
  return response.status(201).json({ user: publicUser(user), token: tokenFor(user) });
});
authRouter.post('/login', loginRateLimiter, async (request, response) => {
  const input = credentials.parse(request.body);
  const user = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
  if (!user || !(await bcrypt.compare(input.password, user.passwordHash)))
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
  return response.json({ user: publicUser(user), token: tokenFor(user) });
});
authRouter.get('/me', requireAuth, async (request: AuthenticatedRequest, response) => {
  const user = await prisma.user.findUnique({ where: { id: request.user!.id } });
  if (!user) throw new HttpError(401, 'UNAUTHENTICATED', 'Account no longer exists.');
  return response.json({ user: publicUser(user) });
});
