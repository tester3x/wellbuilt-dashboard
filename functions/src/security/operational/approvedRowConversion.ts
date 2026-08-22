/**
 * Owned, ordered conversion of a legacy drivers/approved row into a
 * canonical secure identity.
 *
 * ORDER (required):
 *   1. validate (zero writes on refuse)
 *   2. journal UUID claim (durable; retries reuse)
 *   3. identity (credential + name index) with opId
 *   4. canonical profile with provisioningOpId
 *   5. empty initialized shift authority (tagged if we created it)
 *   6. stamp migratedToDriverId / secureProfileLinked LAST
 *   7. mark journal completed
 *
 * The legacy row is never marked linked until identity, profile, and
 * authority are established. Compensation deletes only artifacts whose
 * ownership marker still equals this invocation's opId.
 *
 * After the link is committed, failures (journal/audit) do not roll back
 * a usable identity — the journal stays incomplete so the same UUID resumes.
 *
 * Pure decisions live here. I/O is injected so failure injection is
 * deterministic. Passcode material is never logged or returned.
 */
import {
  decideCreateSecureLoginLink,
  evaluateApprovedRowForCreate,
} from './legacySecureLink';
import {
  attemptKeyId,
  decideProvisioningOutcome,
  resolveProvisioningUuid,
  type ProvisioningJournalDeps,
} from './provisioningJournal';
import {
  decideCompensation,
  decideNameIndexClaim,
  readIncumbentCredential,
  readIndexOwner,
} from '../nameIndexClaim';
import { decideEnsureEmptyAuthority } from './shiftAuthority';
import { normalizeDisplayName } from '../passcode';

export type ConversionFailAfter =
  | 'identity'
  | 'profile'
  | 'authority'
  | 'during_legacy_link'
  | 'legacy_link'
  | 'journal_complete';

export type ConversionStatus =
  | 'ok'
  | 'refused'
  | 'rolled_back'
  | 'resumable';

export type ConversionRefusal =
  | 'legacy_link_required'
  | 'approved_key_malformed'
  | 'ambiguous_link_selector'
  | 'approved_row_missing'
  | 'approved_row_name_mismatch'
  | 'approved_row_already_linked'
  | 'provisioning_refused';

export interface PasscodeRecord {
  algo: string;
  saltB64: string;
  hashB64: string;
  N?: number;
  r?: number;
  p?: number;
  keyLen?: number;
}

export interface ConversionInput {
  approvedKey?: string;
  legacyHash?: string;
  driverId?: string;
  displayName: string;
  legalName?: string;
  companyId?: string;
  companyName?: string;
  passcodeRecord: PasscodeRecord;
  temporary: boolean;
  callerUid: string;
  opId: string;
  failAfter?: ConversionFailAfter;
}

export interface ConversionResult {
  status: ConversionStatus;
  reason: string;
  driverId: string | null;
  writes: ConversionWriteLog;
  copiedRoutes: unknown;
  copiedWells: unknown;
}

export interface ConversionWriteLog {
  credential: boolean;
  nameIndex: boolean;
  profile: boolean;
  authority: boolean;
  legacyLink: boolean;
  journalCompleted: boolean;
}

export function emptyWrites(): ConversionWriteLog {
  return {
    credential: false,
    nameIndex: false,
    profile: false,
    authority: false,
    legacyLink: false,
    journalCompleted: false,
  };
}

/** Missing assignedWells → explicit null on the canonical profile. */
export function copyAssignedWells(row: Record<string, unknown>): unknown {
  if (!Object.prototype.hasOwnProperty.call(row, 'assignedWells')) return null;
  if (row.assignedWells === undefined) return null;
  return row.assignedWells;
}

export function copyAssignedRoutes(row: Record<string, unknown>): unknown {
  if (!Object.prototype.hasOwnProperty.call(row, 'assignedRoutes')) return null;
  if (row.assignedRoutes === undefined) return null;
  return row.assignedRoutes;
}

export function buildCanonicalProfile(input: {
  row: Record<string, unknown>;
  displayName: string;
  legalName?: string;
  companyId?: string;
  companyName?: string;
  callerUid: string;
  opId: string;
}): Record<string, unknown> {
  const L = input.row;
  return {
    displayName: input.displayName,
    legalName: input.legalName || L.legalName || input.displayName,
    name: input.displayName,
    active: L.active !== false,
    isAdmin: L.isAdmin === true,
    isViewer: L.isViewer === true,
    companyId: input.companyId || L.companyId || null,
    companyName: input.companyName || L.companyName || null,
    assignedCustomers: L.assignedCustomers || null,
    assignedRoutes: copyAssignedRoutes(L),
    assignedWells: copyAssignedWells(L),
    roles: L.roles || ['driver'],
    approvedAt: L.approvedAt || Date.now(),
    approvedBy: input.callerUid,
    schemaVersion: 1,
    mustUseSecureAuth: true,
    provisioningOpId: input.opId,
  };
}

export interface ConversionStore {
  journal: ProvisioningJournalDeps;
  readApproved(key: string): Promise<Record<string, unknown> | null>;
  stampLegacyLink(input: {
    approvedKey: string;
    driverId: string;
    opId: string;
  }): Promise<'stamped' | 'already_ours' | 'foreign_link'>;
  unstampLegacyLinkIfOwned(input: {
    approvedKey: string;
    driverId: string;
    opId: string;
  }): Promise<'removed' | 'left_intact' | 'missing'>;
  writeIdentity(input: {
    driverId: string;
    nameNorm: string;
    displayName: string;
    passcodeRecord: PasscodeRecord;
    opId: string;
    temporary: boolean;
    callerUid: string;
  }): Promise<void>;
  compensateIdentity(input: {
    driverId: string;
    nameNorm: string;
    opId: string;
  }): Promise<{ deletedCredential: boolean; releasedIndex: boolean; superseded: boolean }>;
  writeProfile(driverId: string, profile: Record<string, unknown>): Promise<void>;
  removeProfileIfOwned(driverId: string, opId: string): Promise<'removed' | 'left_intact' | 'missing'>;
  ensureAuthority(input: {
    driverId: string;
    companyId: string | null;
    opId: string;
  }): Promise<{ action: string; wrote: boolean }>;
  removeAuthorityIfOwned(driverId: string, opId: string): Promise<'removed' | 'left_intact' | 'missing'>;
  inspect(driverId: string, nameNorm: string, approvedKey: string): Promise<{
    credentialOpId: string | null;
    indexDriverId: string | null;
    profileOpId: string | null;
    authorityOpId: string | null;
    legacyLinkedDriverId: string | null;
    legacyLinkOpId: string | null;
  }>;
}

function refuse(reason: ConversionRefusal, writes: ConversionWriteLog): ConversionResult {
  return {
    status: 'refused',
    reason,
    driverId: null,
    writes,
    copiedRoutes: null,
    copiedWells: null,
  };
}

async function compensatePreLink(
  store: ConversionStore,
  input: {
    driverId: string;
    nameNorm: string;
    opId: string;
    approvedKey: string;
    wroteProfile: boolean;
    wroteAuthority: boolean;
  },
): Promise<void> {
  if (input.wroteAuthority) {
    await store.removeAuthorityIfOwned(input.driverId, input.opId);
  }
  if (input.wroteProfile) {
    await store.removeProfileIfOwned(input.driverId, input.opId);
  }
  await store.compensateIdentity({
    driverId: input.driverId,
    nameNorm: input.nameNorm,
    opId: input.opId,
  });
}

export async function runApprovedRowConversion(
  store: ConversionStore,
  input: ConversionInput,
): Promise<ConversionResult> {
  const writes = emptyWrites();
  const link = decideCreateSecureLoginLink({
    driverId: input.driverId,
    approvedKey: input.approvedKey,
    legacyHash: input.legacyHash,
  });
  if (link.action === 'refuse') {
    return refuse(link.reason as ConversionRefusal, writes);
  }
  if (link.action !== 'create_from_approved') {
    return refuse('legacy_link_required', writes);
  }
  const approvedKey = link.approvedKey;
  const row = await store.readApproved(approvedKey);
  if (!row) {
    return refuse('approved_row_missing', writes);
  }
  const rowCheck = evaluateApprovedRowForCreate({
    requestDisplayName: input.displayName,
    row,
  });
  if (!rowCheck.ok && rowCheck.reason !== 'approved_row_already_linked') {
    return refuse(rowCheck.reason as ConversionRefusal, writes);
  }

  const nameNorm = normalizeDisplayName(input.displayName);
  const companyId =
    (typeof input.companyId === 'string' && input.companyId.trim()
      ? input.companyId.trim().toLowerCase()
      : typeof row.companyId === 'string' ? String(row.companyId).trim().toLowerCase() : null) || null;

  // Read the journal WITHOUT claiming so an already-linked foreign row
  // refuses with zero writes. Resume only when the durable UUID matches.
  const attemptId = attemptKeyId({ kind: 'legacy', legacyHash: approvedKey });
  const existingJournal = await store.journal.read(attemptId);
  const linkedId =
    typeof row.migratedToDriverId === 'string' ? row.migratedToDriverId.trim() : '';
  if (linkedId) {
    const ours = !!(
      existingJournal
      && existingJournal.driverId === linkedId
      && existingJournal.nameNorm === nameNorm
    );
    if (!ours) {
      return refuse('approved_row_already_linked', writes);
    }
  }

  const resolved = await resolveProvisioningUuid(
    store.journal,
    { kind: 'legacy', legacyHash: approvedKey },
    {
      requestedDriverId: null,
      nameNorm,
      companyId,
      isReset: false,
    },
  );
  if (resolved.decision.action === 'refuse' || !resolved.driverId) {
    return refuse('provisioning_refused', writes);
  }
  const driverId = resolved.driverId;
  const copiedRoutes = copyAssignedRoutes(row);
  const copiedWells = copyAssignedWells(row);

  if (resolved.decision.action === 'already_completed') {
    writes.journalCompleted = true;
    return {
      status: 'ok',
      reason: 'already_completed',
      driverId,
      writes,
      copiedRoutes,
      copiedWells,
    };
  }

  const live = await store.inspect(driverId, nameNorm, approvedKey);

  // Resume skips artifacts that already exist for this journal UUID so a
  // retry never overwrites a newer concurrent credential/profile/link.
  let wroteIdentity = live.credentialOpId != null && live.indexDriverId === driverId;
  let wroteProfile = live.profileOpId != null;
  let wroteAuthority = live.authorityOpId != null;
  let wroteLink = live.legacyLinkedDriverId === driverId;

  try {
    if (!wroteIdentity) {
      await store.writeIdentity({
        driverId,
        nameNorm,
        displayName: input.displayName,
        passcodeRecord: input.passcodeRecord,
        opId: input.opId,
        temporary: input.temporary,
        callerUid: input.callerUid,
      });
      wroteIdentity = true;
      writes.credential = true;
      writes.nameIndex = true;
    }
    if (input.failAfter === 'identity') throw new Error('injected: after identity');

    if (!wroteProfile) {
      const profile = buildCanonicalProfile({
        row,
        displayName: input.displayName,
        legalName: input.legalName,
        companyId: input.companyId,
        companyName: input.companyName,
        callerUid: input.callerUid,
        opId: input.opId,
      });
      await store.writeProfile(driverId, profile);
      wroteProfile = true;
      writes.profile = true;
    }
    if (input.failAfter === 'profile') throw new Error('injected: after profile');

    if (!wroteAuthority) {
      const auth = await store.ensureAuthority({
        driverId,
        companyId,
        opId: input.opId,
      });
      if (auth.action === 'refuse') {
        throw new Error('injected_or_live: authority refuse');
      }
      wroteAuthority = auth.wrote || auth.action === 'noop' || auth.action === 'create'
        || auth.action === 'initialize_uninitialized';
      writes.authority = auth.wrote;
      const outcome = decideProvisioningOutcome({
        identityWritten: true,
        profileWritten: true,
        authorityAction: auth.action as never,
        companyId,
      });
      if (!outcome.ok) throw new Error(`authority_outcome:${outcome.reason}`);
    }
    if (input.failAfter === 'authority') throw new Error('injected: after authority');

    // Link LAST — never stamp the approved row until identity, profile,
    // and authority are established.
    if (input.failAfter === 'during_legacy_link') {
      throw new Error('injected: during legacy_link');
    }
    if (!wroteLink) {
      const stamped = await store.stampLegacyLink({
        approvedKey,
        driverId,
        opId: input.opId,
      });
      if (stamped === 'foreign_link') {
        throw new Error('legacy_link_foreign');
      }
      wroteLink = true;
      writes.legacyLink = stamped === 'stamped';
    }
    if (input.failAfter === 'legacy_link') throw new Error('injected: after legacy_link');

    if (input.failAfter === 'journal_complete') {
      throw new Error('injected: before journal_complete');
    }
    await store.journal.markCompleted(attemptId);
    writes.journalCompleted = true;

    return {
      status: 'ok',
      reason: 'converted',
      driverId,
      writes,
      copiedRoutes,
      copiedWells,
    };
  } catch (err) {
    let liveAfter: Awaited<ReturnType<ConversionStore['inspect']>> | null = null;
    try {
      liveAfter = await store.inspect(driverId, nameNorm, approvedKey);
    } catch {
      liveAfter = null;
    }
    const linkProven = wroteLink || liveAfter?.legacyLinkedDriverId === driverId;
    if (linkProven || liveAfter === null) {
      // Link is committed, or we cannot prove a safe rollback. Keep the
      // journal UUID so the same approvedKey resumes rather than minting.
      return {
        status: 'resumable',
        reason: liveAfter === null && !wroteLink
          ? 'compensation_unproven'
          : ((err as Error).message || 'conversion_incomplete_linked'),
        driverId,
        writes,
        copiedRoutes,
        copiedWells,
      };
    }
    await compensatePreLink(store, {
      driverId,
      nameNorm,
      opId: input.opId,
      approvedKey,
      wroteProfile,
      wroteAuthority,
    });
    return {
      status: 'rolled_back',
      reason: (err as Error).message || 'conversion_failed',
      driverId,
      writes,
      copiedRoutes,
      copiedWells,
    };
  }
}

/** In-memory store for isolated deterministic tests. */
export function createMemoryConversionStore(): ConversionStore & {
  approved: Map<string, Record<string, unknown>>;
  credentials: Map<string, Record<string, unknown>>;
  index: Map<string, { driverId: string }>;
  profiles: Map<string, Record<string, unknown>>;
  authority: Map<string, Record<string, unknown>>;
  journalMap: Map<string, {
    attemptId: string;
    driverId: string;
    nameNorm: string;
    companyId: string | null;
    completed: boolean;
  }>;
  uuidSeq: number;
} {
  const approved = new Map<string, Record<string, unknown>>();
  const credentials = new Map<string, Record<string, unknown>>();
  const index = new Map<string, { driverId: string }>();
  const profiles = new Map<string, Record<string, unknown>>();
  const authority = new Map<string, Record<string, unknown>>();
  const journalMap = new Map<string, {
    attemptId: string;
    driverId: string;
    nameNorm: string;
    companyId: string | null;
    completed: boolean;
  }>();
  const box = {
    approved,
    credentials,
    index,
    profiles,
    authority,
    journalMap,
    uuidSeq: 0,
    journal: {
      read: async (id: string) => journalMap.get(id) ?? null,
      claim: async (id: string, candidate: {
        attemptId: string;
        driverId: string;
        nameNorm: string;
        companyId: string | null;
        completed: boolean;
      }) => {
        const existing = journalMap.get(id);
        if (existing) return existing;
        journalMap.set(id, { ...candidate });
        return journalMap.get(id)!;
      },
      markCompleted: async (id: string) => {
        const e = journalMap.get(id);
        if (e) journalMap.set(id, { ...e, completed: true });
      },
      newUuid: () => {
        box.uuidSeq += 1;
        return `aaaaaaaa-bbbb-4ccc-8ddd-${String(box.uuidSeq).padStart(12, '0')}`;
      },
    },
    async readApproved(key: string) {
      return approved.get(key) ?? null;
    },
    async stampLegacyLink(input: { approvedKey: string; driverId: string; opId: string }) {
      const row = approved.get(input.approvedKey);
      if (!row) return 'foreign_link';
      const existing = typeof row.migratedToDriverId === 'string' ? row.migratedToDriverId : '';
      if (existing && existing !== input.driverId) return 'foreign_link';
      if (existing === input.driverId && row.linkOpId && row.linkOpId !== input.opId) {
        return 'already_ours';
      }
      approved.set(input.approvedKey, {
        ...row,
        migratedToDriverId: input.driverId,
        secureProfileLinked: true,
        linkOpId: input.opId,
      });
      return existing === input.driverId ? 'already_ours' : 'stamped';
    },
    async unstampLegacyLinkIfOwned(input: { approvedKey: string; driverId: string; opId: string }) {
      const row = approved.get(input.approvedKey);
      if (!row) return 'missing';
      if (row.linkOpId !== input.opId || row.migratedToDriverId !== input.driverId) {
        return 'left_intact';
      }
      const next = { ...row };
      delete next.migratedToDriverId;
      delete next.secureProfileLinked;
      delete next.linkOpId;
      approved.set(input.approvedKey, next);
      return 'removed';
    },
    async writeIdentity(input: {
      driverId: string;
      nameNorm: string;
      displayName: string;
      passcodeRecord: PasscodeRecord;
      opId: string;
      temporary: boolean;
      callerUid: string;
    }) {
      const idx = index.get(input.nameNorm);
      const existingDriverId = readIndexOwner(!!idx, idx);
      let incumbentCredential = readIncumbentCredential(false, undefined);
      if (
        existingDriverId
        && existingDriverId !== 'malformed'
        && existingDriverId !== input.driverId
      ) {
        const other = credentials.get(existingDriverId);
        incumbentCredential = readIncumbentCredential(!!other, other);
      }
      const claim = decideNameIndexClaim({
        existingDriverId,
        targetDriverId: input.driverId,
        incumbentCredential,
      });
      if (!claim.allow) {
        throw new Error(`index_claim:${claim.reason}`);
      }
      const existingCred = credentials.get(input.driverId);
      if (
        existingCred
        && typeof existingCred.opId === 'string'
        && existingCred.opId !== input.opId
      ) {
        throw new Error('credential_foreign');
      }
      index.set(input.nameNorm, { driverId: input.driverId });
      credentials.set(input.driverId, {
        displayNameNorm: input.nameNorm,
        displayName: input.displayName,
        passcode: input.passcodeRecord,
        active: true,
        opId: input.opId,
        setBy: input.callerUid,
        mustResetPasscode: input.temporary,
      });
    },
    async compensateIdentity(input: { driverId: string; nameNorm: string; opId: string }) {
      const cred = credentials.get(input.driverId);
      const idx = index.get(input.nameNorm);
      const d = decideCompensation({
        credentialExists: !!cred,
        credentialOpId: cred?.opId,
        myOpId: input.opId,
        indexExists: !!idx,
        indexDriverId: idx?.driverId,
        myDriverId: input.driverId,
      });
      if (d.deleteCredential) credentials.delete(input.driverId);
      if (d.releaseIndex) index.delete(input.nameNorm);
      return {
        deletedCredential: d.deleteCredential,
        releasedIndex: d.releaseIndex,
        superseded: d.superseded,
      };
    },
    async writeProfile(driverId: string, profile: Record<string, unknown>) {
      const existing = profiles.get(driverId);
      if (
        existing
        && typeof existing.provisioningOpId === 'string'
        && existing.provisioningOpId !== profile.provisioningOpId
      ) {
        return;
      }
      profiles.set(driverId, { ...profile });
    },
    async removeProfileIfOwned(driverId: string, opId: string) {
      const p = profiles.get(driverId);
      if (!p) return 'missing';
      if (p.provisioningOpId !== opId) return 'left_intact';
      profiles.delete(driverId);
      return 'removed';
    },
    async ensureAuthority(input: { driverId: string; companyId: string | null; opId: string }) {
      const existing = authority.get(input.driverId) as never;
      const d = decideEnsureEmptyAuthority({
        driverId: input.driverId,
        companyId: input.companyId,
        existing: existing ?? null,
      });
      if (d.action === 'create') {
        authority.set(input.driverId, { ...d.record, provisioningOpId: input.opId });
        return { action: 'create', wrote: true };
      }
      return { action: d.action, wrote: false };
    },
    async removeAuthorityIfOwned(driverId: string, opId: string) {
      const a = authority.get(driverId);
      if (!a) return 'missing';
      if (a.provisioningOpId !== opId) return 'left_intact';
      authority.delete(driverId);
      return 'removed';
    },
    async inspect(driverId: string, nameNorm: string, approvedKey: string) {
      const cred = credentials.get(driverId);
      const idx = index.get(nameNorm);
      const prof = profiles.get(driverId);
      const auth = authority.get(driverId);
      const row = approved.get(approvedKey);
      return {
        credentialOpId: typeof cred?.opId === 'string' ? cred.opId : null,
        indexDriverId: idx?.driverId ?? null,
        profileOpId: typeof prof?.provisioningOpId === 'string' ? String(prof.provisioningOpId) : null,
        authorityOpId: typeof auth?.provisioningOpId === 'string' ? String(auth.provisioningOpId) : null,
        legacyLinkedDriverId: typeof row?.migratedToDriverId === 'string' ? String(row.migratedToDriverId) : null,
        legacyLinkOpId: typeof row?.linkOpId === 'string' ? String(row.linkOpId) : null,
      };
    },
  };
  return box;
}

/** Test-only scrypt-shaped record. Not a production credential. */
export const TEST_PASSCODE_RECORD: PasscodeRecord = {
  algo: 'scrypt',
  saltB64: 'dGVzdHNhbHQ=',
  hashB64: 'dGVzdGhhc2g=',
  N: 2,
  r: 1,
  p: 1,
  keyLen: 8,
};
