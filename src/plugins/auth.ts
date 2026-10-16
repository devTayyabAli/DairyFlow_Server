import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fp from 'fastify-plugin';
import { ObjectId } from 'mongodb';
import { config } from '../config.js';
import { getFarmsCollection } from '../db.js';

declare module 'fastify' {
  interface FastifyRequest {
    farmId: string;
  }
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Signs a session token. Pass `notBefore` (the farm's passwordChangedAt) to issue a token
     * that is valid even within the same second as the password change.
     */
    issueToken: (farmId: string, passwordChangedAt?: Date) => string;
  }
}

function unauthorized(reply: FastifyReply, message: string) {
  return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message } });
}

const authPluginCallback: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  await fastify.register(fastifyJwt, {
    secret: config.JWT_SECRET,
    sign: {
      expiresIn: '30d',
    },
  });

  fastify.decorate('issueToken', (farmId: string, passwordChangedAt?: Date) => {
    if (!passwordChangedAt) return fastify.jwt.sign({ farmId });
    // JWT `iat` has one-second resolution. A token is rejected when iat <= floor(changedAt),
    // so the token issued by the change itself carries iat = floor(changedAt) + 1.
    const iat = Math.floor(passwordChangedAt.getTime() / 1000) + 1;
    return fastify.jwt.sign({ farmId, iat });
  });

  fastify.decorate(
    'authenticate',
    async function (request: FastifyRequest, reply: FastifyReply) {
      let payload: { farmId?: string; iat?: number };
      try {
        await request.jwtVerify();
        payload = request.user as { farmId?: string; iat?: number };
      } catch {
        return unauthorized(reply, 'Authentication required or token expired');
      }
      if (!payload || !payload.farmId || !ObjectId.isValid(payload.farmId)) {
        return unauthorized(reply, 'Invalid authorization token');
      }

      // One indexed _id lookup per request, deliberately NOT cached: a password reset/change
      // must log out other devices immediately. Tokens issued before passwordChangedAt are
      // rejected; accounts without the field keep their existing tokens.
      let farm;
      try {
        farm = await getFarmsCollection().findOne(
          { _id: new ObjectId(payload.farmId) },
          { projection: { passwordChangedAt: 1 } }
        );
      } catch (err) {
        request.log.error({ err }, 'auth lookup failed');
        return reply.status(503).send({
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable' },
        });
      }
      if (!farm) return unauthorized(reply, 'Invalid authorization token');

      if (farm.passwordChangedAt) {
        const changedAtSec = Math.floor(farm.passwordChangedAt.getTime() / 1000);
        if (typeof payload.iat !== 'number' || payload.iat <= changedAtSec) {
          return unauthorized(reply, 'Session expired, please sign in again');
        }
      }
      request.farmId = payload.farmId;
    }
  );
};

export const authPlugin = fp(authPluginCallback);
