import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRateLimiter } from './rate-limit.js';

function requestFor(ip: string): Request {
  return { ip, socket: { remoteAddress: ip } } as unknown as Request;
}

function responseRecorder() {
  const headers = new Map<string, string>();
  let statusCode = 200;
  let body: unknown;
  const response = {
    setHeader(name: string, value: string) {
      headers.set(name, value);
      return response;
    },
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(value: unknown) {
      body = value;
      return response;
    },
  } as unknown as Response;
  return {
    response,
    headers,
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
}

describe('in-process rate limiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T00:00:00.000Z'));
  });

  it('returns a structured 429 with Retry-After after the configured limit', () => {
    const limiter = createRateLimiter({ maxRequests: 2, windowMs: 60_000, message: 'Slow down.' });
    const next = vi.fn();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      limiter(requestFor('203.0.113.7'), responseRecorder().response, next);
    }
    const limited = responseRecorder();
    limiter(requestFor('203.0.113.7'), limited.response, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
    expect(limited.body).toEqual({ error: { code: 'RATE_LIMITED', message: 'Slow down.' } });
  });

  it('tracks IPs separately and resets a client after its fixed window', () => {
    const limiter = createRateLimiter({ maxRequests: 1, windowMs: 10_000, message: 'Slow down.' });
    const next = vi.fn();

    limiter(requestFor('203.0.113.8'), responseRecorder().response, next);
    const otherIp = responseRecorder();
    limiter(requestFor('203.0.113.9'), otherIp.response, next);
    expect(otherIp.statusCode).toBe(200);

    vi.advanceTimersByTime(10_001);
    const resetIp = responseRecorder();
    limiter(requestFor('203.0.113.8'), resetIp.response, next);
    expect(resetIp.statusCode).toBe(200);
    expect(next).toHaveBeenCalledTimes(3);
  });
});
