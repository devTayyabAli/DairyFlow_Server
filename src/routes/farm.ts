import { FastifyPluginAsync } from 'fastify';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { getFarmsCollection } from '../db.js';

const updateFarmSchema = z.object({
  farmName: z.string().trim().min(1).optional(),
  ownerName: z.string().trim().min(1).optional(),
  defaultMilkRate: z.number().min(0).optional(),
});

export const farmRoutes: FastifyPluginAsync = async (fastify) => {
  // Get current farm profile
  fastify.get(
    '/farm',
    {
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      let objectId: ObjectId;
      try {
        objectId = new ObjectId(request.farmId);
      } catch {
        return reply.status(400).send({
          error: {
            code: 'INVALID_FARM_ID',
            message: 'Invalid farm identifier',
          },
        });
      }

      const farmsCol = getFarmsCollection();
      const farm = await farmsCol.findOne({ _id: objectId });

      if (!farm) {
        return reply.status(404).send({
          error: {
            code: 'FARM_NOT_FOUND',
            message: 'Farm not found',
          },
        });
      }

      return reply.send({
        id: farm._id!.toString(),
        farmName: farm.farmName,
        ownerName: farm.ownerName,
        email: farm.email,
        phone: farm.phone,
        defaultMilkRate: farm.defaultMilkRate ?? 220,
        createdAt: farm.createdAt.toISOString(),
        updatedAt: farm.updatedAt.toISOString(),
      });
    }
  );

  // Update farm profile
  fastify.patch(
    '/farm',
    {
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const parseResult = updateFarmSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: parseResult.error.issues.map((i) => i.message).join(', '),
          },
        });
      }

      let objectId: ObjectId;
      try {
        objectId = new ObjectId(request.farmId);
      } catch {
        return reply.status(400).send({
          error: {
            code: 'INVALID_FARM_ID',
            message: 'Invalid farm identifier',
          },
        });
      }

      const updates = parseResult.data;
      if (Object.keys(updates).length === 0) {
        return reply.status(400).send({
          error: {
            code: 'EMPTY_UPDATE',
            message: 'At least one field must be provided to update',
          },
        });
      }

      const farmsCol = getFarmsCollection();
      const now = new Date();

      const updateResult = await farmsCol.findOneAndUpdate(
        { _id: objectId },
        {
          $set: {
            ...updates,
            updatedAt: now,
          },
        },
        { returnDocument: 'after' }
      );

      if (!updateResult) {
        return reply.status(404).send({
          error: {
            code: 'FARM_NOT_FOUND',
            message: 'Farm not found',
          },
        });
      }

      return reply.send({
        id: updateResult._id!.toString(),
        farmName: updateResult.farmName,
        ownerName: updateResult.ownerName,
        email: updateResult.email,
        phone: updateResult.phone,
        defaultMilkRate: updateResult.defaultMilkRate ?? 220,
        createdAt: updateResult.createdAt.toISOString(),
        updatedAt: updateResult.updatedAt.toISOString(),
      });
    }
  );
};
