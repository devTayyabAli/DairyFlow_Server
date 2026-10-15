import { getCountersCollection, getRecordsCollection, RecordDocument } from '../db.js';
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

export async function applyPush(farmId: string, changes: Change[]): Promise<PushResult> {
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
      cursor: counterDoc?.seq ?? 0,
    };
  }

  // 2. Fetch existing records for conflict check (LWW: ignore if incoming clientUpdatedAt is older)
  const queryPairs = validChanges.map((vc) => ({
    table: vc.change.table,
    uuid: vc.change.uuid,
  }));

  const existingDocs = await recordsCol
    .find({
      farmId,
      $or: queryPairs.map((p) => ({ table: p.table, uuid: p.uuid })),
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

  let finalSeq = 0;
  const currentCounter = await countersCol.findOne({ _id: farmId });
  finalSeq = currentCounter?.seq ?? 0;

  // 3. Allocate monotonic sequence numbers and apply in bulk
  if (changesToApply.length > 0) {
    const counterResult = await countersCol.findOneAndUpdate(
      { _id: farmId },
      { $inc: { seq: changesToApply.length } },
      { upsert: true, returnDocument: 'after' }
    );

    const endSeq = counterResult?.seq ?? changesToApply.length;
    const startSeq = endSeq - changesToApply.length + 1;
    finalSeq = endSeq;

    const operations = changesToApply.map((item, index) => {
      const assignedSeq = startSeq + index;
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
              seq: assignedSeq,
              updatedAt: new Date(),
              clientUpdatedAt: item.change.clientUpdatedAt,
            },
          },
          upsert: true,
        },
      };
    });

    await recordsCol.bulkWrite(operations, { ordered: true });
  }

  return {
    applied: changesToApply.length + ignoredCount,
    rejected,
    cursor: finalSeq,
  };
}

export async function pullChanges(
  farmId: string,
  since: number = 0,
  limit: number = 500
): Promise<PullResult> {
  const safeLimit = Math.min(Math.max(1, limit), 500);
  const recordsCol = getRecordsCollection();

  const docs = await recordsCol
    .find({
      farmId,
      seq: { $gt: since },
    })
    .sort({ seq: 1 })
    .limit(safeLimit + 1)
    .toArray();

  const hasMore = docs.length > safeLimit;
  const selectedDocs = hasMore ? docs.slice(0, safeLimit) : docs;

  const changes: ServerChange[] = selectedDocs.map((doc) => ({
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
