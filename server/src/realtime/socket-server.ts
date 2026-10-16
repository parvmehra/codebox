import type { Server as HttpServer } from 'node:http';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { env } from '../config/env.js';

export function createSocketServer(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: { origin: env.CLIENT_ORIGIN, methods: ['GET', 'POST'] },
  });

  io.use((socket, next) => {
    const token: unknown = socket.handshake.auth?.token;
    if (typeof token !== 'string') return next(new Error('Authentication is required.'));

    try {
      const payload = jwt.verify(token, env.JWT_SECRET);
      if (typeof payload === 'string' || typeof payload.id !== 'string') {
        return next(new Error('The authentication token is invalid.'));
      }
      socket.data.userId = payload.id;
      return next();
    } catch {
      return next(new Error('The authentication token is invalid or expired.'));
    }
  });

  io.on('connection', (socket) => {
    void socket.join(`user:${socket.data.userId as string}`);
  });

  return io;
}
