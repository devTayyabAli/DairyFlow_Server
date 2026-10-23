import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { FarmDocument, getFarmsCollection, getMembershipsCollection, UserRole } from '../db.js';
import { checkLoginThrottle, clearLoginFailures, recordLoginFailure } from '../loginThrottle.js';
import { IssueResult, issueOtp, OTP_LENGTH, verifyOtp } from '../otp.js';
import { resolveAccountSession } from '../session.js';

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .email('A valid email address is required');

const registerSchema = z.object({
  farmName: z.string().trim().min(1, 'Farm name is required'),
  ownerName: z.string().trim().min(1, 'Owner name is required'),
  email: emailSchema,
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  phone: z.string().trim().max(32).optional(),
  defaultMilkRate: z.number().min(0).optional(),
  businessType: z.enum(['farm', 'collection_center', 'hybrid']).default('farm').optional(),
});

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required'),
});

const verifySchema = z.object({
  email: emailSchema,
  otp: z.string().trim().regex(new RegExp(`^\\d{${OTP_LENGTH}}$`), `Code must be ${OTP_LENGTH} digits`),
});

const resendSchema = z.object({ email: emailSchema });

const newPasswordSchema = z.string().min(8, 'Password must be at least 8 characters').max(128);

const forgotSchema = z.object({ email: emailSchema });

const resetSchema = z.object({
  email: emailSchema,
  otp: verifySchema.shape.otp,
  newPassword: newPasswordSchema,
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: newPasswordSchema,
});

// Compared against when the email is unknown, so response time does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('dairyflow-timing-equaliser', 10);

function forbiddenRole(reply: FastifyReply) {
  return reply.status(403).send({
    error: { code: 'FORBIDDEN', message: 'You cannot assign a role at or above your own.' },
  });
}

function validationError(reply: FastifyReply, issues: z.ZodIssue[]) {
  return reply.status(400).send({
    error: { code: 'VALIDATION_ERROR', message: issues.map((i) => i.message).join(', ') },
  });
}

function accountResponse(
  profile: FarmDocument & { _id: NonNullable<FarmDocument['_id']> },
  role: UserRole,
  userId: string,
  accountName?: string
) {
  return {
    ...farmPayload(profile, role),
    userId,
    accountName: accountName || profile.ownerName,
  };
}

function farmPayload(
  farm: FarmDocument & { _id: NonNullable<FarmDocument['_id']> },
  role: UserRole = 'owner'
) {
  return {
    id: farm._id.toString(),
    farmName: farm.farmName,
    ownerName: farm.ownerName,
    email: farm.email,
    phone: farm.phone,
    defaultMilkRate: farm.defaultMilkRate ?? 220,
    businessType: farm.businessType ?? 'farm',
    role,
    createdAt: farm.createdAt.toISOString(),
  };
}

function otpIssueFailure(reply: FastifyReply, result: Exclude<IssueResult, { ok: true }>) {
  if (result.reason === 'SEND_FAILED') {
    return reply.status(503).send({
      error: {
        code: 'EMAIL_SEND_FAILED',
        message: 'Could not send the verification email. Please try again shortly.',
      },
    });
  }
  const code = result.reason === 'COOLDOWN' ? 'OTP_RESEND_COOLDOWN' : 'OTP_HOURLY_LIMIT';
  const message =
    result.reason === 'COOLDOWN'
      ? `Please wait ${result.retryAfterSeconds}s before requesting another code.`
      : 'Too many codes requested. Please try again later.';
  return reply
    .status(429)
    .header('Retry-After', String(result.retryAfterSeconds))
    .send({ error: { code, message, retryAfterSeconds: result.retryAfterSeconds } });
}

function signToken(
  fastify: FastifyInstance,
  farmId: string,
  optionsOrPasswordChangedAt?: Date | { userId?: string; role?: UserRole; passwordChangedAt?: Date }
): string {
  return fastify.issueToken(farmId, optionsOrPasswordChangedAt);
}

function throttled(reply: FastifyReply, retryAfterSeconds: number) {
  return reply
    .status(429)
    .header('Retry-After', String(retryAfterSeconds))
    .send({
      error: {
        code: 'LOGIN_THROTTLED',
        message: 'Too many failed sign-in attempts. Please try again later.',
        retryAfterSeconds,
      },
    });
}

/** Shared by verify-otp and reset-password so both answer failures identically. */
function otpFailure(reply: FastifyReply, result: Exclude<Awaited<ReturnType<typeof verifyOtp>>, { ok: true }>) {
  if (result.reason === 'LOCKED') {
    return reply.status(429).send({
      error: {
        code: 'OTP_LOCKED',
        message: 'Too many wrong codes. Request a new code to continue.',
      },
    });
  }
  if (result.reason === 'EXPIRED' || result.reason === 'NOT_FOUND') {
    return reply.status(400).send({
      error: { code: 'OTP_EXPIRED', message: 'This code has expired. Request a new one.' },
    });
  }
  return reply.status(400).send({
    error: { code: 'OTP_INVALID', message: 'Incorrect code', attemptsLeft: result.attemptsLeft },
  });
}

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  // Step 1: create (or refresh) a pending account and email a one-time code. No token yet.
  fastify.post(
    '/auth/register',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = registerSchema.safeParse(request.body);
      if (!parsed.success) return validationError(reply, parsed.error.issues);

      const { farmName, ownerName, email, password, phone, defaultMilkRate, businessType } = parsed.data;
      const farms = getFarmsCollection();
      const existing = await farms.findOne({ email });

      if (existing && existing.emailVerified !== false) {
        return reply.status(409).send({
          error: { code: 'EMAIL_EXISTS', message: 'An account with this email already exists' },
        });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const now = new Date();

      if (existing) {
        // Unverified attempt (e.g. lost the code): let the owner retry with fresh details.
        await farms.updateOne(
          { _id: existing._id },
          {
            $set: {
              farmName,
              ownerName,
              phone,
              passwordHash,
              defaultMilkRate: defaultMilkRate ?? 220,
              businessType: businessType ?? 'farm',
              updatedAt: now,
            },
          }
        );
      } else {
        try {
          await farms.insertOne({
            farmName,
            ownerName,
            email,
            emailVerified: false,
            phone,
            passwordHash,
            defaultMilkRate: defaultMilkRate ?? 220,
            businessType: businessType ?? 'farm',
            createdAt: now,
            updatedAt: now,
          });
        } catch (err) {
          if ((err as { code?: number }).code === 11000) {
            return reply.status(409).send({
              error: { code: 'EMAIL_EXISTS', message: 'An account with this email already exists' },
            });
          }
          throw err;
        }
      }

      const sent = await issueOtp(email);
      if (!sent.ok) return otpIssueFailure(reply, sent);

      return reply.status(202).send({
        status: 'OTP_SENT',
        email,
        expiresInSeconds: sent.expiresInSeconds,
        resendAfterSeconds: sent.resendAfterSeconds,
      });
    }
  );

  // Step 2: confirm the code. Only now does the account become usable and a token is issued.
  fastify.post(
    '/auth/verify-otp',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = verifySchema.safeParse(request.body);
      if (!parsed.success) return validationError(reply, parsed.error.issues);

      const { email, otp } = parsed.data;
      const farms = getFarmsCollection();
      const farm = await farms.findOne({ email });

      if (!farm || farm.emailVerified !== false) {
        // Unknown email or already verified: nothing to verify (same answer for both).
        return reply.status(400).send({
          error: { code: 'OTP_INVALID', message: 'Invalid or expired code' },
        });
      }

      const result = await verifyOtp(email, otp);
      if (!result.ok) return otpFailure(reply, result);

      const now = new Date();
      await farms.updateOne({ _id: farm._id }, { $set: { emailVerified: true, updatedAt: now } });

      return reply.status(201).send({
        token: signToken(fastify, farm._id!.toString(), { role: 'owner' }),
        farm: accountResponse(
          { ...farm, _id: farm._id!, emailVerified: true },
          'owner',
          farm._id!.toString(),
          farm.ownerName
        ),
      });
    }
  );

  // New code for a pending registration. Always answers 202 so it cannot be used to probe emails.
  fastify.post(
    '/auth/resend-otp',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = resendSchema.safeParse(request.body);
      if (!parsed.success) return validationError(reply, parsed.error.issues);

      const { email } = parsed.data;
      const farm = await getFarmsCollection().findOne({ email });
      if (farm && farm.emailVerified === false) {
        const sent = await issueOtp(email);
        if (!sent.ok) return otpIssueFailure(reply, sent);
        return reply.status(202).send({
          status: 'OTP_SENT',
          email,
          expiresInSeconds: sent.expiresInSeconds,
          resendAfterSeconds: sent.resendAfterSeconds,
        });
      }

      return reply.status(202).send({ status: 'OTP_SENT', email });
    }
  );

  fastify.post(
    '/auth/login',
    { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'Email and password are required' },
        });
      }

      const { email, password } = parsed.data;
      const gate = await checkLoginThrottle(email);
      if (gate.blocked) return throttled(reply, gate.retryAfterSeconds);

      const farm = await getFarmsCollection().findOne({ email });

      const passwordOk = await bcrypt.compare(password, farm?.passwordHash ?? DUMMY_HASH);
      if (!farm || !passwordOk) {
        await recordLoginFailure(email);
        return reply.status(401).send({
          error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
        });
      }

      if (farm.emailVerified === false) {
        // Correct password, but the email was never confirmed. The app routes to the OTP step.
        return reply.status(403).send({
          error: {
            code: 'EMAIL_NOT_VERIFIED',
            message: 'Please verify your email with the code we sent you.',
          },
        });
      }

      const resolved = await resolveAccountSession({ ...farm, _id: farm._id! });
      if (!resolved.ok) {
        return reply.status(403).send({
          error: { code: 'ACCOUNT_SUSPENDED', message: 'This account is suspended.' },
        });
      }
      const { session } = resolved;

      await clearLoginFailures(email);
      return reply.status(200).send({
        token: signToken(fastify, session.tenantId, {
          userId: session.userId,
          role: session.role,
        }),
        farm: accountResponse(session.profile, session.role, session.userId, farm.ownerName),
      });
    }
  );

  // Always 202 with the same body: never reveals whether the email has an account. A code is
  // only emailed for a verified account; for anything else a decoy (never delivered) code is
  // stored so every later response (wrong code, attempts left, lock, cooldown) looks identical.
  fastify.post(
    '/auth/forgot-password',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = forgotSchema.safeParse(request.body);
      if (!parsed.success) return validationError(reply, parsed.error.issues);

      const { email } = parsed.data;
      const farm = await getFarmsCollection().findOne({ email }, { projection: { emailVerified: 1 } });
      const real = !!farm && farm.emailVerified !== false;
      const issued = await issueOtp(email, 'reset', { deliver: real });
      if (!issued.ok) {
        // Cooldown / hourly limit / send failure are swallowed on purpose (they would reveal
        // the account exists). They are still enforced: no new code is sent.
        request.log.warn({ reason: issued.reason }, 'forgot-password: code not issued');
      }
      return reply.status(202).send({ status: 'OTP_SENT', email });
    }
  );

  fastify.post(
    '/auth/reset-password',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = resetSchema.safeParse(request.body);
      if (!parsed.success) return validationError(reply, parsed.error.issues);

      const { email, otp, newPassword } = parsed.data;
      const result = await verifyOtp(email, otp, 'reset');
      if (!result.ok) return otpFailure(reply, result);

      const farms = getFarmsCollection();
      const farm = await farms.findOne({ email });
      if (!farm || farm.emailVerified === false) {
        // Only reachable with a decoy code, which nobody can know.
        return reply.status(400).send({
          error: { code: 'OTP_INVALID', message: 'Invalid or expired code' },
        });
      }

      const passwordChangedAt = new Date();
      const passwordHash = await bcrypt.hash(newPassword, 10);
      await farms.updateOne(
        { _id: farm._id },
        { $set: { passwordHash, passwordChangedAt, updatedAt: passwordChangedAt } }
      );
      await clearLoginFailures(email);

      const resolved = await resolveAccountSession({ ...farm, _id: farm._id!, passwordChangedAt });
      if (!resolved.ok) {
        return reply.status(403).send({
          error: { code: 'ACCOUNT_SUSPENDED', message: 'This account is suspended.' },
        });
      }
      const { session } = resolved;

      return reply.status(200).send({
        token: signToken(fastify, session.tenantId, {
          userId: session.userId,
          role: session.role,
          passwordChangedAt,
        }),
        farm: accountResponse(session.profile, session.role, session.userId, farm.ownerName),
      });
    }
  );

  fastify.post(
    '/auth/change-password',
    {
      onRequest: [fastify.authenticate],
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const parsed = changePasswordSchema.safeParse(request.body);
      if (!parsed.success) return validationError(reply, parsed.error.issues);
      const { currentPassword, newPassword } = parsed.data;

      const farms = getFarmsCollection();
      const account = await farms.findOne({ _id: new ObjectId(request.userId) });
      if (!account) {
        return reply.status(401).send({
          error: { code: 'UNAUTHORIZED', message: 'Invalid authorization token' },
        });
      }

      // A stolen token must not allow guessing the current password: share the login throttle.
      if (account.email) {
        const gate = await checkLoginThrottle(account.email);
        if (gate.blocked) return throttled(reply, gate.retryAfterSeconds);
      }

      if (!(await bcrypt.compare(currentPassword, account.passwordHash))) {
        if (account.email) await recordLoginFailure(account.email);
        return reply.status(401).send({
          error: { code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect' },
        });
      }
      if (newPassword === currentPassword) {
        return reply.status(400).send({
          error: {
            code: 'PASSWORD_UNCHANGED',
            message: 'New password must be different from the current password',
          },
        });
      }

      const passwordChangedAt = new Date();
      const passwordHash = await bcrypt.hash(newPassword, 10);
      await farms.updateOne(
        { _id: account._id },
        { $set: { passwordHash, passwordChangedAt, updatedAt: passwordChangedAt } }
      );
      if (account.email) await clearLoginFailures(account.email);

      const resolved = await resolveAccountSession({ ...account, _id: account._id!, passwordChangedAt });
      if (!resolved.ok) {
        return reply.status(403).send({
          error: { code: 'ACCOUNT_SUSPENDED', message: 'This account is suspended.' },
        });
      }
      const { session } = resolved;
      return reply.status(200).send({
        token: signToken(fastify, session.tenantId, {
          userId: session.userId,
          role: session.role,
          passwordChangedAt,
        }),
      });
    }
  );

  // Get active user profile, tenant, and role
  fastify.get('/auth/me', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const farm = await getFarmsCollection().findOne({ _id: new ObjectId(request.farmId) });
    if (!farm) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Account not found' } });
    }
    return reply.send({
      user: {
        id: request.userId,
        email: farm.email,
        name: farm.ownerName,
        phone: farm.phone,
        role: request.role,
      },
      tenant: {
        id: farm._id!.toString(),
        name: farm.farmName,
        businessType: farm.businessType ?? 'farm',
        defaultMilkRate: farm.defaultMilkRate ?? 220,
      },
      role: request.role,
    });
  });

  const memberInviteSchema = z.object({
    name: z.string().min(1).optional(),
    email: emailSchema,
    password: z.string().min(8).optional(),
    role: z.enum(['owner', 'manager', 'accountant', 'staff', 'collector', 'farmer', 'auditor']),
    assignedRoutes: z.array(z.string().trim()).optional(),
  });

  // Add team member with role (Restricted to Owner & Manager per PRD permission matrix)
  fastify.post(
    '/tenants/members',
    {
      onRequest: [fastify.authenticate, fastify.authorize(['owner', 'manager'])],
    },
    async (request, reply) => {
      const parsed = memberInviteSchema.safeParse(request.body);
      if (!parsed.success) return validationError(reply, parsed.error.issues);

      const { name, email, password, role, assignedRoutes } = parsed.data;
      if (request.role === 'manager' && (role === 'owner' || role === 'manager')) {
        return forbiddenRole(reply);
      }
      const tenantId = new ObjectId(request.tenantId);
      const memberships = getMembershipsCollection();
      const farms = getFarmsCollection();

      const now = new Date();
      let user = await farms.findOne({ email });
      let targetUserId = user?._id;

      if (!user) {
        const passwordHash = password
          ? await bcrypt.hash(password, 10)
          : await bcrypt.hash(randomUUID(), 10);

        const insertRes = await farms.insertOne({
          farmName: '',
          ownerName: name || email.split('@')[0],
          email,
          passwordHash,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        });
        targetUserId = insertRes.insertedId;
      }

      await memberships.updateOne(
        { tenantId, userId: targetUserId! },
        {
          $set: {
            tenantId,
            userId: targetUserId!,
            role,
            assignedRoutes: assignedRoutes ?? [],
            status: 'active',
            updatedAt: now,
          },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true }
      );

      return reply.status(201).send({
        status: 'MEMBER_ADDED',
        member: {
          userId: targetUserId!.toString(),
          email,
          name: name || email.split('@')[0],
          role,
          assignedRoutes: assignedRoutes ?? [],
        },
      });
    }
  );

  // List team members (Restricted to Owner, Manager, Auditor per PRD)
  fastify.get(
    '/tenants/members',
    {
      onRequest: [fastify.authenticate, fastify.authorize(['owner', 'manager', 'auditor'])],
    },
    async (request, reply) => {
      const tenantId = new ObjectId(request.tenantId);
      const members = await getMembershipsCollection().find({ tenantId }).toArray();
      const userIds = members.map((m) => m.userId);
      const users = await getFarmsCollection()
        .find({ _id: { $in: userIds } })
        .toArray();
      const userMap = new Map(users.map((u) => [u._id!.toString(), u]));

      return reply.send({
        members: members.map((m) => {
          const u = userMap.get(m.userId.toString());
          return {
            id: m._id!.toString(),
            userId: m.userId.toString(),
            name: u?.ownerName || '',
            email: u?.email || '',
            role: m.role,
            assignedRoutes: m.assignedRoutes ?? [],
            status: m.status,
            createdAt: m.createdAt.toISOString(),
          };
        }),
      });
    }
  );

  fastify.post(
    '/tenants/members/:userId/status',
    {
      onRequest: [fastify.authenticate, fastify.authorize(['owner'])],
    },
    async (request, reply) => {
      const params = z.object({ userId: z.string().min(1) }).safeParse(request.params);
      const body = z.object({ status: z.enum(['active', 'suspended']) }).safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid member status.' } });
      }
      if (params.data.userId === request.userId) {
        return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'You cannot change your own account status.' } });
      }
      let memberId: ObjectId;
      try {
        memberId = new ObjectId(params.data.userId);
      } catch {
        return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid member.' } });
      }
      const result = await getMembershipsCollection().updateOne(
        { tenantId: new ObjectId(request.tenantId), userId: memberId },
        { $set: { status: body.data.status, updatedAt: new Date() } }
      );
      if (result.matchedCount === 0) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Member not found.' } });
      }
      return reply.send({ status: body.data.status });
    }
  );
};
