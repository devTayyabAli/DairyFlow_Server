import dns from 'node:dns';
import { Collection, Db, MongoClient, ObjectId } from 'mongodb';
import { config } from './config.js';

if (config.MONGODB_URI.startsWith('mongodb+srv://')) {
  try {
    dns.setServers(['8.8.8.8', '1.1.1.1']);
  } catch {
    // Ignore if not permitted in environment
  }
}

export interface FarmDocument {
  _id?: ObjectId;
  farmName: string;
  ownerName: string;
  /** Login identifier. Absent on legacy phone-only accounts created before email login. */
  email?: string;
  /** false until the registration OTP is confirmed; unverified accounts cannot log in. */
  emailVerified?: boolean;
  phone?: string;
  passwordHash: string;
  defaultMilkRate?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OtpDocument {
  _id?: ObjectId;
  email: string;
  purpose: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  lastSentAt: Date;
  windowStartedAt: Date;
  sendsInWindow: number;
  /** TTL deletion time: outlives the code itself so hourly resend limits and "expired" still work. */
  purgeAt: Date;
  createdAt: Date;
}

export interface RecordDocument {
  _id?: ObjectId;
  farmId: string;
  table: string;
  uuid: string;
  data?: Record<string, unknown>;
  deleted: boolean;
  seq: number;
  updatedAt: Date;
  clientUpdatedAt: string;
}

export interface CounterDocument {
  _id: string; // farmId
  seq: number;
}

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connectToDb(uri = config.MONGODB_URI, dbName = config.MONGODB_DB): Promise<Db> {
  if (!client) {
    client = new MongoClient(uri);
    await client.connect();
    db = client.db(dbName);
    await ensureIndexes();
  }
  return db!;
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

export function getDb(): Db {
  if (!db) {
    throw new Error('Database not initialized. Call connectToDb first.');
  }
  return db;
}

export function getFarmsCollection(): Collection<FarmDocument> {
  return getDb().collection<FarmDocument>('farms');
}

export function getOtpsCollection(): Collection<OtpDocument> {
  return getDb().collection<OtpDocument>('otps');
}

export function getRecordsCollection(): Collection<RecordDocument> {
  return getDb().collection<RecordDocument>('records');
}

export function getCountersCollection(): Collection<CounterDocument> {
  return getDb().collection<CounterDocument>('counters');
}

export async function ensureIndexes(): Promise<void> {
  const farms = getFarmsCollection();
  // Login moved from phone to email: phone is no longer unique/required.
  try {
    await farms.dropIndex('phone_1');
  } catch {
    // index does not exist (fresh database) or was already dropped
  }
  // Partial so legacy phone-only farms (no email) never collide with each other.
  await farms.createIndex(
    { email: 1 },
    { unique: true, partialFilterExpression: { email: { $type: 'string' } } }
  );

  const otps = getOtpsCollection();
  await otps.createIndex({ email: 1, purpose: 1 }, { unique: true });
  await otps.createIndex({ purgeAt: 1 }, { expireAfterSeconds: 0 });

  const records = getRecordsCollection();
  await records.createIndex({ farmId: 1, table: 1, uuid: 1 }, { unique: true });
  await records.createIndex({ farmId: 1, seq: 1 });
}
