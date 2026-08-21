/**
 * Injectable inviteEmployee saga.
 * Journal reservation + reserved UID happen before Auth creation.
 */
import {
  decideInviteJournalAction,
  inviteAttemptId,
  inviteIntentDigest,
  mergeStaffClaimsOnly,
  nextInvitePhaseAfterWrite,
  verifyInviteStores,
  type InviteIntent,
  type InviteJournalEntry,
  type InviteJournalPhase,
} from './inviteEmployeeJournal';
import { classifyExistingAuthUser, decideInviteEmployee } from './inviteEmployeeDecision';
import type { AdminAuthority } from './canonicalAdminAuthority';

export const INVITE_LEASE_MS = 90_000;

export interface InviteSagaStores {
  nowMs(): number;
  newUid(): string;
  newOwnerToken(): string;
  readJournal(id: string): Promise<InviteJournalEntry | null>;
  writeJournal(entry: InviteJournalEntry): Promise<InviteJournalEntry>;
  claimJournal(entry: InviteJournalEntry, ownerToken: string, nowMs: number): Promise<
    | { ok: true; entry: InviteJournalEntry }
    | { ok: false; reason: string }
  >;
  getUserByEmail(email: string): Promise<{ uid: string; email: string; claims: Record<string, unknown> } | null>;
  createUser(input: { uid: string; email: string; displayName: string }): Promise<{ uid: string }>;
  getUser(uid: string): Promise<{ uid: string; email?: string; claims: Record<string, unknown> }>;
  setClaims(uid: string, claims: Record<string, unknown>): Promise<void>;
  getRtdb(uid: string): Promise<Record<string, unknown> | null>;
  setRtdb(uid: string, data: Record<string, unknown>): Promise<void>;
  getStaff(uid: string): Promise<Record<string, unknown> | null>;
  setStaff(uid: string, data: Record<string, unknown>): Promise<void>;
  getPlatformAdmin(uid: string): Promise<{ enabled?: boolean } | null>;
  getDriver(hash: string): Promise<Record<string, unknown> | null>;
  setDriver(hash: string, data: Record<string, unknown>): Promise<void>;
  findDriverByDashboardUid(uid: string): Promise<{ hash: string; data: Record<string, unknown> } | null>;
}

export function decideInviteLease(input: {
  journal: InviteJournalEntry | null;
  ownerToken: string;
  nowMs: number;
}): 'acquire' | 'resume' | 'collision' {
  if (!input.journal) return 'acquire';
  if (input.journal.ownerToken === input.ownerToken) return 'resume';
  if (typeof input.journal.leaseUntil === 'number' && input.journal.leaseUntil > input.nowMs) {
    return 'collision';
  }
  return 'acquire';
}

export function mayAdoptJournalOwnedAuth(input: {
  journal: InviteJournalEntry;
  existingUid: string;
  email: string;
  intentDigest: string;
  ownerToken: string;
  invitedBy?: string;
  nowMs?: number;
}): boolean {
  if (input.journal.reservedUid !== input.existingUid) return false;
  if (input.journal.email !== input.email) return false;
  if (input.journal.intentDigest !== input.intentDigest) return false;
  if (input.journal.invitedBy && input.invitedBy && input.journal.invitedBy !== input.invitedBy) {
    return false;
  }
  if (input.journal.ownerToken && input.journal.ownerToken !== input.ownerToken) {
    const leaseValid = typeof input.journal.leaseUntil === 'number'
      && typeof input.nowMs === 'number'
      && input.journal.leaseUntil > input.nowMs;
    if (leaseValid) return false;
  }
  return true;
}

export async function runInviteEmployeeSaga(
  stores: InviteSagaStores,
  input: {
    authority: AdminAuthority;
    email: string;
    role: string;
    companyId: string | null;
    displayName?: string | null;
    driverHash?: string | null;
    explicitRebind?: boolean;
    invitedBy: string;
    ownerToken?: string;
  },
): Promise<
  | { ok: true; uid: string; existed: boolean; role: string; companyId: string }
  | { ok: false; reason: string }
> {
  const email = input.email.trim().toLowerCase();
  const ownerToken = input.ownerToken || stores.newOwnerToken();
  const now = stores.nowMs();

  const existing = await stores.getUserByEmail(email);
  const existingUid = existing?.uid || null;
  const claims = existing?.claims || {};
  const [staff, rtdb, plat, driverBind] = existingUid
    ? await Promise.all([
      stores.getStaff(existingUid),
      stores.getRtdb(existingUid),
      stores.getPlatformAdmin(existingUid),
      stores.findDriverByDashboardUid(existingUid),
    ])
    : [null, null, null, null];

  const existingClass = classifyExistingAuthUser({
    exists: !!existingUid,
    staffCompanyId: typeof staff?.companyId === 'string' ? String(staff.companyId) : null,
    rtdbCompanyId: typeof rtdb?.companyId === 'string' ? String(rtdb.companyId) : null,
    claimsCompanyId: typeof claims.staffCompanyId === 'string' ? String(claims.staffCompanyId) : null,
    stampCompanyId: (input.companyId || input.authority.ok && input.authority.companyId) || '',
    platformAdminEnabled: claims.platformAdminEnabled === true,
    wellbuiltAdminClaim: claims.wellbuiltAdmin === true,
    platformAdminRecordEnabled: plat?.enabled === true,
    driverBound: !!driverBind,
    driverCompanyId: driverBind && typeof driverBind.data.companyId === 'string'
      ? String(driverBind.data.companyId)
      : null,
  });
  if (existingClass === 'platform') {
    return { ok: false, reason: 'existing_platform_admin' };
  }

  let driverCompanyId: string | null = null;
  if (input.driverHash) {
    const d = await stores.getDriver(input.driverHash);
    if (!d) return { ok: false, reason: 'driver_not_found' };
    driverCompanyId = typeof d.companyId === 'string' ? d.companyId : null;
  }

  const decided = decideInviteEmployee({
    authority: input.authority,
    requestedCompanyId: input.companyId,
    requestedRole: input.role,
    existingUserExists: !!existingUid,
    existingStaffCompanyId: typeof staff?.companyId === 'string' ? String(staff.companyId) : null,
    existingRtdbCompanyId: typeof rtdb?.companyId === 'string' ? String(rtdb.companyId) : null,
    existingClaimsCompanyId: typeof claims.staffCompanyId === 'string' ? String(claims.staffCompanyId) : null,
    existingPlatformAdminEnabled: claims.platformAdminEnabled === true,
    existingWellbuiltAdminClaim: claims.wellbuiltAdmin === true,
    existingPlatformAdminRecordEnabled: plat?.enabled === true,
    existingDriverBound: !!driverBind,
    existingDriverCompanyId: driverBind && typeof driverBind.data.companyId === 'string'
      ? String(driverBind.data.companyId)
      : null,
    explicitRebind: input.explicitRebind === true,
    driverHashProvided: !!input.driverHash,
    driverCompanyId,
  });

  const attemptId = inviteAttemptId(email, (decided.ok ? decided.stampCompanyId : input.companyId) || 'pending');
  const journal0 = await stores.readJournal(attemptId);
  const incomingDigest = inviteIntentDigest({
    email,
    companyId: (decided.ok ? decided.stampCompanyId : journal0?.companyId || input.companyId) || '',
    role: input.role,
    driverHash: input.driverHash || null,
    rebind: decided.ok ? decided.rebind : false,
  });
  const journalOwned = !!(existingUid && journal0 && mayAdoptJournalOwnedAuth({
    journal: journal0,
    existingUid,
    email,
    intentDigest: incomingDigest,
    ownerToken,
    invitedBy: input.invitedBy,
    nowMs: now,
  }));

  const journalOwnedAdoptReasons = new Set([
    'unscoped_existing_user',
    'ambiguous_existing_user',
  ]);
  if (!decided.ok) {
    if (journalOwned && journalOwnedAdoptReasons.has(decided.reason)) {
      // continue — this operation reserved the UID and stores are mid-write
    } else {
      return { ok: false, reason: decided.reason };
    }
  }
  const stampCompanyId = decided.ok ? decided.stampCompanyId : (journal0?.companyId || '');
  if (!stampCompanyId) return { ok: false, reason: 'unscoped_target' };

  const intent: InviteIntent = {
    email,
    companyId: stampCompanyId,
    role: input.role,
    driverHash: input.driverHash || null,
    rebind: decided.ok ? decided.rebind : false,
  };
  const digest = inviteIntentDigest(intent);
  const reservedUid = journal0?.reservedUid || stores.newUid();

  const lease = decideInviteLease({ journal: journal0, ownerToken, nowMs: now });
  if (lease === 'collision') return { ok: false, reason: 'invite_lease_collision' };

  const action = decideInviteJournalAction({ journal: journal0, intent });
  if (action.action === 'refuse') return { ok: false, reason: action.reason };

  let journal: InviteJournalEntry = {
    attemptId,
    email,
    uid: journal0?.uid || reservedUid,
    reservedUid,
    companyId: stampCompanyId,
    role: input.role,
    phase: action.action === 'resume' ? (journal0?.phase || 'started') : 'started',
    driverHash: input.driverHash || null,
    rebind: intent.rebind,
    intentDigest: digest,
    createdByThisOperation: journal0?.createdByThisOperation === true,
    ownerToken,
    invitedBy: input.invitedBy,
    leaseUntil: now + INVITE_LEASE_MS,
  };
  const claimed = await stores.claimJournal(journal, ownerToken, now);
  if (!claimed.ok) return { ok: false, reason: claimed.reason };
  journal = claimed.entry;

  let uid = existingUid || journal.reservedUid || reservedUid;
  let existed = !!existingUid;
  if (!existingUid) {
    journal = {
      ...journal,
      reservedUid: journal.reservedUid || reservedUid,
      uid: journal.reservedUid || reservedUid,
    };
    journal = await stores.writeJournal(journal);
    await stores.createUser({
      uid: journal.reservedUid || reservedUid,
      email,
      displayName: input.displayName || email.split('@')[0],
    });
    uid = journal.reservedUid || reservedUid;
    journal = {
      ...journal,
      uid,
      reservedUid: uid,
      createdByThisOperation: true,
      phase: nextInvitePhaseAfterWrite(journal.phase, 'auth'),
    };
    journal = await stores.writeJournal(journal);
  } else if (journalOwned) {
    uid = existingUid;
    existed = true;
  } else if (existingClass === 'unscoped' && !journalOwned) {
    return { ok: false, reason: 'unscoped_existing_user' };
  }

  const displayName = input.displayName || email.split('@')[0];
  const advance = async (phase: InviteJournalPhase) => {
    journal = {
      ...journal,
      uid,
      phase: nextInvitePhaseAfterWrite(
        journal.phase,
        phase === 'auth_created' ? 'auth'
          : phase === 'rtdb_written' ? 'rtdb'
            : phase === 'staff_written' ? 'staff'
              : phase === 'claims_stamped' ? 'claims'
                : phase === 'driver_linked' ? 'driver'
                  : 'complete',
      ),
    };
    journal = await stores.writeJournal(journal);
  };

  const oldHash = typeof rtdb?.driverHash === 'string' ? String(rtdb.driverHash) : null;
  const nextHash = input.driverHash || null;
  if (oldHash && oldHash !== nextHash) {
    const oldDriver = await stores.getDriver(oldHash);
    await stores.setDriver(oldHash, { ...(oldDriver || {}), dashboardUid: null, dashboardRole: null });
  }

  await stores.setRtdb(uid, {
    email,
    displayName,
    role: input.role,
    companyId: stampCompanyId,
    driverHash: nextHash,
  });
  await advance('rtdb_written');
  await stores.setStaff(uid, {
    enabled: true,
    companyId: stampCompanyId,
    role: input.role,
    updatedAt: stores.nowMs(),
    invitedBy: input.invitedBy,
  });
  await advance('staff_written');

  const user = await stores.getUser(uid);
  const stamped = mergeStaffClaimsOnly(user.claims, {
    staffCompanyId: stampCompanyId,
    staffRole: input.role,
  });
  if (!stamped.ok) return { ok: false, reason: stamped.reason };
  await stores.setClaims(uid, stamped.next);
  await advance('claims_stamped');

  if (nextHash) {
    const d = await stores.getDriver(nextHash);
    await stores.setDriver(nextHash, { ...(d || {}), dashboardUid: uid, dashboardRole: input.role });
    await advance('driver_linked');
  }

  const [rtdbNow, staffNow, userNow, driverNow, former] = await Promise.all([
    stores.getRtdb(uid),
    stores.getStaff(uid),
    stores.getUser(uid),
    nextHash ? stores.getDriver(nextHash) : Promise.resolve(null),
    oldHash && oldHash !== nextHash ? stores.getDriver(oldHash) : Promise.resolve(null),
  ]);
  const verified = verifyInviteStores({
    intent,
    uid,
    rtdb: rtdbNow,
    staff: staffNow,
    claims: userNow.claims,
    driverLink: driverNow,
    formerDriver: former,
  });
  if (!verified.ok) {
    if (journal.intentDigest === digest && journal.phase !== 'started') {
      return { ok: false, reason: `recoverable:${verified.reason}` };
    }
    return { ok: false, reason: verified.reason };
  }
  await advance('completed');
  return { ok: true, uid, existed, role: input.role, companyId: stampCompanyId };
}
