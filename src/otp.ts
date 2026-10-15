import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { getOtpsCollection } from './db.js';
import { getMailer } from './mail.js';

export const OTP_LENGTH = 6;
export const MAX_VERIFY_ATTEMPTS = 5;
export const RESEND_COOLDOWN_SECONDS = 60;
export const MAX_SENDS_PER_HOUR = 5;

const PURPOSE = 'register';

function hashCode(email: string, code: string): string {
  // Keyed hash so a leaked otps collection cannot be brute-forced offline without the secret.
  return createHmac('sha256', config.JWT_SECRET).update(`${PURPOSE}:${email}:${code}`).digest('hex');
}

function generateCode(): string {
  return String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');
}

export type IssueResult =
  | { ok: true; expiresInSeconds: number; resendAfterSeconds: number }
  | { ok: false; reason: 'COOLDOWN'; retryAfterSeconds: number }
  | { ok: false; reason: 'HOURLY_LIMIT'; retryAfterSeconds: number }
  | { ok: false; reason: 'SEND_FAILED' };

/** Creates (or replaces) the pending OTP for an email and sends it. Enforces resend limits. */
export async function issueOtp(email: string): Promise<IssueResult> {
  const col = getOtpsCollection();
  const now = new Date();
  const existing = await col.findOne({ email, purpose: PURPOSE });

  if (existing) {
    const sinceLastMs = now.getTime() - existing.lastSentAt.getTime();
    if (sinceLastMs < RESEND_COOLDOWN_SECONDS * 1000) {
      return {
        ok: false,
        reason: 'COOLDOWN',
        retryAfterSeconds: Math.ceil((RESEND_COOLDOWN_SECONDS * 1000 - sinceLastMs) / 1000),
      };
    }
    const windowMs = now.getTime() - existing.windowStartedAt.getTime();
    if (windowMs < 3600_000 && existing.sendsInWindow >= MAX_SENDS_PER_HOUR) {
      return {
        ok: false,
        reason: 'HOURLY_LIMIT',
        retryAfterSeconds: Math.ceil((3600_000 - windowMs) / 1000),
      };
    }
  }

  const resetWindow = !existing || now.getTime() - existing.windowStartedAt.getTime() >= 3600_000;
  const code = generateCode();
  const ttlMs = config.OTP_TTL_MINUTES * 60_000;
  const windowStartedAt = resetWindow ? now : existing!.windowStartedAt;
  const purgeAt = new Date(
    Math.max(windowStartedAt.getTime() + 3600_000, now.getTime() + ttlMs) + 60_000
  );

  await col.updateOne(
    { email, purpose: PURPOSE },
    {
      $set: {
        codeHash: hashCode(email, code),
        expiresAt: new Date(now.getTime() + ttlMs),
        attempts: 0,
        lastSentAt: now,
        windowStartedAt,
        sendsInWindow: resetWindow ? 1 : existing!.sendsInWindow + 1,
        purgeAt,
      },
      $setOnInsert: { email, purpose: PURPOSE, createdAt: now },
    },
    { upsert: true }
  );

  try {
    await getMailer().sendOtp(email, code, config.OTP_TTL_MINUTES);
  } catch (err) {
    console.error('Failed to send OTP email:', err instanceof Error ? err.message : err);
    return { ok: false, reason: 'SEND_FAILED' };
  }

  return { ok: true, expiresInSeconds: ttlMs / 1000, resendAfterSeconds: RESEND_COOLDOWN_SECONDS };
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'INVALID'; attemptsLeft: number }
  | { ok: false; reason: 'EXPIRED' }
  | { ok: false; reason: 'LOCKED' }
  | { ok: false; reason: 'NOT_FOUND' };

/** Checks a submitted code. Single use: a correct code is consumed. Wrong codes are counted. */
export async function verifyOtp(email: string, code: string): Promise<VerifyResult> {
  const col = getOtpsCollection();
  const doc = await col.findOne({ email, purpose: PURPOSE });
  if (!doc) return { ok: false, reason: 'NOT_FOUND' };

  if (doc.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'EXPIRED' };
  if (doc.attempts >= MAX_VERIFY_ATTEMPTS) return { ok: false, reason: 'LOCKED' };

  const expected = Buffer.from(doc.codeHash, 'hex');
  const given = Buffer.from(hashCode(email, code), 'hex');
  const match = expected.length === given.length && timingSafeEqual(expected, given);

  if (!match) {
    // Atomic increment so parallel guesses cannot slip past the limit.
    const updated = await col.findOneAndUpdate(
      { _id: doc._id },
      { $inc: { attempts: 1 } },
      { returnDocument: 'after' }
    );
    const attempts = updated?.attempts ?? MAX_VERIFY_ATTEMPTS;
    if (attempts >= MAX_VERIFY_ATTEMPTS) return { ok: false, reason: 'LOCKED' };
    return { ok: false, reason: 'INVALID', attemptsLeft: MAX_VERIFY_ATTEMPTS - attempts };
  }

  // Consume atomically; only one concurrent request may win.
  const consumed = await col.deleteOne({ _id: doc._id });
  return consumed.deletedCount === 1 ? { ok: true } : { ok: false, reason: 'NOT_FOUND' };
}
