import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fp from 'fastify-plugin';
import { config } from '../config.js';

declare module 'fastify' {
  interface FastifyRequest {
    farmId: string;
  }
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const authPluginCallback: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  await fastify.register(fastifyJwt, {
    secret: config.JWT_SECRET,
    sign: {
      expiresIn: '30d',
    },
  });

  fastify.decorate(
    'authenticate',
    async function (request: FastifyRequest, reply: FastifyReply) {
      try {
        await request.jwtVerify();
        const payload = request.user as { farmId: string };
        if (!payload || !payload.farmId) {
          return reply.status(401).send({
            error: {
              code: 'UNAUTHORIZED',
              message: 'Invalid authorization token',
            },
          });
        }
        request.farmId = payload.farmId;
      } catch {
        return reply.status(401).send({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication required or token expired',
          },
        });
      }
    }
  );
};

export const authPlugin = fp(authPluginCallback);
