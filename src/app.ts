import fastifyCors from '@fastify/cors';
import fastifyRateLimit from '@fastify/rate-limit';
import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';
import { config } from './config.js';
import { authPlugin } from './plugins/auth.js';
import { authRoutes } from './routes/auth.js';
import { farmRoutes } from './routes/farm.js';
import { healthRoutes } from './routes/health.js';
import { syncRoutes } from './routes/sync.js';

export async function buildApp(opts: FastifyServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? {
      level: process.env.NODE_ENV === 'test' ? 'silent' : 'info',
      redact: ['req.headers.authorization', 'body.password', 'body.token'],
    },
    ...opts,
  });

  // CORS
  await app.register(fastifyCors, {
    origin: config.CORS_ORIGIN === '*' ? true : config.CORS_ORIGIN,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // Rate Limiting
  await app.register(fastifyRateLimit, {
    max: 100,
    timeWindow: '1 minute',
  });

  // Auth Plugin
  await app.register(authPlugin);

  // Routes
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(farmRoutes);
  await app.register(syncRoutes);

  // 404 handler
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `Route ${request.method} ${request.url} not found`,
      },
    });
  });

  // Global Error Handler
  app.setErrorHandler((error, request, reply) => {
    const err = error as { statusCode?: number; code?: string; message?: string };
    if (reply.statusCode < 400) {
      reply.status(err.statusCode || 500);
    }

    const statusCode = reply.statusCode;

    if (statusCode === 429) {
      return reply.send({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests, please try again later',
        },
      });
    }

    if (statusCode >= 400 && statusCode < 500) {
      return reply.send({
        error: {
          code: err.code || 'CLIENT_ERROR',
          message: err.message || 'Client request error',
        },
      });
    }

    app.log.error(error as Error);
    return reply.send({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected internal server error occurred',
      },
    });
  });

  return app;
}
