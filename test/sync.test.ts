import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.js';
import { closeDb, connectToDb, getOtpsCollection, getRecordsCollection } from '../src/db.js';
import { setMailer } from '../src/mail.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Captures OTP emails instead of sending them; tests read the latest code per address.
const sentCodes = new Map<string, string>();
const sentCount = new Map<string, number>();
setMailer({
  async sendOtp(to, code) {
    sentCodes.set(to, code);
    sentCount.set(to, (sentCount.get(to) ?? 0) + 1);
  },
});

describe('DairyFlow Backend Sync & API Suite', () => {
  let mongod: MongoMemoryServer;
  let testDbPath: string;
  let app: FastifyInstance;
  let farmAToken: string;
  let farmAId: string;
  let farmBToken: string;
  let farmBId: string;

  beforeAll(async () => {
    testDbPath = path.join(__dirname, '../.mongo-test-db');
    if (fs.existsSync(testDbPath)) {
      fs.rmSync(testDbPath, { recursive: true, force: true });
    }
    fs.mkdirSync(testDbPath, { recursive: true });

    const binariesPath = path.join(__dirname, '../.mongo-binaries');
    fs.mkdirSync(binariesPath, { recursive: true });

    mongod = await MongoMemoryServer.create({
      binary: {
        downloadDir: binariesPath,
      },
      instance: {
        dbPath: testDbPath,
      },
    });
    const uri = mongod.getUri();
    await connectToDb(uri, 'dairyflow_test');
    app = await buildApp({ logger: false });
    await app.ready();
  });

  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as object });

  /** Full signup: register, read the emailed code, verify. Resolves with the verify response. */
  async function registerAndVerify(input: {
    farmName: string;
    ownerName: string;
    email: string;
    password: string;
    defaultMilkRate?: number;
  }) {
    const reg = await post('/auth/register', input);
    expect(reg.statusCode).toBe(202);
    return post('/auth/verify-otp', { email: input.email, otp: sentCodes.get(input.email) });
  }

  afterAll(async () => {
    if (app) await app.close();
    await closeDb();
    if (mongod) await mongod.stop();
    if (fs.existsSync(testDbPath)) {
      try {
        fs.rmSync(testDbPath, { recursive: true, force: true });
      } catch {
        // ignore Windows file lock on exit
      }
    }
  });

  it('GET /health returns status ok', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.time).toBeDefined();
  });

  describe('Auth: email + password with OTP verification', () => {
    const farmA = {
      farmName: 'Al-Madina Dairy',
      ownerName: 'Tariq Mehmood',
      email: 'Tariq@AlMadina.test', // mixed case on purpose: emails are normalised
      password: 'password123',
      defaultMilkRate: 215,
    };
    const emailA = 'tariq@almadina.test';

    it('register sends an OTP and does NOT issue a token yet', async () => {
      const res = await post('/auth/register', farmA);
      expect(res.statusCode).toBe(202);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('OTP_SENT');
      expect(body.email).toBe(emailA);
      expect(body.token).toBeUndefined();
      expect(sentCodes.get(emailA)).toMatch(/^\d{6}$/);
      // The code must never be echoed back in the API response
      expect(res.body).not.toContain(sentCodes.get(emailA)!);
    });

    it('stores only a hash of the OTP, never the code itself', async () => {
      const doc = await getOtpsCollection().findOne({ email: emailA });
      expect(doc).toBeTruthy();
      expect(JSON.stringify(doc)).not.toContain(sentCodes.get(emailA)!);
      expect(doc!.codeHash).toHaveLength(64);
    });

    it('rejects login before the email is verified (403)', async () => {
      const res = await post('/auth/login', { email: emailA, password: farmA.password });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error.code).toBe('EMAIL_NOT_VERIFIED');
    });

    it('rejects a wrong code and reports remaining attempts', async () => {
      const correct = sentCodes.get(emailA)!;
      const wrong = correct === '000000' ? '111111' : '000000';
      const res = await post('/auth/verify-otp', { email: emailA, otp: wrong });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('OTP_INVALID');
      expect(body.error.attemptsLeft).toBe(4);
    });

    it('verifies with the correct code, activates the account and returns a token', async () => {
      const res = await post('/auth/verify-otp', { email: emailA, otp: sentCodes.get(emailA) });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.token).toBeDefined();
      expect(body.farm.farmName).toBe('Al-Madina Dairy');
      expect(body.farm.email).toBe(emailA);
      expect(body.farm.defaultMilkRate).toBe(215);
      farmAToken = body.token;
      farmAId = body.farm.id;
    });

    it('a used code cannot be used again', async () => {
      const res = await post('/auth/verify-otp', { email: emailA, otp: sentCodes.get(emailA) });
      expect(res.statusCode).toBe(400);
    });

    it('rejects duplicate registration of a verified email with 409 (case-insensitive)', async () => {
      const res = await post('/auth/register', { ...farmA, email: 'TARIQ@almadina.test', farmName: 'Other' });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error.code).toBe('EMAIL_EXISTS');
    });

    it('validates email format and password length', async () => {
      const badEmail = await post('/auth/register', { ...farmA, email: 'not-an-email' });
      expect(badEmail.statusCode).toBe(400);
      const shortPw = await post('/auth/register', { ...farmA, email: 'x@y.test', password: 'short' });
      expect(shortPw.statusCode).toBe(400);
      const badOtp = await post('/auth/verify-otp', { email: emailA, otp: '12ab' });
      expect(badOtp.statusCode).toBe(400);
    });

    it('logs in with email + password (email is case-insensitive)', async () => {
      const res = await post('/auth/login', { email: 'TARIQ@AlMadina.test', password: 'password123' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.token).toBeDefined();
      expect(body.farm.id).toBe(farmAId);
    });

    it('rejects wrong password and unknown email with the same generic 401', async () => {
      const wrongPw = await post('/auth/login', { email: emailA, password: 'wrongpassword' });
      const unknown = await post('/auth/login', { email: 'nobody@nowhere.test', password: 'password123' });
      for (const res of [wrongPw, unknown]) {
        expect(res.statusCode).toBe(401);
        const body = JSON.parse(res.body);
        expect(body.error.code).toBe('INVALID_CREDENTIALS');
        expect(body.error.message).toBe('Invalid email or password');
      }
    });

    it('resend is rate limited (cooldown), then issues a fresh code that replaces the old one', async () => {
      const email = 'resend@test.dairy';
      await post('/auth/register', { farmName: 'R', ownerName: 'R', email, password: 'password123' });
      const firstCode = sentCodes.get(email)!;

      const tooSoon = await post('/auth/resend-otp', { email });
      expect(tooSoon.statusCode).toBe(429);
      expect(JSON.parse(tooSoon.body).error.code).toBe('OTP_RESEND_COOLDOWN');
      expect(sentCount.get(email)).toBe(1);

      // Pretend the cooldown has passed
      await getOtpsCollection().updateOne({ email }, { $set: { lastSentAt: new Date(Date.now() - 120_000) } });
      const ok = await post('/auth/resend-otp', { email });
      expect(ok.statusCode).toBe(202);
      expect(sentCount.get(email)).toBe(2);

      const newCode = sentCodes.get(email)!;
      if (newCode !== firstCode) {
        const old = await post('/auth/verify-otp', { email, otp: firstCode });
        expect(old.statusCode).toBe(400);
      }
      const verified = await post('/auth/verify-otp', { email, otp: newCode });
      expect(verified.statusCode).toBe(201);
    });

    it('resend answers 202 without sending for unknown or already-verified emails (no enumeration)', async () => {
      const before = sentCount.get(emailA) ?? 0;
      const verified = await post('/auth/resend-otp', { email: emailA });
      const unknown = await post('/auth/resend-otp', { email: 'ghost@nowhere.test' });
      expect(verified.statusCode).toBe(202);
      expect(unknown.statusCode).toBe(202);
      expect(sentCount.get(emailA) ?? 0).toBe(before);
      expect(sentCount.get('ghost@nowhere.test')).toBeUndefined();
    });

    it('locks the code after 5 wrong attempts, even if the right code is then entered', async () => {
      const email = 'lock@test.dairy';
      await post('/auth/register', { farmName: 'L', ownerName: 'L', email, password: 'password123' });
      const correct = sentCodes.get(email)!;
      const wrong = correct === '000000' ? '111111' : '000000';

      let last;
      for (let i = 0; i < 5; i++) last = await post('/auth/verify-otp', { email, otp: wrong });
      expect(last!.statusCode).toBe(429);
      expect(JSON.parse(last!.body).error.code).toBe('OTP_LOCKED');

      const rightButLocked = await post('/auth/verify-otp', { email, otp: correct });
      expect(rightButLocked.statusCode).toBe(429);
    });

    it('rejects an expired code', async () => {
      const email = 'expired@test.dairy';
      await post('/auth/register', { farmName: 'E', ownerName: 'E', email, password: 'password123' });
      await getOtpsCollection().updateOne({ email }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      const res = await post('/auth/verify-otp', { email, otp: sentCodes.get(email) });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe('OTP_EXPIRED');
    });

    it('re-registering an unverified email replaces the pending details and sends a new code', async () => {
      const email = 'retry@test.dairy';
      await post('/auth/register', { farmName: 'Old name', ownerName: 'O', email, password: 'password123' });
      await getOtpsCollection().updateOne({ email }, { $set: { lastSentAt: new Date(Date.now() - 120_000) } });
      const again = await post('/auth/register', { farmName: 'New name', ownerName: 'O', email, password: 'newpassword1' });
      expect(again.statusCode).toBe(202);
      const verified = await post('/auth/verify-otp', { email, otp: sentCodes.get(email) });
      expect(verified.statusCode).toBe(201);
      expect(JSON.parse(verified.body).farm.farmName).toBe('New name');
      const login = await post('/auth/login', { email, password: 'newpassword1' });
      expect(login.statusCode).toBe(200);
    });

    it('retrieves and updates authenticated farm profile', async () => {
      const getRes = await app.inject({
        method: 'GET',
        url: '/farm',
        headers: { authorization: `Bearer ${farmAToken}` },
      });
      expect(getRes.statusCode).toBe(200);
      const profile = JSON.parse(getRes.body);
      expect(profile.farmName).toBe('Al-Madina Dairy');
      expect(profile.email).toBe(emailA);
      expect(profile.passwordHash).toBeUndefined(); // Never expose password hash

      const patchRes = await app.inject({
        method: 'PATCH',
        url: '/farm',
        headers: { authorization: `Bearer ${farmAToken}` },
        payload: {
          farmName: 'Al-Madina Model Farm',
          defaultMilkRate: 225,
        },
      });
      expect(patchRes.statusCode).toBe(200);
      const updated = JSON.parse(patchRes.body);
      expect(updated.farmName).toBe('Al-Madina Model Farm');
      expect(updated.defaultMilkRate).toBe(225);
    });
  });

  describe('Sync Engine: Push & Pull', () => {
    let farmACursor = 0;
    const buyerUuid = 'b1111111-1111-1111-1111-111111111111';
    const milkUuid = 'm1111111-1111-1111-1111-111111111111';
    const expenseUuid = 'e1111111-1111-1111-1111-111111111111';

    it('push -> pull round-trip stores and retrieves records', async () => {
      const pushRes = await app.inject({
        method: 'POST',
        url: '/sync/push',
        headers: { authorization: `Bearer ${farmAToken}` },
        payload: {
          changes: [
            {
              table: 'buyers',
              uuid: buyerUuid,
              op: 'upsert',
              data: {
                name: 'Ahmed Milk Shop',
                phone: '0300 765 4321',
                address: 'Sheikhupura',
                is_default: 1,
                created_at: '2026-10-15T08:00:00.000Z',
              },
              clientUpdatedAt: '2026-10-15T08:00:00.000Z',
            },
            {
              table: 'milk_entries',
              uuid: milkUuid,
              op: 'upsert',
              data: {
                date: '2026-10-15',
                shift: 'Morning',
                liters: 65,
                fat_percentage: 4.5,
                rate_per_liter: 220,
                total_amount: 14300,
                buyer_uuid: buyerUuid,
                buyer_name: 'Ahmed Milk Shop',
                notes: 'First test entry',
                created_at: '2026-10-15T08:05:00.000Z',
              },
              clientUpdatedAt: '2026-10-15T08:05:00.000Z',
            },
            {
              table: 'expenses',
              uuid: expenseUuid,
              op: 'upsert',
              data: {
                date: '2026-10-15',
                category: 'Feed',
                title: 'Wanda 20 bags',
                amount: 30000,
                quantity: 20,
                unit: 'bag',
                unit_price: 1500,
                supplier_or_payee: 'Punjab Feeds',
                payment_method: 'Cash',
                notes: null,
                created_at: '2026-10-15T08:10:00.000Z',
              },
              clientUpdatedAt: '2026-10-15T08:10:00.000Z',
            },
          ],
        },
      });

      expect(pushRes.statusCode).toBe(200);
      const pushBody = JSON.parse(pushRes.body);
      expect(pushBody.applied).toBe(3);
      expect(pushBody.rejected).toHaveLength(0);
      expect(pushBody.cursor).toBeGreaterThan(0);
      farmACursor = pushBody.cursor;

      // Pull since 0
      const pullRes = await app.inject({
        method: 'GET',
        url: '/sync/pull?since=0',
        headers: { authorization: `Bearer ${farmAToken}` },
      });

      expect(pullRes.statusCode).toBe(200);
      const pullBody = JSON.parse(pullRes.body);
      expect(pullBody.changes).toHaveLength(3);
      expect(pullBody.cursor).toBe(farmACursor);
      expect(pullBody.hasMore).toBe(false);

      const pulledBuyer = pullBody.changes.find((c: any) => c.uuid === buyerUuid);
      expect(pulledBuyer).toBeDefined();
      expect(pulledBuyer.data.name).toBe('Ahmed Milk Shop');
      expect(pulledBuyer.op).toBe('upsert');
    });

    it('idempotent double push: pushing identical records does not duplicate', async () => {
      const recordsCol = getRecordsCollection();
      const countBefore = await recordsCol.countDocuments({ farmId: farmAId });

      const pushAgainRes = await app.inject({
        method: 'POST',
        url: '/sync/push',
        headers: { authorization: `Bearer ${farmAToken}` },
        payload: {
          changes: [
            {
              table: 'buyers',
              uuid: buyerUuid,
              op: 'upsert',
              data: {
                name: 'Ahmed Milk Shop',
                phone: '0300 765 4321',
                address: 'Sheikhupura',
                is_default: 1,
                created_at: '2026-10-15T08:00:00.000Z',
              },
              clientUpdatedAt: '2026-10-15T08:00:00.000Z',
            },
          ],
        },
      });

      expect(pushAgainRes.statusCode).toBe(200);
      farmACursor = JSON.parse(pushAgainRes.body).cursor;
      const countAfter = await recordsCol.countDocuments({ farmId: farmAId });
      expect(countAfter).toBe(countBefore);
    });

    it('delete tombstone propagates with op: "delete" and cleared data', async () => {
      const deleteRes = await app.inject({
        method: 'POST',
        url: '/sync/push',
        headers: { authorization: `Bearer ${farmAToken}` },
        payload: {
          changes: [
            {
              table: 'expenses',
              uuid: expenseUuid,
              op: 'delete',
              clientUpdatedAt: '2026-10-15T09:00:00.000Z',
            },
          ],
        },
      });

      expect(deleteRes.statusCode).toBe(200);
      const deleteBody = JSON.parse(deleteRes.body);
      expect(deleteBody.applied).toBe(1);

      // Pull changes since prior cursor
      const pullRes = await app.inject({
        method: 'GET',
        url: `/sync/pull?since=${farmACursor}`,
        headers: { authorization: `Bearer ${farmAToken}` },
      });

      expect(pullRes.statusCode).toBe(200);
      const pullBody = JSON.parse(pullRes.body);
      expect(pullBody.changes).toHaveLength(1);
      expect(pullBody.changes[0].uuid).toBe(expenseUuid);
      expect(pullBody.changes[0].op).toBe('delete');
      expect(pullBody.changes[0].data).toBeUndefined();

      farmACursor = pullBody.cursor;
    });

    it('older clientUpdatedAt is ignored (conflict resolution LWW)', async () => {
      // Current record has clientUpdatedAt '2026-10-15T08:00:00.000Z'
      // Try to push an older change with clientUpdatedAt '2026-10-14T00:00:00.000Z'
      const oldPushRes = await app.inject({
        method: 'POST',
        url: '/sync/push',
        headers: { authorization: `Bearer ${farmAToken}` },
        payload: {
          changes: [
            {
              table: 'buyers',
              uuid: buyerUuid,
              op: 'upsert',
              data: {
                name: 'Old Outdated Name',
                is_default: 0,
                created_at: '2026-10-14T00:00:00.000Z',
              },
              clientUpdatedAt: '2026-10-14T00:00:00.000Z',
            },
          ],
        },
      });

      expect(oldPushRes.statusCode).toBe(200);
      const oldPushBody = JSON.parse(oldPushRes.body);
      expect(oldPushBody.applied).toBe(1); // Counted as applied (ignored)

      // Verify that the record in Mongo was NOT overwritten
      const recordsCol = getRecordsCollection();
      const doc = await recordsCol.findOne({ farmId: farmAId, table: 'buyers', uuid: buyerUuid });
      expect(doc?.data?.name).toBe('Ahmed Milk Shop');
    });

    it('compares mixed timestamp formats as instants (same-day edit in SQLite format is newer)', async () => {
      const uuid = 'e5555555-5555-5555-5555-555555555555';
      const push = (name: string, clientUpdatedAt: string) =>
        app.inject({
          method: 'POST',
          url: '/sync/push',
          headers: { authorization: `Bearer ${farmAToken}` },
          payload: {
            changes: [
              {
                table: 'buyers',
                uuid,
                op: 'upsert',
                data: { name, is_default: 0, created_at: '2026-10-16T08:00:00.000Z' },
                clientUpdatedAt,
              },
            ],
          },
        });

      // Legacy row: updated_at was backfilled from created_at (ISO)
      await push('Original', '2026-10-16T08:00:00.000Z');
      // Edit 2h later, written by the SQLite trigger in "YYYY-MM-DD HH:MM:SS" (UTC)
      await push('Edited', '2026-10-16 10:00:00');
      // Stale edit from before both, in SQLite format, must still lose
      await push('Stale', '2026-10-16 07:00:00');

      const doc = await getRecordsCollection().findOne({ farmId: farmAId, table: 'buyers', uuid });
      expect(doc?.data?.name).toBe('Edited');
    });

    it('two devices converge on bidirectional sync', async () => {
      // Device 1 creates a livestock animal
      const cowUuid = 'c1111111-1111-1111-1111-111111111111';
      const dev1Push = await app.inject({
        method: 'POST',
        url: '/sync/push',
        headers: { authorization: `Bearer ${farmAToken}` },
        payload: {
          changes: [
            {
              table: 'livestock',
              uuid: cowUuid,
              op: 'upsert',
              data: {
                tag_number: 'C-99',
                name: 'Dev1 Cow',
                species: 'Cow',
                gender: 'Female',
                status: 'Lactating',
                breed: 'Sahiwal',
                created_at: '2026-10-15T10:00:00.000Z',
              },
              clientUpdatedAt: '2026-10-15T10:00:00.000Z',
            },
          ],
        },
      });
      expect(dev1Push.statusCode).toBe(200);

      // Device 2 creates a payment
      const paymentUuid = 'p1111111-1111-1111-1111-111111111111';
      const dev2Push = await app.inject({
        method: 'POST',
        url: '/sync/push',
        headers: { authorization: `Bearer ${farmAToken}` },
        payload: {
          changes: [
            {
              table: 'buyer_payments',
              uuid: paymentUuid,
              op: 'upsert',
              data: {
                buyer_uuid: buyerUuid,
                date: '2026-10-15',
                amount: 10000,
                payment_method: 'Bank transfer',
                received_by: 'Dev2 Cashier',
                created_at: '2026-10-15T10:05:00.000Z',
              },
              clientUpdatedAt: '2026-10-15T10:05:00.000Z',
            },
          ],
        },
      });
      expect(dev2Push.statusCode).toBe(200);

      // Device 1 pulls since its last cursor and receives the payment
      const dev1Pull = await app.inject({
        method: 'GET',
        url: `/sync/pull?since=${farmACursor}`,
        headers: { authorization: `Bearer ${farmAToken}` },
      });
      const dev1PulledChanges = JSON.parse(dev1Pull.body).changes;
      expect(dev1PulledChanges.some((c: any) => c.uuid === paymentUuid)).toBe(true);

      // Device 2 pulls since 0 (or its last cursor) and receives the cow
      const dev2Pull = await app.inject({
        method: 'GET',
        url: '/sync/pull?since=0',
        headers: { authorization: `Bearer ${farmAToken}` },
      });
      const dev2PulledChanges = JSON.parse(dev2Pull.body).changes;
      expect(dev2PulledChanges.some((c: any) => c.uuid === cowUuid)).toBe(true);
      expect(dev2PulledChanges.some((c: any) => c.uuid === paymentUuid)).toBe(true);
    });

    it('invalid change is rejected without failing the entire batch', async () => {
      const validUuid = 'b2222222-2222-2222-2222-222222222222';
      const invalidUuid = 'm2222222-2222-2222-2222-222222222222';

      const res = await app.inject({
        method: 'POST',
        url: '/sync/push',
        headers: { authorization: `Bearer ${farmAToken}` },
        payload: {
          changes: [
            {
              table: 'buyers',
              uuid: validUuid,
              op: 'upsert',
              data: {
                name: 'Valid New Buyer',
                is_default: 0,
                created_at: '2026-10-15T11:00:00.000Z',
              },
              clientUpdatedAt: '2026-10-15T11:00:00.000Z',
            },
            {
              table: 'milk_entries',
              uuid: invalidUuid,
              op: 'upsert',
              data: {
                date: 'invalid-date-format', // invalid date
                shift: 'Afternoon', // invalid shift
                liters: -50, // invalid negative liters
                fat_percentage: 4.5,
                rate_per_liter: 200,
                total_amount: 10000,
                buyer_uuid: validUuid,
                buyer_name: 'Valid New Buyer',
                created_at: '2026-10-15T11:00:00.000Z',
              },
              clientUpdatedAt: '2026-10-15T11:00:00.000Z',
            },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.applied).toBe(1);
      expect(body.rejected).toHaveLength(1);
      expect(body.rejected[0].uuid).toBe(invalidUuid);
      expect(body.rejected[0].reason).toContain('Validation failed');
    });

    it('rejects disallowed settings key from sync', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sync/push',
        headers: { authorization: `Bearer ${farmAToken}` },
        payload: {
          changes: [
            {
              table: 'settings',
              uuid: 'admin_pin', // RESTRICTED: must never sync admin_pin
              op: 'upsert',
              data: { value: '1234' },
              clientUpdatedAt: '2026-10-15T11:00:00.000Z',
            },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.applied).toBe(0);
      expect(body.rejected).toHaveLength(1);
      expect(body.rejected[0].reason).toContain('restricted and cannot be synced');
    });

    it('farm isolation: Farm B cannot read or overwrite Farm A data', async () => {
      // Register Farm B (register -> OTP -> verify)
      const regB = await registerAndVerify({
        farmName: 'Farm B Dairy',
        ownerName: 'Rashid Khan',
        email: 'rashid@farmb.test',
        password: 'password456',
      });
      expect(regB.statusCode).toBe(201);
      farmBToken = JSON.parse(regB.body).token;
      farmBId = JSON.parse(regB.body).farm.id;
      expect(farmBId).not.toBe(farmAId);

      // Farm B pulls since 0 -> should receive 0 changes
      const pullB = await app.inject({
        method: 'GET',
        url: '/sync/pull?since=0',
        headers: { authorization: `Bearer ${farmBToken}` },
      });

      expect(pullB.statusCode).toBe(200);
      const pullBodyB = JSON.parse(pullB.body);
      expect(pullBodyB.changes).toHaveLength(0);
      expect(pullBodyB.cursor).toBe(0);

      // Farm B tries to access Farm A's profile
      const farmProfileB = await app.inject({
        method: 'GET',
        url: '/farm',
        headers: { authorization: `Bearer ${farmBToken}` },
      });
      expect(farmProfileB.statusCode).toBe(200);
      expect(JSON.parse(farmProfileB.body).id).toBe(farmBId);
      expect(JSON.parse(farmProfileB.body).farmName).toBe('Farm B Dairy');
    });
  });
});
