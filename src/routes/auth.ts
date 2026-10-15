import bcrypt from 'bcryptjs';
import { FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { FarmDocument, getFarmsCollection } from '../db.js';
import { IssueResult, issueOtp, OTP_LENGTH, verifyOtp } from '../otp.js';

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

// Compared against when the email is unknown, so response time does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('dairyflow-timing-equaliser', 10);

function validationError(reply: FastifyReply, issues: z.ZodIssue[]) {
  return reply.status(400).send({
    error: { code: 'VALIDATION_ERROR', message: issues.map((i) => i.message).join(', ') },
  });
}

function farmPayload(farm: FarmDocument & { _id: NonNullable<FarmDocument['_id']> }) {
  return {
    id: farm._id.toString(),
    farmName: farm.farmName,
    ownerName: farm.ownerName,
    email: farm.email,
    phone: farm.phone,
    defaultMilkRate: farm.defaultMilkRate ?? 220,
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

function signToken(fastify: FastifyInstance, farmId: string): string {
  return fastify.jwt.sign({ farmId });
}

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  // Step 1: create (or refresh) a pending account and email a one-time code. No token yet.
  fastify.post(
    '/auth/register',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = registerSchema.safeParse(request.body);
      if (!parsed.success) return validationError(reply, parsed.error.issues);

      const { farmName, ownerName, email, password, phone, defaultMilkRate } = parsed.data;
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
      if (!result.ok) {
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
          error: {
            code: 'OTP_INVALID',
            message: 'Incorrect code',
            attemptsLeft: result.attemptsLeft,
          },
        });
      }

      const now = new Date();
      await farms.updateOne({ _id: farm._id }, { $set: { emailVerified: true, updatedAt: now } });

      return reply.status(201).send({
        token: signToken(fastify, farm._id!.toString()),
        farm: farmPayload({ ...farm, _id: farm._id!, emailVerified: true }),
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
      const farm = await getFarmsCollection().findOne({ email });

      const passwordOk = await bcrypt.compare(password, farm?.passwordHash ?? DUMMY_HASH);
      if (!farm || !passwordOk) {
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

      return reply.status(200).send({
        token: signToken(fastify, farm._id!.toString()),
        farm: farmPayload({ ...farm, _id: farm._id! }),
      });
    }
  );
};
