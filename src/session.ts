import { ObjectId } from 'mongodb';
import { FarmDocument, getFarmsCollection, getMembershipsCollection, UserRole } from './db.js';

export interface AccountSession {
  tenantId: string;
  userId: string;
  role: UserRole;
  profile: FarmDocument & { _id: ObjectId };
}

/**
 * Maps a login account to the tenant it should operate on.
 * A membership wins over the account's own farm document, and a suspended
 * membership cannot fall through into that empty personal farm.
 */
export async function resolveAccountSession(
  account: FarmDocument & { _id: ObjectId }
): Promise<{ ok: true; session: AccountSession } | { ok: false; code: 'ACCOUNT_SUSPENDED' }> {
  const membership = await getMembershipsCollection().findOne({ userId: account._id });
  if (!membership) {
    return {
      ok: true,
      session: {
        tenantId: account._id.toString(),
        userId: account._id.toString(),
        role: 'owner',
        profile: account,
      },
    };
  }

  if (membership.status === 'suspended') {
    return { ok: false, code: 'ACCOUNT_SUSPENDED' };
  }

  const tenantFarm = await getFarmsCollection().findOne({ _id: membership.tenantId });
  const profile = (tenantFarm ?? account) as FarmDocument & { _id: ObjectId };
  return {
    ok: true,
    session: {
      tenantId: membership.tenantId.toString(),
      userId: account._id.toString(),
      role: membership.role,
      profile,
    },
  };
}
