import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { UserRole } from '../db.js';
import { changeSchema } from '../sync/schemas.js';
import { applyPush, pullChanges } from '../sync/service.js';

const ADMIN_TABLES = new Set([
  'fat_rate_bands',
  'collector_assignments',
  'ledger_entries',
  'settlements',
  'advances',
]);

const SETTINGS_WRITERS: UserRole[] = ['owner', 'manager'];

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

      if (request.role === 'auditor' || request.role === 'farmer') {
        const result = await applyPush(request.farmId, []);
        result.rejected = changes.map((change) => ({
          uuid: change.uuid,
          table: change.table,
          reason:
            request.role === 'farmer'
              ? 'A dairy account can see its milk but cannot change records.'
              : 'Read-only role cannot change farm data.',
        }));
        return reply.send(result);
      }

      const preRejected: Array<{ uuid: string; table: string; reason: string }> = [];
      let toApply = changes.filter((change) => {
        if (request.role === 'collector' && change.table !== 'milk_collections') {
          preRejected.push({
            uuid: change.uuid,
            table: change.table,
            reason: 'A dodhi can only record milk collections.',
          });
          return false;
        }
        if (change.table === 'settings' && !SETTINGS_WRITERS.includes(request.role)) {
          preRejected.push({
            uuid: change.uuid,
            table: change.table,
            reason: 'Only the owner or a manager can change farm settings.',
          });
          return false;
        }
        if (ADMIN_TABLES.has(change.table) && !SETTINGS_WRITERS.includes(request.role)) {
          preRejected.push({
            uuid: change.uuid,
            table: change.table,
            reason: 'Only the owner can change rates, assignments, or payments.',
          });
          return false;
        }
        return true;
      });
      if (request.role === 'collector') {
        toApply = toApply.map((change) => {
          if (change.op !== 'upsert' || change.table !== 'milk_collections' || !change.data) return change;
          return { ...change, data: { ...change.data, collector_id: request.userId } };
        });
      }

      const result = await applyPush(request.farmId, toApply, {
        userId: request.userId,
        role: request.role,
      });
      result.rejected.push(...preRejected);
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
      const result = await pullChanges(request.farmId, since, limit, {
        userId: request.userId,
        role: request.role,
      });

      return reply.send(result);
    }
  );
};
