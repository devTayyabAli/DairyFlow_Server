import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FastifyInstance } from 'fastify';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { closeDb, connectToDb } from '../src/db.js';
import { setMailer } from '../src/mail.js';
import { decideMilkUpsert, lineAmount } from '../src/sync/pricing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sentCodes = new Map<string, string>();
setMailer({
  async sendOtp(to, code) {
    sentCodes.set(to, code);
  },
});

describe('fat rate decisions', () => {
  const band = {
    uuid: 'band-1',
    min_fat: 4,
    max_fat: 6,
    rate_per_liter: 180,
    effective_from: '2026-01-01',
    effective_to: null,
    active: 1,
  };

  it('rejects a fat value that is outside every band', () => {
    const decision = decideMilkUpsert({
      data: { liters: 10, fat_percentage: 3, date: '2026-10-23', rate_per_liter: 180, pricing_band_uuid: 'band-1' },
      existing: null,
      bands: [band],
      shiftTaken: false,
      assigned: true,
    });
    expect(decision.ok).toBe(false);
  });

  it('keeps the saved rate when fat does not change', () => {
    const decision = decideMilkUpsert({
      data: { liters: 8, fat_percentage: 5, date: '2026-10-23', rate_per_liter: 999, pricing_band_uuid: 'band-1' },
      existing: { fat_percentage: 5, rate_per_liter: 180, pricing_band_uuid: 'band-1' },
      bands: [{ ...band, rate_per_liter: 250 }],
      shiftTaken: false,
      assigned: true,
    });
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.data.rate_per_liter).toBe(180);
      expect(decision.data.total_amount).toBe(lineAmount(8, 180));
    }
  });
});

describe('procurement roles', () => {
  let mongod: MongoMemoryServer;
  let testDbPath: string;
  let app: FastifyInstance;
  let ownerToken = '';
  let collectorToken = '';
  let collectorUserId = '';
  let farmerToken = '';

  beforeAll(async () => {
    testDbPath = path.join(__dirname, '../.mongo-test-db-procurement');
    if (fs.existsSync(testDbPath)) fs.rmSync(testDbPath, { recursive: true, force: true });
    fs.mkdirSync(testDbPath, { recursive: true });
    mongod = await MongoMemoryServer.create({
      binary: { downloadDir: path.join(__dirname, '../.mongo-binaries') },
      instance: { dbPath: testDbPath },
    });
    await connectToDb(mongod.getUri(), 'dairyflow_procurement_test');
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    await closeDb();
    if (mongod) await mongod.stop();
    if (fs.existsSync(testDbPath)) {
      try {
        fs.rmSync(testDbPath, { recursive: true, force: true });
      } catch {
        // The memory server can keep a file open on Windows for a moment.
      }
    }
  });

  const post = (url: string, payload: unknown, token?: string) =>
    app.inject({
      method: 'POST',
      url,
      payload: payload as object,
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    });

  const get = (url: string, token?: string) =>
    app.inject({
      method: 'GET',
      url,
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    });

  async function owner(): Promise<string> {
    const email = 'owner@procure.test';
    await post('/auth/register', {
      farmName: 'Procure Dairy',
      ownerName: 'Owner',
      email,
      password: 'StrongPassword123!',
      businessType: 'collection_center',
    });
    const verified = await post('/auth/verify-otp', { email, otp: sentCodes.get(email) });
    return JSON.parse(verified.body).token as string;
  }

  it('prices one collection for the owner, dodhi, and dairy, and refuses the wrong rate', async () => {
    ownerToken = await owner();
    const collector = await post(
      '/tenants/members',
      { name: 'Bilal', email: 'bilal@procure.test', password: 'Password123!', role: 'collector' },
      ownerToken
    );
    expect(collector.statusCode).toBe(201);
    const collectorLogin = await post('/auth/login', { email: 'bilal@procure.test', password: 'Password123!' });
    collectorToken = JSON.parse(collectorLogin.body).token;
    collectorUserId = JSON.parse(collectorLogin.body).farm.userId;

    const farmer = await post(
      '/tenants/members',
      { name: 'Saleem', email: 'saleem@procure.test', password: 'Password123!', role: 'farmer' },
      ownerToken
    );
    const farmerUserId = JSON.parse(farmer.body).member.userId as string;
    const farmerLogin = await post('/auth/login', { email: 'saleem@procure.test', password: 'Password123!' });
    farmerToken = JSON.parse(farmerLogin.body).token;

    const setup = await post(
      '/sync/push',
      {
        changes: [
          {
            table: 'suppliers',
            uuid: 'saleem',
            op: 'upsert',
            clientUpdatedAt: '2026-10-23T01:00:00.000Z',
            data: { name: 'Saleem', linked_farm_id: farmerUserId, created_at: '2026-10-23T01:00:00.000Z' },
          },
          {
            table: 'fat_rate_bands',
            uuid: 'band-1',
            op: 'upsert',
            clientUpdatedAt: '2026-10-23T01:00:00.000Z',
            data: {
              min_fat: 4,
              max_fat: 6,
              rate_per_liter: 180,
              effective_from: '2026-01-01',
              active: 1,
              label: '4 to 6',
              created_at: '2026-10-23T01:00:00.000Z',
            },
          },
          {
            table: 'collector_assignments',
            uuid: 'assign-1',
            op: 'upsert',
            clientUpdatedAt: '2026-10-23T01:00:00.000Z',
            data: {
              collector_user_id: collectorUserId,
              supplier_uuid: 'saleem',
              active: 1,
              created_at: '2026-10-23T01:00:00.000Z',
            },
          },
          {
            table: 'expenses',
            uuid: 'hidden-expense',
            op: 'upsert',
            clientUpdatedAt: '2026-10-23T01:00:00.000Z',
            data: { date: '2026-10-23', category: 'Feed', title: 'Wanda', amount: 10, created_at: '2026-10-23T01:00:00.000Z' },
          },
        ],
      },
      ownerToken
    );
    expect(setup.statusCode).toBe(200);
    expect(JSON.parse(setup.body).rejected).toEqual([]);

    const stale = await post(
      '/sync/push',
      {
        changes: [
          {
            table: 'milk_collections',
            uuid: 'milk-1',
            op: 'upsert',
            clientUpdatedAt: '2026-10-23T02:00:00.000Z',
            data: {
              date: '2026-10-23',
              shift: 'Morning',
              supplier_uuid: 'saleem',
              supplier_name: 'Saleem',
              collector_id: 'someone-else',
              liters: 10,
              fat_percentage: 5,
              rate_per_liter: 100,
              total_amount: 1000,
              pricing_band_uuid: 'band-1',
              created_at: '2026-10-23T02:00:00.000Z',
            },
          },
        ],
      },
      collectorToken
    );
    expect(JSON.parse(stale.body).applied).toBe(0);
    expect(JSON.parse(stale.body).rejected[0].reason).toContain('does not match');

    const saved = await post(
      '/sync/push',
      {
        changes: [
          {
            table: 'milk_collections',
            uuid: 'milk-1',
            op: 'upsert',
            clientUpdatedAt: '2026-10-23T02:01:00.000Z',
            data: {
              date: '2026-10-23',
              shift: 'Morning',
              supplier_uuid: 'saleem',
              supplier_name: 'Saleem',
              collector_id: 'someone-else',
              liters: 10,
              fat_percentage: 5,
              rate_per_liter: 180,
              total_amount: 1800,
              pricing_band_uuid: 'band-1',
              created_at: '2026-10-23T02:01:00.000Z',
            },
          },
        ],
      },
      collectorToken
    );
    expect(JSON.parse(saved.body).applied).toBe(1);

    const duplicate = await post(
      '/sync/push',
      {
        changes: [
          {
            table: 'milk_collections',
            uuid: 'milk-2',
            op: 'upsert',
            clientUpdatedAt: '2026-10-23T02:02:00.000Z',
            data: {
              date: '2026-10-23',
              shift: 'Morning',
              supplier_uuid: 'saleem',
              supplier_name: 'Saleem',
              liters: 4,
              fat_percentage: 5,
              rate_per_liter: 180,
              total_amount: 720,
              pricing_band_uuid: 'band-1',
              created_at: '2026-10-23T02:02:00.000Z',
            },
          },
        ],
      },
      collectorToken
    );
    expect(JSON.parse(duplicate.body).rejected[0].reason).toContain('already exists');

    const overlap = await post(
      '/sync/push',
      {
        changes: [
          {
            table: 'fat_rate_bands',
            uuid: 'band-overlap',
            op: 'upsert',
            clientUpdatedAt: '2026-10-23T03:00:00.000Z',
            data: {
              min_fat: 6,
              max_fat: 8,
              rate_per_liter: 200,
              effective_from: '2026-01-01',
              active: 1,
              created_at: '2026-10-23T03:00:00.000Z',
            },
          },
        ],
      },
      ownerToken
    );
    expect(JSON.parse(overlap.body).rejected[0].reason).toContain('overlaps');

    await post(
      '/sync/push',
      {
        changes: [
          {
            table: 'fat_rate_bands',
            uuid: 'band-1',
            op: 'upsert',
            clientUpdatedAt: '2026-10-23T04:00:00.000Z',
            data: {
              min_fat: 4,
              max_fat: 6,
              rate_per_liter: 250,
              effective_from: '2026-01-01',
              active: 1,
              created_at: '2026-10-23T01:00:00.000Z',
            },
          },
        ],
      },
      ownerToken
    );

    await post(
      '/sync/push',
      {
        changes: [
          {
            table: 'milk_collections',
            uuid: 'milk-1',
            op: 'upsert',
            clientUpdatedAt: '2026-10-23T04:01:00.000Z',
            data: {
              date: '2026-10-23',
              shift: 'Morning',
              supplier_uuid: 'saleem',
              supplier_name: 'Saleem',
              liters: 10,
              fat_percentage: 5,
              rate_per_liter: 180,
              total_amount: 1800,
              pricing_band_uuid: 'band-1',
              created_at: '2026-10-23T02:01:00.000Z',
            },
          },
        ],
      },
      collectorToken
    );

    const ownerPull = await get('/sync/pull?since=0&limit=500', ownerToken);
    const ownerChanges = JSON.parse(ownerPull.body).changes as Array<{ table: string; uuid: string; data?: { rate_per_liter?: number; collector_id?: string } }>;
    const milk = ownerChanges.find((change) => change.uuid === 'milk-1');
    expect(milk?.data?.rate_per_liter).toBe(180);
    expect(milk?.data?.collector_id).toBe(collectorUserId);
    expect(ownerChanges.map((change) => change.table)).toContain('expenses');

    const farmerPull = await get('/sync/pull?since=0&limit=500', farmerToken);
    const farmerTables = (JSON.parse(farmerPull.body).changes as Array<{ table: string }>).map((change) => change.table);
    expect(farmerTables).toContain('milk_collections');
    expect(farmerTables).not.toContain('expenses');

    const collectorPull = await get('/sync/pull?since=0&limit=500', collectorToken);
    const collectorTables = (JSON.parse(collectorPull.body).changes as Array<{ table: string }>).map((change) => change.table);
    expect(collectorTables).toContain('fat_rate_bands');
    expect(collectorTables).toContain('suppliers');
    expect(collectorTables).not.toContain('expenses');

    const farmerWrite = await post(
      '/sync/push',
      {
        changes: [
          {
            table: 'milk_collections',
            uuid: 'farmer-write',
            op: 'upsert',
            clientUpdatedAt: '2026-10-23T05:00:00.000Z',
            data: {
              date: '2026-10-23',
              shift: 'Evening',
              supplier_uuid: 'saleem',
              supplier_name: 'Saleem',
              liters: 1,
              fat_percentage: 5,
              rate_per_liter: 250,
              total_amount: 250,
              pricing_band_uuid: 'band-1',
              created_at: '2026-10-23T05:00:00.000Z',
            },
          },
        ],
      },
      farmerToken
    );
    expect(JSON.parse(farmerWrite.body).applied).toBe(0);

    const collectorBand = await post(
      '/sync/push',
      {
        changes: [
          {
            table: 'fat_rate_bands',
            uuid: 'band-dodhi',
            op: 'upsert',
            clientUpdatedAt: '2026-10-23T05:00:00.000Z',
            data: {
              min_fat: 7,
              max_fat: 8,
              rate_per_liter: 300,
              effective_from: '2026-01-01',
              active: 1,
              created_at: '2026-10-23T05:00:00.000Z',
            },
          },
        ],
      },
      collectorToken
    );
    expect(JSON.parse(collectorBand.body).rejected[0].reason).toContain('dodhi');

    const removed = await post(
      '/sync/push',
      { changes: [{ table: 'milk_collections', uuid: 'milk-1', op: 'delete', clientUpdatedAt: '2026-10-23T06:00:00.000Z' }] },
      ownerToken
    );
    expect(JSON.parse(removed.body).rejected[0].reason).toContain('not deleted');

    const suspended = await post(`/tenants/members/${collectorUserId}/status`, { status: 'suspended' }, ownerToken);
    expect(suspended.statusCode).toBe(200);
    const blocked = await post('/auth/login', { email: 'bilal@procure.test', password: 'Password123!' });
    expect(blocked.statusCode).toBe(403);
  });
});
