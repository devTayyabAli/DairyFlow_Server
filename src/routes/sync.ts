import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { changeSchema } from '../sync/schemas.js';
import { applyPush, pullChanges } from '../sync/service.js';

const pushBodySchema = z.object({
  changes: z.array(changeSchema).max(500, 'Batch size exceeds maximum limit of 500 changes'),
});

const pullQuerySchema = z.object({
  since: z.coerce.number().int('since must be an integer').min(0, 'since must be >= 0').default(0),
  limit: z.coerce.number().int('limit must be an integer').min(1, 'limit must be >= 1').max(500, 'limit must be <= 500').default(500),
});

export const syncRoutes: FastifyPluginAsync = async (fastify) => {
  // Push local changes to cloud
  fastify.post(
    '/sync/push',
    {
      // Larger than the global 1 MB limit: 500 changes with long notes.
      bodyLimit: 2 * 1024 * 1024,
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const parseResult = pushBodySchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: parseResult.error.issues.map((i) => i.message).join(', '),
          },
        });
      }

      const { changes } = parseResult.data;
      const result = await applyPush(request.farmId, changes);

      return reply.send(result);
    }
  );

  // Pull remote changes from cloud
  fastify.get(
    '/sync/pull',
    {
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const parseResult = pullQuerySchema.safeParse(request.query);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: parseResult.error.issues.map((i) => i.message).join(', '),
          },
        });
      }

      const { since, limit } = parseResult.data;
      const result = await pullChanges(request.farmId, since, limit);

      return reply.send(result);
    }
  );
};
