import type { Request, RequestHandler } from 'express';

type RateLimitOptions = {
  maxRequests: number;
  windowMs: number;
  message: string;
  /** Overrides the default per-IP key, e.g. to limit per account. */
  keyFor?: (request: Request) => string | undefined;
};

type ClientWindow = { count: number; resetAt: number };

export function createRateLimiter({
  maxRequests,
  windowMs,
  message,
  keyFor,
}: RateLimitOptions): RequestHandler {
  const clients = new Map<string, ClientWindow>();
  let lastCleanupAt = 0;

  return (request, response, next) => {
    const now = Date.now();
    if (now - lastCleanupAt >= Math.min(windowMs, 60_000)) {
      for (const [ip, client] of clients) {
        if (client.resetAt <= now) clients.delete(ip);
      }
      lastCleanupAt = now;
    }

    const ip = keyFor?.(request) ?? (request.ip || request.socket.remoteAddress || 'unknown');
    let client = clients.get(ip);
    if (!client || client.resetAt <= now) {
      client = { count: 0, resetAt: now + windowMs };
      clients.set(ip, client);
    }
    client.count += 1;

    const remaining = Math.max(0, maxRequests - client.count);
    const resetAfterSeconds = Math.max(1, Math.ceil((client.resetAt - now) / 1_000));
    response.setHeader('RateLimit-Limit', String(maxRequests));
    response.setHeader('RateLimit-Remaining', String(remaining));
    response.setHeader('RateLimit-Reset', String(resetAfterSeconds));

    if (client.count > maxRequests) {
      response.setHeader('Retry-After', String(resetAfterSeconds));
      return response.status(429).json({
        error: { code: 'RATE_LIMITED', message },
      });
    }

    return next();
  };
}

export const loginRateLimiter = createRateLimiter({
  maxRequests: 10,
  windowMs: 15 * 60_000,
  message: 'Too many login attempts. Wait before trying again.',
});

// Per-account limit so one account cannot be guessed at from many IP addresses.
export const loginAccountRateLimiter = createRateLimiter({
  maxRequests: 10,
  windowMs: 15 * 60_000,
  message: 'Too many login attempts for this account. Wait before trying again.',
  keyFor: (request) => {
    const email: unknown = (request.body as { email?: unknown } | undefined)?.email;
    return typeof email === 'string'
      ? `account:${email.trim().toLowerCase().slice(0, 255)}`
      : undefined;
  },
});

export const registrationRateLimiter = createRateLimiter({
  maxRequests: 5,
  windowMs: 60 * 60_000,
  message: 'Too many registration attempts. Wait before trying again.',
});

export const submissionRateLimiter = createRateLimiter({
  maxRequests: 20,
  windowMs: 60_000,
  message: 'Too many submissions. Wait before queuing more code.',
});
