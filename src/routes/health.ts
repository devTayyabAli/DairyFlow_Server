import { FastifyPluginAsync } from 'fastify';

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async () => {
    return {
      name: 'DairyFlow API',
      status: 'online',
      time: new Date().toISOString(),
    };
  });

  fastify.get('/health', async () => {
    return {
      ok: true,
      time: new Date().toISOString(),
    };
  });
};
