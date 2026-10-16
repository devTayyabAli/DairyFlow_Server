import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const DEV_JWT_SECRET = 'default_dairyflow_development_secret_key_12345';

const boolFlag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MONGODB_URI: z.string().min(1).default('mongodb://localhost:27017'),
  MONGODB_DB: z.string().min(1).default('dairyflow'),
  MONGODB_MAX_POOL_SIZE: z.coerce.number().int().min(1).max(500).default(20),
  MONGODB_SERVER_SELECTION_TIMEOUT_MS: z.coerce.number().int().min(500).default(10_000),
  JWT_SECRET: z.string().min(10).default(DEV_JWT_SECRET),
  /** Comma-separated list of allowed origins, or `*`. */
  CORS_ORIGIN: z.string().default('*'),
  /** Explicit opt-in to run with CORS_ORIGIN=* in production. */
  CORS_ALLOW_ANY_IN_PRODUCTION: boolFlag,
  /** `false`, `true`, a hop count (e.g. `1`) or a comma-separated list of proxy IPs/CIDRs. */
  TRUST_PROXY: z.string().default('false'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  // Email delivery for OTP codes. Without SMTP_HOST the code is printed to the server log
  // (development only; production requires SMTP_HOST).
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_SECURE: boolFlag,
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default('DairyFlow <no-reply@dairyflow.local>'),
  OTP_TTL_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
});

export type Config = z.infer<typeof envSchema> & {
  /** Parsed CORS_ORIGIN: `true` (reflect any origin) or an allow-list. */
  corsOrigins: true | string[];
  /** Value for Fastify's `trustProxy` option. */
  trustProxy: boolean | number | string[];
};

export function parseTrustProxy(raw: string): boolean | number | string[] {
  const v = raw.trim().toLowerCase();
  if (v === '' || v === 'false' || v === '0') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  const problems: string[] = [];
  if (!result.success) {
    for (const issue of result.error.issues) {
      problems.push(`${issue.path.join('.') || '(root)'}: ${issue.message}`);
    }
  }
  const isProd = env.NODE_ENV === 'production';
  const data = result.success ? result.data : undefined;

  if (data) {
    if (isProd) {
      if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) {
        problems.push('JWT_SECRET: must be set to a random value of at least 32 characters in production');
      }
      if (data.CORS_ORIGIN.trim() === '*' && !data.CORS_ALLOW_ANY_IN_PRODUCTION) {
        problems.push(
          'CORS_ORIGIN: "*" is not allowed in production; list the allowed origins (comma-separated) or set CORS_ALLOW_ANY_IN_PRODUCTION=true'
        );
      }
      if (!data.SMTP_HOST) {
        problems.push('SMTP_HOST: required in production (OTP emails cannot be delivered otherwise)');
      }
    }
  }

  if (problems.length > 0 || !data) {
    throw new Error(
      `Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}\nSee backend/README.md (Environment variables).`
    );
  }

  if (!isProd && env.NODE_ENV !== 'test' && data.JWT_SECRET === DEV_JWT_SECRET) {
    console.warn(
      '\n!!! WARNING: JWT_SECRET is not set, using the built-in DEVELOPMENT secret. ' +
        'Anyone can forge tokens. Never run like this in production. !!!\n'
    );
  }

  const origins = data.CORS_ORIGIN.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const corsOrigins: true | string[] = origins.includes('*') ? true : origins;

  return { ...data, corsOrigins, trustProxy: parseTrustProxy(data.TRUST_PROXY) };
}

export const config = loadConfig();
