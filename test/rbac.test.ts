import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.js';
import { closeDb, connectToDb } from '../src/db.js';
import { setMailer } from '../src/mail.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sentCodes = new Map<string, string>();
setMailer({
  async sendOtp(to, code) {
    sentCodes.set(to, code);
  },
});

describe('DairyFlow Multi-Tenant RBAC & Ledger Tests', () => {
  let mongod: MongoMemoryServer;
  let testDbPath: string;
  let app: FastifyInstance;

  let ownerToken: string;
  let managerToken: string;
  let accountantToken: string;
  let collectorToken: string;
  let collectorUserId: string;
  let auditorToken: string;

  beforeAll(async () => {
    testDbPath = path.join(__dirname, '../.mongo-test-db-rbac');
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
    await connectToDb(uri, 'dairyflow_rbac_test');
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
        // ignore
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

  const patch = (url: string, payload: unknown, token?: string) =>
    app.inject({
      method: 'PATCH',
      url,
      payload: payload as object,
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    });

  it('registers an owner with collection_center business type and obtains token', async () => {
    const ownerEmail = 'owner@collection.test';
    const regRes = await post('/auth/register', {
      farmName: 'Gujranwala Milk Center',
      ownerName: 'Chaudhry Akram',
      email: ownerEmail,
      password: 'StrongPassword123!',
      phone: '03001234567',
      businessType: 'collection_center',
    });
    expect(regRes.statusCode).toBe(202);

    const otp = sentCodes.get(ownerEmail);
    expect(otp).toBeDefined();

    const verifyRes = await post('/auth/verify-otp', {
      email: ownerEmail,
      otp,
    });
    expect(verifyRes.statusCode).toBe(201);
    const body = JSON.parse(verifyRes.body);
    expect(body.farm.businessType).toBe('collection_center');
    expect(body.farm.role).toBe('owner');
    ownerToken = body.token;
  });

  it('GET /auth/me returns current tenant, user, and role', async () => {
    const meRes = await get('/auth/me', ownerToken);
    expect(meRes.statusCode).toBe(200);
    const me = JSON.parse(meRes.body);
    expect(me.user.role).toBe('owner');
    expect(me.tenant.businessType).toBe('collection_center');
  });

  it('owner can add team members with manager, accountant, collector, and auditor roles', async () => {
    // Add manager
    const mgrRes = await post(
      '/tenants/members',
      {
        name: 'Rashid Manager',
        email: 'manager@collection.test',
        password: 'Password123!',
        role: 'manager',
      },
      ownerToken
    );
    expect(mgrRes.statusCode).toBe(201);

    // Add accountant
    const accRes = await post(
      '/tenants/members',
      {
        name: 'Aslam Munshi',
        email: 'accountant@collection.test',
        password: 'Password123!',
        role: 'accountant',
      },
      ownerToken
    );
    expect(accRes.statusCode).toBe(201);

    // Add collector
    const colRes = await post(
      '/tenants/members',
      {
        name: 'Dodhi Bilawal',
        email: 'dodhi@collection.test',
        password: 'Password123!',
        role: 'collector',
      },
      ownerToken
    );
    expect(colRes.statusCode).toBe(201);

    // Add auditor
    const audRes = await post(
      '/tenants/members',
      {
        name: 'Tahir Auditor',
        email: 'auditor@collection.test',
        password: 'Password123!',
        role: 'auditor',
      },
      ownerToken
    );
    expect(audRes.statusCode).toBe(201);

    // Log in as each member to get their tokens
    const loginMgr = await post('/auth/login', { email: 'manager@collection.test', password: 'Password123!' });
    managerToken = JSON.parse(loginMgr.body).token;
    expect(JSON.parse(loginMgr.body).farm.role).toBe('manager');

    const loginAcc = await post('/auth/login', { email: 'accountant@collection.test', password: 'Password123!' });
    accountantToken = JSON.parse(loginAcc.body).token;
    expect(JSON.parse(loginAcc.body).farm.role).toBe('accountant');

    const loginCol = await post('/auth/login', { email: 'dodhi@collection.test', password: 'Password123!' });
    collectorToken = JSON.parse(loginCol.body).token;
    collectorUserId = JSON.parse(loginCol.body).farm.userId;
    expect(JSON.parse(loginCol.body).farm.role).toBe('collector');

    const loginAud = await post('/auth/login', { email: 'auditor@collection.test', password: 'Password123!' });
    auditorToken = JSON.parse(loginAud.body).token;
    expect(JSON.parse(loginAud.body).farm.role).toBe('auditor');
  });

  it('RBAC: members list access control', async () => {
    // Owner, Manager, and Auditor can view members list
    const ownerList = await get('/tenants/members', ownerToken);
    expect(ownerList.statusCode).toBe(200);

    const mgrList = await get('/tenants/members', managerToken);
    expect(mgrList.statusCode).toBe(200);

    const audList = await get('/tenants/members', auditorToken);
    expect(audList.statusCode).toBe(200);

    // Collector and staff cannot view members list (403)
    const colList = await get('/tenants/members', collectorToken);
    expect(colList.statusCode).toBe(403);
  });

  it('RBAC: member creation access control', async () => {
    // Manager can create staff member
    const mgrCreate = await post(
      '/tenants/members',
      {
        name: 'New Worker',
        email: 'worker@collection.test',
        password: 'Password123!',
        role: 'staff',
      },
      managerToken
    );
    expect(mgrCreate.statusCode).toBe(201);

    // Accountant, Collector, Auditor cannot create members (403)
    const accCreate = await post(
      '/tenants/members',
      {
        name: 'Hacked Worker',
        email: 'hacked@collection.test',
        password: 'Password123!',
        role: 'staff',
      },
      accountantToken
    );
    expect(accCreate.statusCode).toBe(403);

    const colCreate = await post(
      '/tenants/members',
      {
        name: 'Hacked Worker 2',
        email: 'hacked2@collection.test',
        password: 'Password123!',
        role: 'staff',
      },
      collectorToken
    );
    expect(colCreate.statusCode).toBe(403);
  });

  it('RBAC: farm profile modification is restricted to owner and manager', async () => {
    // Owner can update
    const ownerPatch = await patch('/farm', { farmName: 'Chaudhry Dairy & Milk Center' }, ownerToken);
    expect(ownerPatch.statusCode).toBe(200);

    // Manager can update
    const mgrPatch = await patch('/farm', { farmName: 'Chaudhry Dairy & Milk Hub' }, managerToken);
    expect(mgrPatch.statusCode).toBe(200);

    // Accountant, collector, and auditor cannot update (403)
    const accPatch = await patch('/farm', { farmName: 'Accountant Takeover' }, accountantToken);
    expect(accPatch.statusCode).toBe(403);

    const colPatch = await patch('/farm', { farmName: 'Dodhi Takeover' }, collectorToken);
    expect(colPatch.statusCode).toBe(403);
  });

  it('Financial Integrity: sync push accepts ledger entries but rejects deletes on ledger_entries', async () => {
    const entryUuid = 'ledger-op-001';
    // 1. Push a ledger entry (upsert)
    const pushUpsert = await post(
      '/sync/push',
      {
        changes: [
          {
            table: 'ledger_entries',
            uuid: entryUuid,
            op: 'upsert',
            clientUpdatedAt: new Date().toISOString(),
            data: {
              account_type: 'supplier',
              account_uuid: 'supplier-uuid-1',
              account_name: 'Peer Bakhsh',
              entry_type: 'milk_collection',
              amount: 5400,
              date: '2026-10-22',
              notes: 'Morning shift 40L @ 135',
              created_at: new Date().toISOString(),
            },
          },
        ],
      },
      ownerToken
    );
    expect(pushUpsert.statusCode).toBe(200);
    const bodyUpsert = JSON.parse(pushUpsert.body);
    expect(bodyUpsert.applied).toBe(1);
    expect(bodyUpsert.rejected.length).toBe(0);

    // 2. Attempt to delete the ledger entry -> MUST BE REJECTED for immutability!
    const pushDelete = await post(
      '/sync/push',
      {
        changes: [
          {
            table: 'ledger_entries',
            uuid: entryUuid,
            op: 'delete',
            clientUpdatedAt: new Date().toISOString(),
          },
        ],
      },
      ownerToken
    );
    expect(pushDelete.statusCode).toBe(200);
    const bodyDelete = JSON.parse(pushDelete.body);
    expect(bodyDelete.applied).toBe(0);
    expect(bodyDelete.rejected.length).toBe(1);
    expect(bodyDelete.rejected[0].table).toBe('ledger_entries');
    expect(bodyDelete.rejected[0].reason).toContain('immutable and cannot be deleted');
  });

  it('RBAC: a manager cannot grant owner or manager', async () => {
    const ownerGrant = await post(
      '/tenants/members',
      { name: 'Second Owner', email: 'second-owner@collection.test', password: 'Password123!', role: 'owner' },
      managerToken
    );
    expect(ownerGrant.statusCode).toBe(403);

    const managerGrant = await post(
      '/tenants/members',
      { name: 'Second Manager', email: 'second-manager@collection.test', password: 'Password123!', role: 'manager' },
      managerToken
    );
    expect(managerGrant.statusCode).toBe(403);
  });

  it('RBAC: auditor pushes are rejected and collector cannot change farm settings', async () => {
    const auditPush = await post(
      '/sync/push',
      {
        changes: [
          {
            table: 'ledger_entries',
            uuid: 'ledger-audit-1',
            op: 'upsert',
            clientUpdatedAt: new Date().toISOString(),
            data: {
              account_type: 'supplier',
              account_uuid: 'supplier-uuid-9',
              account_name: 'Audit Write',
              entry_type: 'adjustment',
              amount: 1,
              date: '2026-10-22',
              created_at: new Date().toISOString(),
            },
          },
        ],
      },
      auditorToken
    );
    expect(auditPush.statusCode).toBe(200);
    const auditBody = JSON.parse(auditPush.body);
    expect(auditBody.applied).toBe(0);
    expect(auditBody.rejected[0].reason).toContain('Read-only');

    const collectorSettings = await post(
      '/sync/push',
      {
        changes: [
          {
            table: 'settings',
            uuid: 'farm_name',
            op: 'upsert',
            clientUpdatedAt: new Date().toISOString(),
            data: { value: 'Collector Farm' },
          },
        ],
      },
      collectorToken
    );
    expect(collectorSettings.statusCode).toBe(200);
    const settingsBody = JSON.parse(collectorSettings.body);
    expect(settingsBody.applied).toBe(0);
    expect(settingsBody.rejected[0].reason).toContain('dodhi');
  });

  it('owner, dodhi, and dairy all see the same milk entry, scoped to that person', async () => {
    const farmerRes = await post(
      '/tenants/members',
      {
        name: 'Saleem',
        email: 'saleem@collection.test',
        password: 'Password123!',
        role: 'farmer',
      },
      ownerToken
    );
    expect(farmerRes.statusCode).toBe(201);
    const farmerUserId = JSON.parse(farmerRes.body).member.userId as string;

    const farmerLogin = await post('/auth/login', { email: 'saleem@collection.test', password: 'Password123!' });
    expect(farmerLogin.statusCode).toBe(200);
    const farmerToken = JSON.parse(farmerLogin.body).token as string;
    expect(JSON.parse(farmerLogin.body).farm.role).toBe('farmer');
    expect(JSON.parse(farmerLogin.body).farm.userId).toBe(farmerUserId);

    const supplierUuid = 'saleem-dairy';
    const ownerPush = await post(
      '/sync/push',
      {
        changes: [
          {
            table: 'suppliers',
            uuid: supplierUuid,
            op: 'upsert',
            clientUpdatedAt: new Date().toISOString(),
            data: {
              name: 'Saleem',
              linked_farm_id: farmerUserId,
              created_at: new Date().toISOString(),
            },
          },
          {
            table: 'expenses',
            uuid: 'secret-expense',
            op: 'upsert',
            clientUpdatedAt: new Date().toISOString(),
            data: {
              date: '2026-10-22',
              category: 'Feed',
              title: 'Wanda',
              amount: 500,
              created_at: new Date().toISOString(),
            },
          },
          {
            table: 'collector_assignments',
            uuid: 'bilal-saleem',
            op: 'upsert',
            clientUpdatedAt: new Date().toISOString(),
            data: {
              collector_user_id: collectorUserId,
              supplier_uuid: supplierUuid,
              active: 1,
              created_at: new Date().toISOString(),
            },
          },
        ],
      },
      ownerToken
    );
    expect(ownerPush.statusCode).toBe(200);

    const milkPush = await post(
      '/sync/push',
      {
        changes: [
          {
            table: 'milk_collections',
            uuid: 'saleem-morning',
            op: 'upsert',
            clientUpdatedAt: new Date().toISOString(),
            data: {
              date: '2026-10-22',
              shift: 'Morning',
              supplier_uuid: supplierUuid,
              supplier_name: 'Saleem',
              collector_id: 'someone-else',
              collector_name: 'Bilal',
              liters: 12,
              fat_percentage: 6.2,
              rate_per_liter: 160,
              total_amount: 1920,
              created_at: new Date().toISOString(),
            },
          },
        ],
      },
      collectorToken
    );
    expect(milkPush.statusCode).toBe(200);
    expect(JSON.parse(milkPush.body).applied).toBe(1);

    const farmerPull = await get('/sync/pull?since=0&limit=500', farmerToken);
    expect(farmerPull.statusCode).toBe(200);
    const farmerChanges = JSON.parse(farmerPull.body).changes as Array<{ table: string; uuid: string; data?: { collector_id?: string } }>;
    const tables = farmerChanges.map((change) => change.table);
    expect(tables).toContain('suppliers');
    expect(tables).toContain('milk_collections');
    expect(tables).not.toContain('expenses');
    const milk = farmerChanges.find((change) => change.uuid === 'saleem-morning');
    expect(milk?.data?.collector_id).not.toBe('someone-else');

    const ownerPull = await get('/sync/pull?since=0&limit=500', ownerToken);
    const ownerTables = (JSON.parse(ownerPull.body).changes as Array<{ table: string }>).map((change) => change.table);
    expect(ownerTables).toContain('milk_collections');
    expect(ownerTables).toContain('expenses');
  });

  it('a member password change does not replace the owner password or role', async () => {
    const ownerBefore = await post('/auth/login', {
      email: 'owner@collection.test',
      password: 'StrongPassword123!',
    });
    expect(ownerBefore.statusCode).toBe(200);

    const changed = await post(
      '/auth/change-password',
      { currentPassword: 'Password123!', newPassword: 'CollectorPass1' },
      collectorToken
    );
    expect(changed.statusCode).toBe(200);

    const me = await get('/auth/me', JSON.parse(changed.body).token);
    expect(me.statusCode).toBe(200);
    expect(JSON.parse(me.body).role).toBe('collector');

    const ownerAfter = await post('/auth/login', {
      email: 'owner@collection.test',
      password: 'StrongPassword123!',
    });
    expect(ownerAfter.statusCode).toBe(200);

    const collectorOld = await get('/auth/me', collectorToken);
    expect(collectorOld.statusCode).toBe(401);

    const collectorNew = await post('/auth/login', {
      email: 'dodhi@collection.test',
      password: 'CollectorPass1',
    });
    expect(collectorNew.statusCode).toBe(200);
    expect(JSON.parse(collectorNew.body).farm.role).toBe('collector');
  });
});
