import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  MONGODB_URI: z.string().default('mongodb://localhost:27017'),
  MONGODB_DB: z.string().default('dairyflow'),
  JWT_SECRET: z.string().min(10).default('default_dairyflow_development_secret_key_12345'),
  CORS_ORIGIN: z.string().default('*'),
  // Email delivery for OTP codes. Without SMTP_HOST the code is printed to the server log
  // (development only; production refuses to send).
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default('DairyFlow <no-reply@dairyflow.local>'),
  OTP_TTL_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(): Config {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid environment variables:', result.error.format());
    throw new Error('Environment configuration error');
  }
  if (
    process.env.NODE_ENV === 'production' &&
    (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)
  ) {
    // Never fall back to the built-in development secret in production.
    throw new Error('JWT_SECRET must be set to a random value of at least 32 characters in production');
  }
  return result.data;
}

export const config = loadConfig();
