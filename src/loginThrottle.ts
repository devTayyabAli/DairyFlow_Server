import { getLoginAttemptsCollection } from './db.js';

export const MAX_LOGIN_FAILURES = 10;
export const LOGIN_WINDOW_SECONDS = 15 * 60;

/**
 * Per-account (email) failed-login throttle stored in Mongo, independent of the per-IP rate
 * limiter, so a distributed attack on one account is still stopped. Counts unknown emails
 * too, so throttling does not reveal which accounts exist.
 */
export async function checkLoginThrottle(email: string): Promise<{ blocked: false } | { blocked: true; retryAfterSeconds: number }> {
  const doc = await getLoginAttemptsCollection().findOne({ _id: email });
  if (!doc) return { blocked: false };
  const elapsedMs = Date.now() - doc.windowStartedAt.getTime();
  if (elapsedMs >= LOGIN_WINDOW_SECONDS * 1000 || doc.failures < MAX_LOGIN_FAILURES) {
    return { blocked: false };
  }
  return { blocked: true, retryAfterSeconds: Math.max(1, Math.ceil((LOGIN_WINDOW_SECONDS * 1000 - elapsedMs) / 1000)) };
}

/** Atomically records a failure (starting a fresh window when the previous one expired). */
export async function recordLoginFailure(email: string): Promise<void> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - LOGIN_WINDOW_SECONDS * 1000);
  const expired = { $lt: ['$windowStartedAt', windowStart] };
  await getLoginAttemptsCollection().updateOne(
    { _id: email },
    [
      {
        $set: {
          failures: {
            $cond: [{ $or: [{ $eq: [{ $type: '$windowStartedAt' }, 'missing'] }, expired] }, 1, { $add: ['$failures', 1] }],
          },
          windowStartedAt: {
            $cond: [{ $or: [{ $eq: [{ $type: '$windowStartedAt' }, 'missing'] }, expired] }, now, '$windowStartedAt'],
          },
        },
      },
      {
        $set: {
          purgeAt: { $add: ['$windowStartedAt', (LOGIN_WINDOW_SECONDS + 60) * 1000] },
        },
      },
    ] as never,
    { upsert: true }
  );
}

export async function clearLoginFailures(email: string): Promise<void> {
  await getLoginAttemptsCollection().deleteOne({ _id: email });
}
