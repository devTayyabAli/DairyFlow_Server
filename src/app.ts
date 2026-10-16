import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';
import { config } from './config.js';
import { authPlugin } from './plugins/auth.js';
import { authRoutes } from './routes/auth.js';
import { farmRoutes } from './routes/farm.js';
import { healthRoutes } from './routes/health.js';
import { syncRoutes } from './routes/sync.js';

export async function buildApp(opts: FastifyServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      opts.logger ?? {
        level: config.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
        // Secrets must never reach the logs, whatever shape they are logged in.
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'res.headers["set-cookie"]',
            'body',
            '*.password',
            '*.newPassword',
            '*.currentPassword',
            '*.otp',
            '*.token',
            '*.passwordHash',
            '*.codeHash',
            '*.authorization',
          ],
          censor: '[REDACTED]',
        },
      },
    // Honour a sane upstream id (load balancer) so a request can be traced end to end.
    requestIdHeader: false,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    },
    // Needed for the per-IP rate limiter to see the real client behind a proxy (TRUST_PROXY).
    trustProxy: config.trustProxy as string | boolean | string[], // numbers (hop count) are supported at runtime
    bodyLimit: 1024 * 1024,
    ...opts,
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  // Security headers (API only serves JSON, so the default CSP is fine).
  await app.register(fastifyHelmet);

  // CORS
  await app.register(fastifyCors, {
    origin: config.corsOrigins,
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

    if (statusCode === 503 && err.code === 'SYNC_BUSY') {
      reply.header('Retry-After', '2');
      return reply.send({ error: { code: 'SYNC_BUSY', message: err.message } });
    }

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

    request.log.error({ err: error }, 'unhandled error');
    return reply.send({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected internal server error occurred',
      },
    });
  });

  return app;
}
