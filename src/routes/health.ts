import { FastifyPluginAsync } from 'fastify';
import { getDb } from '../db.js';

const READY_TIMEOUT_MS = 2000;

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async () => {
    return {
      name: 'DairyFlow API',
      status: 'online',
      time: new Date().toISOString(),
    };
  });

  // Liveness: cheap, never touches the database.
  fastify.get('/health', { config: { rateLimit: false } }, async () => {
    return {
      ok: true,
      time: new Date().toISOString(),
    };
  });

  // Readiness: verifies MongoDB is reachable.
  fastify.get('/ready', { config: { rateLimit: false } }, async (request, reply) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        getDb().command({ ping: 1 }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('ping timeout')), READY_TIMEOUT_MS);
        }),
      ]);
      return { ok: true, db: 'up', time: new Date().toISOString() };
    } catch (err) {
      request.log.warn({ err }, 'readiness check failed');
      return reply.status(503).send({ ok: false, db: 'down', time: new Date().toISOString() });
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
};
