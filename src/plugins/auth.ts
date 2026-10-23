import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fp from 'fastify-plugin';
import { ObjectId } from 'mongodb';
import { config } from '../config.js';
import { getFarmsCollection, getMembershipsCollection, UserRole } from '../db.js';

export interface TokenOptions {
  userId?: string;
  role?: UserRole;
  passwordChangedAt?: Date;
}

declare module 'fastify' {
  interface FastifyRequest {
    farmId: string;
    tenantId: string;
    userId: string;
    role: UserRole;
  }
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    authorize: (
      allowedRoles: UserRole[]
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Signs a session token. Supports backwards-compatible (farmId, passwordChangedAt)
     * and full multi-tenant (farmIdOrTenantId, options).
     */
    issueToken: (
      farmIdOrTenantId: string,
      optionsOrPasswordChangedAt?: Date | TokenOptions
    ) => string;
  }
}

function unauthorized(reply: FastifyReply, message: string) {
  return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message } });
}

function forbidden(reply: FastifyReply, message: string) {
  return reply.status(403).send({ error: { code: 'FORBIDDEN', message } });
}

const authPluginCallback: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  await fastify.register(fastifyJwt, {
    secret: config.JWT_SECRET,
    sign: {
      expiresIn: '30d',
    },
  });

  fastify.decorate(
    'issueToken',
    (
      farmIdOrTenantId: string,
      optionsOrPasswordChangedAt?: Date | TokenOptions
    ) => {
      let passwordChangedAt: Date | undefined;
      let userId = farmIdOrTenantId;
      let role: UserRole = 'owner';

      if (optionsOrPasswordChangedAt instanceof Date) {
        passwordChangedAt = optionsOrPasswordChangedAt;
      } else if (optionsOrPasswordChangedAt && typeof optionsOrPasswordChangedAt === 'object') {
        passwordChangedAt = optionsOrPasswordChangedAt.passwordChangedAt;
        if (optionsOrPasswordChangedAt.userId) userId = optionsOrPasswordChangedAt.userId;
        if (optionsOrPasswordChangedAt.role) role = optionsOrPasswordChangedAt.role;
      }

      const payload: {
        farmId: string;
        tenantId: string;
        userId: string;
        role: UserRole;
        iat?: number;
      } = {
        farmId: farmIdOrTenantId,
        tenantId: farmIdOrTenantId,
        userId,
        role,
      };

      if (!passwordChangedAt) return fastify.jwt.sign(payload);
      const iat = Math.floor(passwordChangedAt.getTime() / 1000) + 1;
      payload.iat = iat;
      return fastify.jwt.sign(payload);
    }
  );

  fastify.decorate(
    'authenticate',
    async function (request: FastifyRequest, reply: FastifyReply) {
      let payload: {
        farmId?: string;
        tenantId?: string;
        userId?: string;
        role?: UserRole;
        iat?: number;
      };
      try {
        await request.jwtVerify();
        payload = request.user as typeof payload;
      } catch {
        return unauthorized(reply, 'Authentication required or token expired');
      }
      if (request.farmId && request.userId && request.role) return;

      const effectiveTenantId = payload.tenantId || payload.farmId;
      if (!effectiveTenantId || !ObjectId.isValid(effectiveTenantId)) {
        return unauthorized(reply, 'Invalid authorization token');
      }
      if (payload.userId && !ObjectId.isValid(payload.userId)) {
        return unauthorized(reply, 'Invalid authorization token');
      }
      const userId = payload.userId || effectiveTenantId;

      // Lookups are deliberately not cached: a password change or role change
      // must take effect on the next request.
      let role: UserRole = 'owner';
      let passwordChangedAt: Date | undefined;
      try {
        const tenant = await getFarmsCollection().findOne(
          { _id: new ObjectId(effectiveTenantId) },
          { projection: { passwordChangedAt: 1 } }
        );
        if (!tenant) return unauthorized(reply, 'Invalid authorization token');
        passwordChangedAt = tenant.passwordChangedAt;

        if (userId !== effectiveTenantId) {
          const membership = await getMembershipsCollection().findOne({
            tenantId: new ObjectId(effectiveTenantId),
            userId: new ObjectId(userId),
          });
          if (!membership || membership.status === 'suspended') {
            return unauthorized(reply, 'Session expired, please sign in again');
          }
          role = membership.role;
          const user = await getFarmsCollection().findOne(
            { _id: new ObjectId(userId) },
            { projection: { passwordChangedAt: 1 } }
          );
          if (!user) return unauthorized(reply, 'Invalid authorization token');
          passwordChangedAt = user.passwordChangedAt;
        }
      } catch (err) {
        request.log.error({ err }, 'auth lookup failed');
        return reply.status(503).send({
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable' },
        });
      }

      if (passwordChangedAt) {
        const changedAtSec = Math.floor(passwordChangedAt.getTime() / 1000);
        if (typeof payload.iat !== 'number' || payload.iat <= changedAtSec) {
          return unauthorized(reply, 'Session expired, please sign in again');
        }
      }
      request.farmId = effectiveTenantId;
      request.tenantId = effectiveTenantId;
      request.userId = userId;
      request.role = role;
    }
  );

  fastify.decorate('authorize', (allowedRoles: UserRole[]) => {
    return async function (request: FastifyRequest, reply: FastifyReply) {
      await fastify.authenticate(request, reply);
      if (reply.sent) return;
      if (!request.role || !allowedRoles.includes(request.role)) {
        return forbidden(
          reply,
          `Access denied. Requires one of authorized roles: [${allowedRoles.join(', ')}]`
        );
      }
    };
  });
};

export const authPlugin = fp(authPluginCallback);
