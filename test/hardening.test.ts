import { Collection } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.js';
import { loadConfig, parseTrustProxy } from '../src/config.js';
import {
  closeDb,
  connectToDb,
  getCountersCollection,
  getFarmsCollection,
  getLoginAttemptsCollection,
  getOtpsCollection,
} from '../src/db.js';
import { setMailer } from '../src/mail.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sentCodes = new Map<string, string>();
const sentCount = new Map<string, number>();
const sentPurpose = new Map<string, string | undefined>();
setMailer({
  async sendOtp(to, code, _ttl, purpose) {
    sentCodes.set(to, code);
    sentPurpose.set(to, purpose);
    sentCount.set(to, (sentCount.get(to) ?? 0) + 1);
  },
});

const wrongCode = (c: string) => (c === '000000' ? '111111' : '000000');

describe('Hardening: password reset/change, throttling, headers, ops, sync race', () => {
  let mongod: MongoMemoryServer;
  let testDbPath: string;
  let app: FastifyInstance;
  let counter = 0;

  beforeAll(async () => {
    testDbPath = path.join(__dirname, '../.mongo-test-db-hardening');
    fs.rmSync(testDbPath, { recursive: true, force: true });
    fs.mkdirSync(testDbPath, { recursive: true });
    const binariesPath = path.join(__dirname, '../.mongo-binaries');
    fs.mkdirSync(binariesPath, { recursive: true });
    mongod = await MongoMemoryServer.create({
      binary: { downloadDir: binariesPath },
      instance: { dbPath: testDbPath },
    });
    await connectToDb(mongod.getUri(), 'dairyflow_hardening');
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    await closeDb();
    try {
      await mongod?.stop();
    } catch {
      // already stopped by the /ready test
    }
    try {
      fs.rmSync(testDbPath, { recursive: true, force: true });
    } catch {
      // Windows file lock on exit
    }
  });

  // A fresh app has a fresh per-IP rate-limit store, so tests that make many calls stay isolated.
  async function freshApp() {
    const a = await buildApp({ logger: false });
    await a.ready();
    return a;
  }

  const call = (a: FastifyInstance, method: 'GET' | 'POST', url: string, payload?: unknown, token?: string) =>
    a.inject({
      method,
      url,
      payload: payload as object | undefined,
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    });

  async function signup(a: FastifyInstance, password = 'password123') {
    const email = `user${++counter}@hardening.test`;
    const reg = await call(a, 'POST', '/auth/register', {
      farmName: 'Farm ' + counter,
      ownerName: 'Owner',
      email,
      password,
    });
    expect(reg.statusCode).toBe(202);
    const ver = await call(a, 'POST', '/auth/verify-otp', { email, otp: sentCodes.get(email) });
    expect(ver.statusCode).toBe(201);
    return { email, token: JSON.parse(ver.body).token as string, password };
  }

  const errOf = (res: { body: string }) => JSON.parse(res.body).error;

  describe('forgot-password / reset-password', () => {
    it('always answers 202 with the same body and only emails verified accounts', async () => {
      const a = await freshApp();
      const { email } = await signup(a);
      const before = sentCount.get(email) ?? 0;

      const known = await call(a, 'POST', '/auth/forgot-password', { email: email.toUpperCase() });
      const unknownEmail = 'nobody@hardening.test';
      const unknown = await call(a, 'POST', '/auth/forgot-password', { email: unknownEmail });

      expect(known.statusCode).toBe(202);
      expect(unknown.statusCode).toBe(202);
      expect(JSON.parse(known.body)).toEqual({ status: 'OTP_SENT', email });
      expect(JSON.parse(unknown.body)).toEqual({ status: 'OTP_SENT', email: unknownEmail });
      expect(sentCount.get(email)).toBe(before + 1);
      expect(sentPurpose.get(email)).toBe('reset');
      expect(sentCodes.get(unknownEmail)).toBeUndefined();
      await a.close();
    });

    it('does not email unverified accounts, and validates the email', async () => {
      const a = await freshApp();
      const email = `pending${++counter}@hardening.test`;
      await call(a, 'POST', '/auth/register', { farmName: 'P', ownerName: 'P', email, password: 'password123' });
      const count = sentCount.get(email);
      const res = await call(a, 'POST', '/auth/forgot-password', { email });
      expect(res.statusCode).toBe(202);
      expect(sentCount.get(email)).toBe(count);
      expect((await call(a, 'POST', '/auth/forgot-password', { email: 'nope' })).statusCode).toBe(400);
      await a.close();
    });

    it('applies the 60s cooldown and 5/hour limit silently (still 202, no extra mail)', async () => {
      const a = await freshApp();
      const { email } = await signup(a);
      await call(a, 'POST', '/auth/forgot-password', { email });
      const sent = sentCount.get(email)!;
      const again = await call(a, 'POST', '/auth/forgot-password', { email });
      expect(again.statusCode).toBe(202);
      expect(sentCount.get(email)).toBe(sent); // cooldown

      // Pretend the cooldown passed but the hourly budget is used up.
      await getOtpsCollection().updateOne(
        { email, purpose: 'reset' },
        { $set: { lastSentAt: new Date(Date.now() - 120_000), sendsInWindow: 5 } }
      );
      const limited = await call(a, 'POST', '/auth/forgot-password', { email });
      expect(limited.statusCode).toBe(202);
      expect(sentCount.get(email)).toBe(sent);

      // Budget available again: a new code goes out.
      await getOtpsCollection().updateOne({ email, purpose: 'reset' }, { $set: { sendsInWindow: 1 } });
      await call(a, 'POST', '/auth/forgot-password', { email });
      expect(sentCount.get(email)).toBe(sent + 1);
      await a.close();
    });

    it('keeps separate OTP documents per purpose', async () => {
      const a = await freshApp();
      const email = `both${++counter}@hardening.test`;
      await call(a, 'POST', '/auth/register', { farmName: 'B', ownerName: 'B', email, password: 'password123' });
      const registerCode = sentCodes.get(email)!;
      await call(a, 'POST', '/auth/forgot-password', { email }); // unverified: decoy only
      const docs = await getOtpsCollection().find({ email }).toArray();
      expect(docs.map((d) => d.purpose).sort()).toEqual(['register', 'reset']);
      // The register code still verifies the registration.
      const ver = await call(a, 'POST', '/auth/verify-otp', { email, otp: registerCode });
      expect(ver.statusCode).toBe(201);
      await a.close();
    });

    it('resets the password with a valid code, signs in, and the code is single use', async () => {
      const a = await freshApp();
      const { email, password } = await signup(a);
      await call(a, 'POST', '/auth/forgot-password', { email });
      const code = sentCodes.get(email)!;

      const wrong = await call(a, 'POST', '/auth/reset-password', { email, otp: wrongCode(code), newPassword: 'brandNewPass1' });
      expect(wrong.statusCode).toBe(400);
      expect(errOf(wrong)).toMatchObject({ code: 'OTP_INVALID', attemptsLeft: 4 });

      const short = await call(a, 'POST', '/auth/reset-password', { email, otp: code, newPassword: 'short' });
      expect(short.statusCode).toBe(400);
      expect(errOf(short).code).toBe('VALIDATION_ERROR');

      const ok = await call(a, 'POST', '/auth/reset-password', { email, otp: code, newPassword: 'brandNewPass1' });
      expect(ok.statusCode).toBe(200);
      const body = JSON.parse(ok.body);
      expect(body.token).toBeTruthy();
      expect(body.farm.email).toBe(email);
      expect((await call(a, 'GET', '/farm', undefined, body.token)).statusCode).toBe(200);

      expect((await call(a, 'POST', '/auth/login', { email, password })).statusCode).toBe(401);
      expect((await call(a, 'POST', '/auth/login', { email, password: 'brandNewPass1' })).statusCode).toBe(200);

      const reuse = await call(a, 'POST', '/auth/reset-password', { email, otp: code, newPassword: 'anotherPass99' });
      expect(reuse.statusCode).toBe(400);
      expect(errOf(reuse).code).toBe('OTP_EXPIRED');
      await a.close();
    });

    it('locks after 5 wrong codes, even for the right code afterwards', async () => {
      const a = await freshApp();
      const { email } = await signup(a);
      await call(a, 'POST', '/auth/forgot-password', { email });
      const code = sentCodes.get(email)!;
      let last;
      for (let i = 0; i < 5; i++) {
        last = await call(a, 'POST', '/auth/reset-password', { email, otp: wrongCode(code), newPassword: 'brandNewPass1' });
      }
      expect(last!.statusCode).toBe(429);
      expect(errOf(last!).code).toBe('OTP_LOCKED');
      const right = await call(a, 'POST', '/auth/reset-password', { email, otp: code, newPassword: 'brandNewPass1' });
      expect(right.statusCode).toBe(429);
      expect(errOf(right).code).toBe('OTP_LOCKED');
      await a.close();
    });

    it('rejects an expired code', async () => {
      const a = await freshApp();
      const { email } = await signup(a);
      await call(a, 'POST', '/auth/forgot-password', { email });
      await getOtpsCollection().updateOne({ email, purpose: 'reset' }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      const res = await call(a, 'POST', '/auth/reset-password', {
        email,
        otp: sentCodes.get(email),
        newPassword: 'brandNewPass1',
      });
      expect(res.statusCode).toBe(400);
      expect(errOf(res).code).toBe('OTP_EXPIRED');
      await a.close();
    });

    it('does not reveal whether an email exists (same responses for unknown and known)', async () => {
      const a = await freshApp();
      const { email } = await signup(a);
      const ghost = `ghost${++counter}@hardening.test`;

      // Without a prior forgot-password request
      const r1 = await call(a, 'POST', '/auth/reset-password', { email, otp: '123456', newPassword: 'brandNewPass1' });
      const r2 = await call(a, 'POST', '/auth/reset-password', { email: ghost, otp: '123456', newPassword: 'brandNewPass1' });
      expect(r1.statusCode).toBe(r2.statusCode);
      expect(errOf(r1)).toEqual(errOf(r2));

      // After requesting codes for both: identical wrong-code behaviour, including attemptsLeft
      await call(a, 'POST', '/auth/forgot-password', { email });
      await call(a, 'POST', '/auth/forgot-password', { email: ghost });
      const w1 = await call(a, 'POST', '/auth/reset-password', { email, otp: wrongCode(sentCodes.get(email)!), newPassword: 'brandNewPass1' });
      const w2 = await call(a, 'POST', '/auth/reset-password', { email: ghost, otp: '123456', newPassword: 'brandNewPass1' });
      expect(w1.statusCode).toBe(400);
      expect(w2.statusCode).toBe(400);
      expect(errOf(w1)).toEqual(errOf(w2));
      expect(errOf(w2).attemptsLeft).toBe(4);
      await a.close();
    });
  });

  describe('change-password and session invalidation', () => {
    it('validates, rejects a wrong current password and an unchanged password', async () => {
      const a = await freshApp();
      const { token, password } = await signup(a);

      const noAuth = await call(a, 'POST', '/auth/change-password', { currentPassword: password, newPassword: 'newPassword1' });
      expect(noAuth.statusCode).toBe(401);

      const wrong = await call(a, 'POST', '/auth/change-password', { currentPassword: 'wrongwrong', newPassword: 'newPassword1' }, token);
      expect(wrong.statusCode).toBe(401);
      expect(errOf(wrong).code).toBe('INVALID_CREDENTIALS');

      const same = await call(a, 'POST', '/auth/change-password', { currentPassword: password, newPassword: password }, token);
      expect(same.statusCode).toBe(400);

      const short = await call(a, 'POST', '/auth/change-password', { currentPassword: password, newPassword: 'abc' }, token);
      expect(short.statusCode).toBe(400);
      await a.close();
    });

    it('changes the password, returns a fresh token and invalidates older tokens', async () => {
      const a = await freshApp();
      const { email, token: oldToken, password } = await signup(a);
      // A second device signed in earlier
      const device2 = JSON.parse((await call(a, 'POST', '/auth/login', { email, password })).body).token;
      expect((await call(a, 'GET', '/farm', undefined, device2)).statusCode).toBe(200);

      const res = await call(a, 'POST', '/auth/change-password', { currentPassword: password, newPassword: 'newPassword1' }, oldToken);
      expect(res.statusCode).toBe(200);
      const { token: newToken } = JSON.parse(res.body);
      expect(newToken).toBeTruthy();

      expect((await call(a, 'GET', '/farm', undefined, oldToken)).statusCode).toBe(401);
      expect((await call(a, 'GET', '/farm', undefined, device2)).statusCode).toBe(401);
      expect((await call(a, 'GET', '/farm', undefined, newToken)).statusCode).toBe(200);
      expect((await call(a, 'GET', '/sync/pull', undefined, oldToken)).statusCode).toBe(401);

      expect((await call(a, 'POST', '/auth/login', { email, password })).statusCode).toBe(401);
      expect((await call(a, 'POST', '/auth/login', { email, password: 'newPassword1' })).statusCode).toBe(200);
      await a.close();
    });

    it('a password reset logs out tokens issued before it', async () => {
      const a = await freshApp();
      const { email, token: oldToken } = await signup(a);
      await call(a, 'POST', '/auth/forgot-password', { email });
      const res = await call(a, 'POST', '/auth/reset-password', {
        email,
        otp: sentCodes.get(email),
        newPassword: 'brandNewPass1',
      });
      const { token: newToken } = JSON.parse(res.body);
      expect((await call(a, 'GET', '/farm', undefined, oldToken)).statusCode).toBe(401);
      expect((await call(a, 'GET', '/farm', undefined, newToken)).statusCode).toBe(200);
      await a.close();
    });

    it('tokens of accounts without passwordChangedAt keep working; tokens issued after it work', async () => {
      const a = await freshApp();
      const { email, token } = await signup(a);
      const farm = await getFarmsCollection().findOne({ email });
      expect(farm!.passwordChangedAt).toBeUndefined();
      expect((await call(a, 'GET', '/farm', undefined, token)).statusCode).toBe(200);

      // A change in the past: the existing token (issued later) is still valid.
      await getFarmsCollection().updateOne({ email }, { $set: { passwordChangedAt: new Date(Date.now() - 3600_000) } });
      expect((await call(a, 'GET', '/farm', undefined, token)).statusCode).toBe(200);
      // A change in the future relative to the token invalidates it.
      await getFarmsCollection().updateOne({ email }, { $set: { passwordChangedAt: new Date(Date.now() + 5000) } });
      expect((await call(a, 'GET', '/farm', undefined, token)).statusCode).toBe(401);
      await a.close();
    });
  });

  describe('per-account login throttling', () => {
    it('blocks after 10 failures with 429 + Retry-After (even for the right password), unknown emails too', async () => {
      const a = await freshApp();
      const { email, password } = await signup(a);
      for (let i = 0; i < 10; i++) {
        const r = await call(a, 'POST', '/auth/login', { email, password: 'wrong-password' });
        expect(r.statusCode).toBe(401);
      }
      const blocked = await call(a, 'POST', '/auth/login', { email, password: 'wrong-password' });
      expect(blocked.statusCode).toBe(429);
      expect(errOf(blocked).code).toBe('LOGIN_THROTTLED');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(900);

      const right = await call(a, 'POST', '/auth/login', { email, password });
      expect(right.statusCode).toBe(429);

      // The window expiring lifts the block
      await getLoginAttemptsCollection().updateOne({ _id: email }, { $set: { windowStartedAt: new Date(Date.now() - 16 * 60_000) } });
      expect((await call(a, 'POST', '/auth/login', { email, password })).statusCode).toBe(200);
      await a.close();
    });

    it('is independent of the IP rate limiter (other accounts are unaffected) and resets on success', async () => {
      const a = await freshApp();
      const u1 = await signup(a);
      const u2 = await signup(a);
      for (let i = 0; i < 6; i++) await call(a, 'POST', '/auth/login', { email: u1.email, password: 'wrong-password' });
      // success clears the counter
      expect((await call(a, 'POST', '/auth/login', { email: u1.email, password: u1.password })).statusCode).toBe(200);
      expect(await getLoginAttemptsCollection().findOne({ _id: u1.email })).toBeNull();
      expect((await call(a, 'POST', '/auth/login', { email: u2.email, password: u2.password })).statusCode).toBe(200);
      await a.close();

      // the per-IP limiter is a separate mechanism: a new app instance (empty IP store) still
      // sees the persisted per-account counter
      const b = await freshApp();
      const v = await signup(b);
      for (let i = 0; i < 10; i++) await call(b, 'POST', '/auth/login', { email: v.email, password: 'wrong-password' });
      await b.close();
      const c = await freshApp();
      expect((await call(c, 'POST', '/auth/login', { email: v.email, password: v.password })).statusCode).toBe(429);
      await c.close();
    });

    it('change-password guesses with a stolen token count toward the same throttle', async () => {
      const a = await freshApp();
      const { token, email, password } = await signup(a);
      for (let i = 0; i < 10; i++) {
        expect((await call(a, 'POST', '/auth/change-password', { currentPassword: 'wrong-password', newPassword: 'newPassword1' }, token)).statusCode).toBe(401);
      }
      await a.close();
      const b = await freshApp();
      const res = await call(b, 'POST', '/auth/change-password', { currentPassword: password, newPassword: 'newPassword1' }, token);
      expect(res.statusCode).toBe(429);
      expect((await call(b, 'POST', '/auth/login', { email, password })).statusCode).toBe(429);
      await b.close();
    });
  });

  describe('HTTP hardening', () => {
    it('sets security headers (helmet) and a request id', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBeDefined();
      expect(res.headers['strict-transport-security']).toBeDefined();
      expect(res.headers['content-security-policy']).toBeDefined();
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['x-request-id']).toBeTruthy();

      const traced = await app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'trace-abc-12345' } });
      expect(traced.headers['x-request-id']).toBe('trace-abc-12345');
      const evil = await app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'bad id\twith spaces' } });
      expect(evil.headers['x-request-id']).not.toBe('bad id\twith spaces');
    });

    it('limits body size: 1 MB globally, 2 MB for /sync/push', async () => {
      const a = await freshApp();
      const { token } = await signup(a);
      const big = (n: number) => JSON.stringify({ email: 'x@y.test', password: 'p', pad: 'a'.repeat(n) });
      const headers = { 'content-type': 'application/json' };

      const login = await a.inject({ method: 'POST', url: '/auth/login', headers, payload: big(1_100_000) });
      expect(login.statusCode).toBe(413);
      expect(errOf(login)).toBeDefined();

      const pushBody = (n: number) => JSON.stringify({ changes: [], pad: 'a'.repeat(n) });
      const authz = { ...headers, authorization: `Bearer ${token}` };
      const okPush = await a.inject({ method: 'POST', url: '/sync/push', headers: authz, payload: pushBody(1_500_000) });
      expect(okPush.statusCode).toBe(200);
      const tooBig = await a.inject({ method: 'POST', url: '/sync/push', headers: authz, payload: pushBody(2_200_000) });
      expect(tooBig.statusCode).toBe(413);
      await a.close();
    });

    it('validates sync pull query params (400 for negative / NaN / non-integer / out of range)', async () => {
      const a = await freshApp();
      const { token } = await signup(a);
      for (const q of ['since=-1', 'since=abc', 'since=1.5', 'limit=0', 'limit=-5', 'limit=NaN', 'limit=501', 'since=1&since=2']) {
        const res = await call(a, 'GET', `/sync/pull?${q}`, undefined, token);
        expect(res.statusCode, q).toBe(400);
        expect(errOf(res).code).toBe('VALIDATION_ERROR');
      }
      expect((await call(a, 'GET', '/sync/pull?since=0&limit=10', undefined, token)).statusCode).toBe(200);
      await a.close();
    });
  });

  describe('configuration', () => {
    const prodBase = {
      NODE_ENV: 'production',
      JWT_SECRET: 'x'.repeat(40),
      SMTP_HOST: 'smtp.example.test',
      CORS_ORIGIN: 'https://app.example.test',
    } as NodeJS.ProcessEnv;

    it('accepts a valid production config and parses the CORS allow-list', () => {
      const cfg = loadConfig({ ...prodBase, CORS_ORIGIN: 'https://a.test, https://b.test' });
      expect(cfg.corsOrigins).toEqual(['https://a.test', 'https://b.test']);
    });

    it('rejects "*" CORS in production unless explicitly allowed', () => {
      expect(() => loadConfig({ ...prodBase, CORS_ORIGIN: '*' })).toThrow(/CORS_ORIGIN/);
      expect(loadConfig({ ...prodBase, CORS_ORIGIN: '*', CORS_ALLOW_ANY_IN_PRODUCTION: 'true' }).corsOrigins).toBe(true);
    });

    it('requires JWT_SECRET >= 32 chars and SMTP_HOST in production, and reports all problems', () => {
      expect(() => loadConfig({ ...prodBase, JWT_SECRET: 'short-secret-1234' })).toThrow(/JWT_SECRET/);
      expect(() => loadConfig({ ...prodBase, JWT_SECRET: undefined })).toThrow(/JWT_SECRET/);
      expect(() => loadConfig({ ...prodBase, SMTP_HOST: undefined })).toThrow(/SMTP_HOST/);
      expect(() => loadConfig({ NODE_ENV: 'production', PORT: 'abc' } as NodeJS.ProcessEnv)).toThrow(/Invalid configuration[\s\S]*PORT/);
    });

    it('parses TRUST_PROXY', () => {
      expect(parseTrustProxy('false')).toBe(false);
      expect(parseTrustProxy('true')).toBe(true);
      expect(parseTrustProxy('2')).toBe(2);
      expect(parseTrustProxy('10.0.0.0/8, 192.168.0.1')).toEqual(['10.0.0.0/8', '192.168.0.1']);
    });
  });

  describe('Sync: commit watermark / pull-cursor race', () => {
    const buyer = (uuid: string) => ({
      table: 'buyers',
      uuid,
      op: 'upsert',
      data: { name: uuid, is_default: 0, created_at: '2026-10-15T08:00:00.000Z' },
      clientUpdatedAt: '2026-10-15T08:00:00.000Z',
    });
    const pull = async (a: FastifyInstance, token: string, since: number) => {
      const res = await call(a, 'GET', `/sync/pull?since=${since}`, undefined, token);
      expect(res.statusCode).toBe(200);
      return JSON.parse(res.body) as { changes: Array<{ uuid: string; seq: number }>; cursor: number };
    };

    it('a pull concurrent with a slow push never makes the client skip a row', async () => {
      const a = await freshApp();
      const { token } = await signup(a);

      // Hold the FIRST push (race-A) just before its bulkWrite commits.
      const original = Collection.prototype.bulkWrite;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let reachedResolve!: () => void;
      const reached = new Promise<void>((r) => (reachedResolve = r));
      const spy = vi.spyOn(Collection.prototype, 'bulkWrite').mockImplementation(function (this: Collection, ...args: unknown[]) {
        const ops = args[0] as Array<{ updateOne?: { filter: { uuid?: string } } }>;
        if (ops[0]?.updateOne?.filter?.uuid === 'race-A') {
          reachedResolve();
          return gate.then(() => (original as (...x: unknown[]) => Promise<unknown>).apply(this, args));
        }
        return (original as (...x: unknown[]) => Promise<unknown>).apply(this, args);
      } as never);

      try {
        const pushA = call(a, 'POST', '/sync/push', { changes: [buyer('race-A')] }, token);
        await reached; // A has allocated its seq but not written yet
        const pushB = call(a, 'POST', '/sync/push', { changes: [buyer('race-B')] }, token);
        await new Promise((r) => setTimeout(r, 300)); // old code: B has fully committed by now

        const mid = await pull(a, token, 0);
        release();
        const [ra, rb] = await Promise.all([pushA, pushB]);
        expect(ra.statusCode).toBe(200);
        expect(rb.statusCode).toBe(200);

        const rest = await pull(a, token, mid.cursor);
        const seen = new Set([...mid.changes, ...rest.changes].map((c) => c.uuid));
        expect(seen).toEqual(new Set(['race-A', 'race-B']));
      } finally {
        release();
        spy.mockRestore();
      }
      await a.close();
    });

    it('concurrent pushes get unique contiguous seqs and the watermark ends at the last one', async () => {
      const a = await freshApp();
      const { token } = await signup(a);
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          call(a, 'POST', '/sync/push', { changes: [buyer(`c${i}-1`), buyer(`c${i}-2`)] }, token)
        )
      );
      for (const r of results) expect(r.statusCode).toBe(200);

      const all = await pull(a, token, 0);
      const seqs = all.changes.map((c) => c.seq).sort((x, y) => x - y);
      expect(seqs).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
      expect(all.cursor).toBe(16);
      const farmId = (await getFarmsCollection().findOne({ email: (await getFarmsCollection().find().sort({ _id: -1 }).limit(1).toArray())[0].email }))!._id!.toString();
      const counterDoc = await getCountersCollection().findOne({ _id: farmId });
      expect(counterDoc).toMatchObject({ seq: 16, committed: 16, lockId: null });
      await a.close();
    });

    it('treats legacy counters (no watermark) as fully committed', async () => {
      const a = await freshApp();
      const { token } = await signup(a);
      await call(a, 'POST', '/sync/push', { changes: [buyer('legacy-1')] }, token);
      const farm = (await getFarmsCollection().find().sort({ _id: -1 }).limit(1).toArray())[0];
      await getCountersCollection().updateOne(
        { _id: farm._id!.toString() },
        { $unset: { committed: '', lockId: '', lockUntil: '' } }
      );
      expect((await pull(a, token, 0)).changes.map((c) => c.uuid)).toEqual(['legacy-1']);
      const push = await call(a, 'POST', '/sync/push', { changes: [buyer('legacy-2')] }, token);
      expect(JSON.parse(push.body).cursor).toBe(2);
      expect((await pull(a, token, 1)).changes.map((c) => c.uuid)).toEqual(['legacy-2']);
      await a.close();
    });
  });

  describe('health & readiness', () => {
    it('/health is liveness only and /ready pings MongoDB (200 up, 503 when down)', async () => {
      const health = await app.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);

      const ready = await app.inject({ method: 'GET', url: '/ready' });
      expect(ready.statusCode).toBe(200);
      expect(JSON.parse(ready.body)).toMatchObject({ ok: true, db: 'up' });

      await mongod.stop();
      const down = await app.inject({ method: 'GET', url: '/ready' });
      expect(down.statusCode).toBe(503);
      expect(JSON.parse(down.body)).toMatchObject({ ok: false, db: 'down' });
      // liveness keeps answering while the DB is down
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    });
  });
});
