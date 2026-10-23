import { randomUUID } from 'node:crypto';
import { getCountersCollection, getRecordsCollection, RecordDocument } from '../db.js';
import { bandsConflict, decideMilkUpsert, FatBandRecord } from './pricing.js';
import {
  ALLOWED_SYNC_SETTINGS,
  Change,
  ServerChange,
  tableSchemas,
} from './schemas.js';

export interface PushResult {
  applied: number;
  rejected: Array<{
    uuid: string;
    table: string;
    reason: string;
  }>;
  cursor: number;
}

export interface PullResult {
  changes: ServerChange[];
  cursor: number;
  hasMore: boolean;
}

/**
 * Parses ISO-8601 or SQLite `datetime('now')` ("YYYY-MM-DD HH:MM:SS", always UTC) to epoch ms.
 * Returns null when unparseable so callers fail open (apply the change) rather than drop data.
 */
export function parseClientTimestamp(value: string): number | null {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

const LOCK_LEASE_MS = 30_000;
const LOCK_WAIT_MS = 20_000;

export class PushBusyError extends Error {
  statusCode = 503;
  code = 'SYNC_BUSY';
  constructor() {
    super('Another sync is in progress for this farm. Please retry shortly.');
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Pushes are serialised per farm with a short Mongo lease. Together with the commit watermark
 * (counters.committed) this guarantees a pull can never observe a seq gap that is filled later:
 * seqs are allocated and written under the lock, and the watermark only advances to the last
 * seq of a fully written batch. (A pull running concurrently with a push simply does not see
 * that push's rows yet; they appear on the next pull.)
 */
async function acquireFarmLock(farmId: string): Promise<{ lockId: string; seq: number; committed: number }> {
  const counters = getCountersCollection();
  const lockId = randomUUID();
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const now = new Date();
    try {
      const doc = await counters.findOneAndUpdate(
        {
          _id: farmId,
          $or: [{ lockUntil: { $exists: false } }, { lockUntil: null }, { lockUntil: { $lt: now } }],
        },
        [
          {
            $set: {
              lockId,
              lockUntil: new Date(now.getTime() + LOCK_LEASE_MS),
              seq: { $ifNull: ['$seq', 0] },
              // Documents from before the watermark existed: everything allocated is committed.
              committed: { $ifNull: ['$committed', { $ifNull: ['$seq', 0] }] },
            },
          },
        ] as never,
        { upsert: true, returnDocument: 'after' }
      );
      return { lockId, seq: doc!.seq, committed: doc!.committed ?? doc!.seq };
    } catch (err) {
      // 11000: the filter did not match (lock held) so the upsert collided on _id.
      if ((err as { code?: number }).code !== 11000) throw err;
    }
    if (Date.now() > deadline) throw new PushBusyError();
    await sleep(10 + Math.random() * 30);
  }
}

async function releaseFarmLock(farmId: string, lockId: string, committed?: number): Promise<void> {
  const set: Record<string, unknown> = { lockId: null, lockUntil: null };
  if (committed !== undefined) set.committed = committed;
  await getCountersCollection().updateOne({ _id: farmId, lockId }, { $set: set });
}

export interface PushActor {
  userId: string;
  role: string;
}

function toBand(data: Record<string, unknown>, uuid: string): FatBandRecord {
  return {
    uuid,
    min_fat: Number(data.min_fat),
    max_fat: Number(data.max_fat),
    rate_per_liter: Number(data.rate_per_liter),
    effective_from: String(data.effective_from),
    effective_to: typeof data.effective_to === 'string' ? data.effective_to : null,
    active: Number(data.active ?? 1),
  };
}

export async function applyPush(farmId: string, changes: Change[], actor?: PushActor): Promise<PushResult> {
  const rejected: Array<{ uuid: string; table: string; reason: string }> = [];
  const validChanges: Array<{
    change: Change;
    validatedData?: Record<string, unknown>;
  }> = [];

  // 1. Validate each change according to schema
  for (const change of changes) {
    if (change.table === 'settings') {
      if (!ALLOWED_SYNC_SETTINGS.includes(change.uuid as (typeof ALLOWED_SYNC_SETTINGS)[number])) {
        rejected.push({
          uuid: change.uuid,
          table: change.table,
          reason: `Setting "${change.uuid}" is restricted and cannot be synced.`,
        });
        continue;
      }
    }

    const schema = tableSchemas[change.table];
    if (!schema) {
      rejected.push({
        uuid: change.uuid,
        table: change.table,
        reason: `Unknown table "${change.table}".`,
      });
      continue;
    }

    if (change.op === 'upsert') {
      if (!change.data || typeof change.data !== 'object') {
        rejected.push({
          uuid: change.uuid,
          table: change.table,
          reason: 'Upsert operation must contain a valid data object.',
        });
        continue;
      }

      const parsed = schema.safeParse(change.data);
      if (!parsed.success) {
        const errorMsg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        rejected.push({
          uuid: change.uuid,
          table: change.table,
          reason: `Validation failed: ${errorMsg}`,
        });
        continue;
      }

      validChanges.push({
        change,
        validatedData: parsed.data as Record<string, unknown>,
      });
    } else if (change.op === 'delete') {
      if (change.table === 'ledger_entries') {
        rejected.push({
          uuid: change.uuid,
          table: change.table,
          reason: 'Ledger entries are immutable and cannot be deleted. Create a compensating adjustment entry instead.',
        });
        continue;
      }
      validChanges.push({
        change,
        validatedData: undefined,
      });
    } else {
      rejected.push({
        uuid: change.uuid,
        table: change.table,
        reason: `Unsupported operation "${(change as { op: string }).op}".`,
      });
    }
  }

  const recordsCol = getRecordsCollection();
  const countersCol = getCountersCollection();

  if (validChanges.length === 0) {
    const counterDoc = await countersCol.findOne({ _id: farmId });
    return {
      applied: 0,
      rejected,
      cursor: counterDoc?.committed ?? counterDoc?.seq ?? 0,
    };
  }

  const lock = await acquireFarmLock(farmId);
  let finalSeq = lock.committed;
  let appliedCount = 0;
  let commitTo: number | undefined;
  try {
    // 2. Fetch existing records for conflict check (LWW: ignore if incoming clientUpdatedAt is older)
    const existingDocs = await recordsCol
      .find({
        farmId,
        $or: validChanges.map((vc) => ({ table: vc.change.table, uuid: vc.change.uuid })),
      })
      .toArray();

    const existingMap = new Map<string, RecordDocument>();
    for (const doc of existingDocs) {
      existingMap.set(`${doc.table}:${doc.uuid}`, doc);
    }

    const changesToApply: Array<{
      change: Change;
      validatedData?: Record<string, unknown>;
    }> = [];

    let ignoredCount = 0;

    for (const vc of validChanges) {
      const key = `${vc.change.table}:${vc.change.uuid}`;
      const existing = existingMap.get(key);

      if (existing && existing.clientUpdatedAt) {
        // If incoming clientUpdatedAt is older than stored one, ignore (count as applied, no change).
        // Compare as instants, not strings: clients send both ISO ("…T…Z") and SQLite
        // ("YYYY-MM-DD HH:MM:SS", UTC) formats, which do not sort correctly as text.
        const incoming = parseClientTimestamp(vc.change.clientUpdatedAt);
        const stored = parseClientTimestamp(existing.clientUpdatedAt);
        if (incoming !== null && stored !== null && incoming < stored) {
          ignoredCount++;
          continue;
        }
      }

      changesToApply.push(vc);
    }

    // Fat bands and milk are checked under the farm lock so two overlapping
    // rates or two collections for the same shift cannot both land.
    // Conflict policy: last client timestamp wins for ordinary edits. A change
    // the server refuses is returned in `rejected` and is not applied. Ledger
    // rows and milk rows are not deleted. A milk row keeps its saved rate when
    // the fat percentage is unchanged.
    const bandDocs = await recordsCol.find({ farmId, table: 'fat_rate_bands', deleted: false }).toArray();
    let bands = bandDocs.map((doc) => toBand(doc.data ?? {}, doc.uuid));
    const milkDocs = await recordsCol
      .find({ farmId, table: 'milk_collections', deleted: false })
      .toArray();
    const takenShifts = new Set<string>();
    for (const doc of milkDocs) {
      const data = doc.data ?? {};
      takenShifts.add(`${data.supplier_uuid}|${data.date}|${data.shift}`);
    }
    const assignedSuppliers = new Set<string>();
    if (actor?.role === 'collector') {
      const assignmentDocs = await recordsCol
        .find({
          farmId,
          table: 'collector_assignments',
          deleted: false,
          'data.collector_user_id': actor.userId,
          'data.active': 1,
        })
        .toArray();
      for (const doc of assignmentDocs) {
        const supplierUuid = doc.data?.supplier_uuid;
        if (typeof supplierUuid === 'string') assignedSuppliers.add(supplierUuid);
      }
    }

    const screened: typeof changesToApply = [];
    for (const vc of changesToApply) {
      if (vc.change.table === 'milk_collections' && vc.change.op === 'delete') {
        rejected.push({
          uuid: vc.change.uuid,
          table: vc.change.table,
          reason: 'Milk collections are not deleted. Correct the entry instead.',
        });
        continue;
      }
      if (vc.change.table === 'fat_rate_bands' && vc.change.op === 'delete') {
        rejected.push({
          uuid: vc.change.uuid,
          table: vc.change.table,
          reason: 'Deactivate a fat-rate band instead of deleting it.',
        });
        continue;
      }
      if (vc.change.table === 'fat_rate_bands' && vc.change.op === 'upsert' && vc.validatedData) {
        const candidate = toBand(vc.validatedData, vc.change.uuid);
        if (bandsConflict(candidate, bands)) {
          rejected.push({
            uuid: vc.change.uuid,
            table: vc.change.table,
            reason: 'This fat range overlaps another active band on the same dates.',
          });
          continue;
        }
        bands = bands.filter((band) => band.uuid !== candidate.uuid).concat(candidate);
        screened.push(vc);
        continue;
      }
      if (vc.change.table === 'milk_collections' && vc.change.op === 'upsert' && vc.validatedData) {
        const data = vc.validatedData;
        const key = `${data.supplier_uuid}|${data.date}|${data.shift}`;
        const existingDoc = existingMap.get(`milk_collections:${vc.change.uuid}`);
        const existing = existingDoc && !existingDoc.deleted ? (existingDoc.data ?? null) : null;
        const previousKey = existing
          ? `${existing.supplier_uuid}|${existing.date}|${existing.shift}`
          : '';
        if (previousKey) takenShifts.delete(previousKey);
        const decision = decideMilkUpsert({
          data,
          existing,
          bands,
          shiftTaken: takenShifts.has(key),
          assigned: actor?.role !== 'collector' || assignedSuppliers.has(String(data.supplier_uuid)),
        });
        if (!decision.ok) {
          if (previousKey) takenShifts.add(previousKey);
          rejected.push({ uuid: vc.change.uuid, table: vc.change.table, reason: decision.reason });
          continue;
        }
        vc.validatedData = decision.data;
        takenShifts.add(key);
        screened.push(vc);
        continue;
      }
      screened.push(vc);
    }
    changesToApply.length = 0;
    changesToApply.push(...screened);

    appliedCount = changesToApply.length + ignoredCount;

    // 3. Allocate a contiguous seq range, write it, then advance the commit watermark.
    if (changesToApply.length > 0) {
      const counterResult = await countersCol.findOneAndUpdate(
        { _id: farmId, lockId: lock.lockId },
        { $inc: { seq: changesToApply.length } },
        { returnDocument: 'after' }
      );
      if (!counterResult) throw new PushBusyError(); // lease lost (should not happen)

      const endSeq = counterResult.seq;
      const startSeq = endSeq - changesToApply.length + 1;

      const operations = changesToApply.map((item, index) => {
        const isDelete = item.change.op === 'delete';
        return {
          updateOne: {
            filter: {
              farmId,
              table: item.change.table,
              uuid: item.change.uuid,
            },
            update: {
              $set: {
                farmId,
                table: item.change.table,
                uuid: item.change.uuid,
                data: isDelete ? {} : item.validatedData,
                deleted: isDelete,
                seq: startSeq + index,
                updatedAt: new Date(),
                clientUpdatedAt: item.change.clientUpdatedAt,
              },
            },
            upsert: true,
          },
        };
      });

      await recordsCol.bulkWrite(operations, { ordered: true });
      commitTo = endSeq;
      finalSeq = endSeq;
    }
  } finally {
    // On failure the watermark is left alone; a later successful push moves it past any gap.
    await releaseFarmLock(farmId, lock.lockId, commitTo);
  }

  return {
    applied: appliedCount,
    rejected,
    cursor: finalSeq,
  };
}

export interface PullViewer {
  userId: string;
  role: string;
}

export interface VisibilityScope {
  farmerSupplierUuids: Set<string>;
  collectorSupplierUuids: Set<string>;
}

/** Owner sees the whole business. A dodhi sees assigned dairies, the fat table, and his own collections. A dairy sees its own milk, bills, and payments. */
export function recordVisibleTo(
  doc: { table: string; uuid: string; data?: Record<string, unknown> },
  viewer: PullViewer,
  scope: VisibilityScope
): boolean {
  if (viewer.role === 'collector') {
    if (doc.table === 'fat_rate_bands') return true;
    if (doc.table === 'collector_assignments') return doc.data?.collector_user_id === viewer.userId;
    if (doc.table === 'suppliers') return scope.collectorSupplierUuids.has(doc.uuid);
    if (doc.table === 'milk_collections') return doc.data?.collector_id === viewer.userId;
    return false;
  }
  if (viewer.role === 'farmer') {
    if (doc.table === 'suppliers') return doc.data?.linked_farm_id === viewer.userId;
    if (doc.table === 'milk_collections') {
      const supplierUuid = doc.data?.supplier_uuid;
      return typeof supplierUuid === 'string' && scope.farmerSupplierUuids.has(supplierUuid);
    }
    if (doc.table === 'ledger_entries') {
      const accountUuid = doc.data?.account_uuid;
      return doc.data?.account_type === 'supplier' && typeof accountUuid === 'string' && scope.farmerSupplierUuids.has(accountUuid);
    }
    if (doc.table === 'settlements') {
      const targetUuid = doc.data?.target_uuid;
      return doc.data?.target_type === 'supplier' && typeof targetUuid === 'string' && scope.farmerSupplierUuids.has(targetUuid);
    }
    return false;
  }
  return true;
}

export async function pullChanges(
  farmId: string,
  since: number = 0,
  limit: number = 500,
  viewer?: PullViewer
): Promise<PullResult> {
  const safeLimit = Math.min(Math.max(1, limit), 500);
  const recordsCol = getRecordsCollection();

  // Never read past the commit watermark: rows above it may belong to a push that has
  // allocated its seqs but not finished writing (see acquireFarmLock).
  const counter = await getCountersCollection().findOne({ _id: farmId });
  const committed = counter ? (counter.committed ?? counter.seq) : 0;

  const docs = await recordsCol
    .find({
      farmId,
      seq: { $gt: since, $lte: committed },
    })
    .sort({ seq: 1 })
    .limit(safeLimit + 1)
    .toArray();

  const hasMore = docs.length > safeLimit;
  const selectedDocs = hasMore ? docs.slice(0, safeLimit) : docs;

  let farmerSupplierUuids = new Set<string>();
  if (viewer?.role === 'farmer') {
    const supplierRows = await recordsCol
      .find(
        { farmId, table: 'suppliers', deleted: false, 'data.linked_farm_id': viewer.userId },
        { projection: { uuid: 1 } }
      )
      .toArray();
    farmerSupplierUuids = new Set(supplierRows.map((row) => row.uuid));
  }

  let collectorSupplierUuids = new Set<string>();
  if (viewer?.role === 'collector') {
    const assignmentRows = await recordsCol
      .find({
        farmId,
        table: 'collector_assignments',
        deleted: false,
        'data.collector_user_id': viewer.userId,
        'data.active': 1,
      })
      .toArray();
    collectorSupplierUuids = new Set(
      assignmentRows
        .map((row) => row.data?.supplier_uuid)
        .filter((uuid): uuid is string => typeof uuid === 'string')
    );
  }

  const visibleDocs = viewer
    ? selectedDocs.filter((doc) =>
        recordVisibleTo(doc, viewer, { farmerSupplierUuids, collectorSupplierUuids })
      )
    : selectedDocs;

  const changes: ServerChange[] = visibleDocs.map((doc) => ({
    table: doc.table,
    uuid: doc.uuid,
    op: doc.deleted ? 'delete' : 'upsert',
    data: doc.deleted ? undefined : doc.data,
    seq: doc.seq,
  }));

  const lastSeq = selectedDocs.length > 0 ? selectedDocs[selectedDocs.length - 1].seq : since;

  return {
    changes,
    cursor: lastSeq,
    hasMore,
  };
}
