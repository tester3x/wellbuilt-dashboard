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
  | 'journal_complete'
  | 'inspect';

export type ConversionStatus =
  | 'ok'
  | 'refused'
  | 'rolled_back'
  | 'linked_resumable'
  | 'unproven';

export type ConversionRefusal =
  | 'legacy_link_required'
  | 'approved_key_malformed'
  | 'ambiguous_link_selector'
  | 'approved_row_missing'
  | 'approved_row_name_mismatch'
  | 'approved_row_already_linked'
  | 'approved_row_inactive'
  | 'approved_row_malformed'
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
  terminalProven: boolean;
}

export function clientOutcomeFor(result: ConversionResult): {
  success: boolean;
  code: 'ok' | 'failed-precondition' | 'not-found' | 'invalid-argument' | 'internal';
  reason: string;
} {
  if (result.status === 'ok' && result.terminalProven) {
    return { success: true, code: 'ok', reason: result.reason };
  }
  if (result.status === 'refused') {
    if (result.reason === 'approved_row_missing') {
      return { success: false, code: 'not-found', reason: result.reason };
    }
    if (result.reason === 'approved_key_malformed') {
      return { success: false, code: 'invalid-argument', reason: result.reason };
    }
    return { success: false, code: 'failed-precondition', reason: result.reason };
  }
  if (result.status === 'rolled_back') {
    return { success: false, code: 'internal', reason: 'approved_conversion_rolled_back' };
  }
  if (result.status === 'linked_resumable') {
    return { success: false, code: 'failed-precondition', reason: 'linked_resumable' };
  }
  return { success: false, code: 'failed-precondition', reason: result.reason || 'compensation_unproven' };
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
export function copyExactField(row: Record<string, unknown>, key: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(row, key)) return null;
  if (row[key] === undefined) return null;
  return row[key];
}

export function copyAssignedWells(row: Record<string, unknown>): unknown {
  return copyExactField(row, 'assignedWells');
}

export function copyAssignedRoutes(row: Record<string, unknown>): unknown {
  return copyExactField(row, 'assignedRoutes');
}

export const PROFILE_PROOF_KEYS = [
  'displayName',
  'name',
  'legalName',
  'active',
  'isAdmin',
  'isViewer',
  'companyId',
  'companyName',
  'assignedCustomers',
  'assignedRoutes',
  'assignedWells',
  'roles',
  'approvedAt',
  'schemaVersion',
  'mustUseSecureAuth',
] as const;

export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Canonical profile is owned by the approved row. Client metadata is never
 * applied: legalName, company, routes, wells, roles, flags, and approvedAt
 * come from the exact RTDB row.
 */
export function buildCanonicalProfile(input: {
  row: Record<string, unknown>;
  displayName: string;
  callerUid: string;
  opId: string;
}): Record<string, unknown> {
  const L = input.row;
  return {
    displayName: input.displayName,
    name: copyExactField(L, 'name'),
    legalName: copyExactField(L, 'legalName'),
    active: copyExactField(L, 'active'),
    isAdmin: copyExactField(L, 'isAdmin'),
    isViewer: copyExactField(L, 'isViewer'),
    companyId: copyExactField(L, 'companyId'),
    companyName: copyExactField(L, 'companyName'),
    assignedCustomers: copyExactField(L, 'assignedCustomers'),
    assignedRoutes: copyAssignedRoutes(L),
    assignedWells: copyAssignedWells(L),
    roles: copyExactField(L, 'roles'),
    approvedAt: copyExactField(L, 'approvedAt'),
    approvedBy: input.callerUid,
    schemaVersion: 1,
    mustUseSecureAuth: true,
    provisioningOpId: input.opId,
  };
}

/** Shape-only. Never compares or returns the hash material. */
export function isServerScryptRecord(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const rec = raw as Record<string, unknown>;
  return rec.algo === 'scrypt'
    && typeof rec.saltB64 === 'string' && rec.saltB64.length > 0
    && typeof rec.hashB64 === 'string' && rec.hashB64.length > 0
    && Number.isInteger(rec.N)
    && Number.isInteger(rec.r)
    && Number.isInteger(rec.p)
    && Number.isInteger(rec.keyLen);
}

function normCompany(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().toLowerCase();
  return t || null;
}

export function decideProfileWrite(input: {
  existing: Record<string, unknown> | null | undefined;
  incoming: Record<string, unknown>;
}): 'write' | 'already_exact' | 'foreign' {
  const existing = input.existing;
  if (!existing || typeof existing !== 'object') return 'write';
  const existingOp = existing.provisioningOpId;
  const nextOp = input.incoming.provisioningOpId;
  const identityMatch = PROFILE_PROOF_KEYS.every((key) => sameJson(existing[key], input.incoming[key]));
  if (existingOp === nextOp && identityMatch) return 'already_exact';
  if (identityMatch) return 'already_exact';
  return 'foreign';
}

export function decideAuthorityDelete(input: {
  existing: Record<string, unknown> | null | undefined;
  myOpId: string;
  myDriverId: string;
  expectedCompanyId?: string | null;
}): 'removed' | 'left_intact' | 'missing' {
  const existing = input.existing;
  if (!existing || typeof existing !== 'object') return 'missing';
  if (existing.provisioningOpId !== input.myOpId) return 'left_intact';
  if (existing.driverId !== input.myDriverId) return 'left_intact';
  if (input.expectedCompanyId && existing.companyId !== input.expectedCompanyId) {
    return 'left_intact';
  }
  if (existing.openPeriodId != null && existing.openPeriodId !== undefined) {
    return 'left_intact';
  }
  if (existing.initialized !== true) return 'left_intact';
  return 'removed';
}

export interface ConversionInspect {
  credentialOpId: string | null;
  credentialDisplayNameNorm: string | null;
  credentialActive: boolean | null;
  credentialScryptValid: boolean;
  indexDriverId: string | null;
  profile: Record<string, unknown> | null;
  profileOpId: string | null;
  authority: Record<string, unknown> | null;
  authorityOpId: string | null;
  authorityOpenPeriodId: string | null;
  legacyLinkedDriverId: string | null;
  legacyLinkOpId: string | null;
  approvedDisplayName: string | null;
  approvedSecureProfileLinked: boolean | null;
  journalCompleted: boolean | null;
}

export function decideProfileFieldProof(
  profile: Record<string, unknown> | null,
  expected: Record<string, unknown>,
): { ok: true } | { ok: false; reason: string } {
  if (!profile) return { ok: false, reason: 'profile_missing' };
  for (const key of PROFILE_PROOF_KEYS) {
    if (!sameJson(profile[key], expected[key])) {
      return { ok: false, reason: `profile_${key}_mismatch` };
    }
  }
  return { ok: true };
}

export function decidePrerequisiteProof(input: {
  driverId: string;
  nameNorm: string;
  companyId: string | null;
  expectedProfile: Record<string, unknown>;
  live: ConversionInspect;
}): { ok: true } | { ok: false; reason: string } {
  const { live, driverId, nameNorm, companyId } = input;
  if (live.indexDriverId !== driverId) {
    return { ok: false, reason: 'index_mismatch' };
  }
  if (!live.credentialOpId) {
    return { ok: false, reason: 'credential_missing' };
  }
  if (live.credentialDisplayNameNorm !== nameNorm) {
    return { ok: false, reason: 'credential_name_mismatch' };
  }
  if (live.credentialActive !== true) {
    return {
      ok: false,
      reason: live.credentialActive === false ? 'credential_inactive' : 'credential_malformed',
    };
  }
  if (live.credentialScryptValid !== true) {
    return { ok: false, reason: 'credential_scrypt_invalid' };
  }
  const fields = decideProfileFieldProof(live.profile, input.expectedProfile);
  if (!fields.ok) return fields;
  if (companyId) {
    const auth = live.authority;
    if (!auth) return { ok: false, reason: 'authority_missing' };
    if (auth.driverId !== driverId) return { ok: false, reason: 'authority_driver_mismatch' };
    if (normCompany(auth.companyId) !== normCompany(companyId)) {
      return { ok: false, reason: 'authority_company_mismatch' };
    }
    if (auth.initialized !== true) return { ok: false, reason: 'authority_uninitialized' };
    if (auth.openPeriodId != null && auth.openPeriodId !== undefined) {
      return { ok: false, reason: 'authority_open' };
    }
  }
  return { ok: true };
}

export function decideTerminalProof(input: {
  driverId: string;
  nameNorm: string;
  displayName: string;
  companyId: string | null;
  expectedProfile: Record<string, unknown>;
  live: ConversionInspect;
}): { ok: true } | { ok: false; reason: string } {
  const pre = decidePrerequisiteProof(input);
  if (!pre.ok) return pre;
  if (input.live.legacyLinkedDriverId !== input.driverId) {
    return { ok: false, reason: 'legacy_link_missing' };
  }
  if (input.live.approvedSecureProfileLinked !== true) {
    return { ok: false, reason: 'legacy_link_unmarked' };
  }
  if (input.live.approvedDisplayName !== input.displayName) {
    return { ok: false, reason: 'legacy_name_mismatch' };
  }
  if (input.live.journalCompleted !== true) {
    return { ok: false, reason: 'journal_incomplete' };
  }
  return { ok: true };
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
  writeProfile(driverId: string, profile: Record<string, unknown>): Promise<'written' | 'already_exact' | 'foreign'>;
  removeProfileIfOwned(driverId: string, opId: string): Promise<'removed' | 'left_intact' | 'missing'>;
  ensureAuthority(input: {
    driverId: string;
    companyId: string | null;
    opId: string;
  }): Promise<{ action: string; wrote: boolean }>;
  removeAuthorityIfOwned(driverId: string, opId: string, expectedCompanyId?: string | null): Promise<'removed' | 'left_intact' | 'missing'>;
  inspect(driverId: string, nameNorm: string, approvedKey: string): Promise<ConversionInspect>;
}

function refuse(reason: ConversionRefusal, writes: ConversionWriteLog): ConversionResult {
  return {
    status: 'refused',
    reason,
    driverId: null,
    writes,
    copiedRoutes: null,
    copiedWells: null,
    terminalProven: false,
  };
}

function result(
  status: ConversionStatus,
  reason: string,
  driverId: string | null,
  writes: ConversionWriteLog,
  copiedRoutes: unknown,
  copiedWells: unknown,
  terminalProven: boolean,
): ConversionResult {
  return { status, reason, driverId, writes, copiedRoutes, copiedWells, terminalProven };
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
    expectedCompanyId?: string | null;
  },
): Promise<void> {
  if (input.wroteAuthority) {
    await store.removeAuthorityIfOwned(input.driverId, input.opId, input.expectedCompanyId);
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
    (typeof row.companyId === 'string' && row.companyId.trim()
      ? row.companyId.trim().toLowerCase()
      : null);

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

  const expectedProfile = buildCanonicalProfile({
    row,
    displayName: input.displayName,
    callerUid: input.callerUid,
    opId: input.opId,
  });
  const proofInput = (live: ConversionInspect) => ({
    driverId,
    nameNorm,
    displayName: input.displayName,
    companyId,
    expectedProfile,
    live,
  });

  const inspectLive = async (honorInspectFail: boolean): Promise<ConversionInspect | null> => {
    if (honorInspectFail && input.failAfter === 'inspect') return null;
    try {
      return await store.inspect(driverId, nameNorm, approvedKey);
    } catch {
      return null;
    }
  };

  if (resolved.decision.action === 'already_completed') {
    const liveDone = await inspectLive(true);
    if (!liveDone) {
      return result('unproven', 'compensation_unproven', driverId, writes, copiedRoutes, copiedWells, false);
    }
    const terminal = decideTerminalProof(proofInput(liveDone));
    if (terminal.ok) {
      writes.journalCompleted = true;
      return result('ok', 'already_completed', driverId, writes, copiedRoutes, copiedWells, true);
    }
    return result(
      liveDone.legacyLinkedDriverId === driverId ? 'linked_resumable' : 'unproven',
      terminal.reason,
      driverId,
      writes,
      copiedRoutes,
      copiedWells,
      false,
    );
  }

  const liveStart = await inspectLive(false);
  if (!liveStart) {
    return result('unproven', 'compensation_unproven', driverId, writes, copiedRoutes, copiedWells, false);
  }
  const live = liveStart;

  let wroteIdentity = live.credentialOpId != null && live.indexDriverId === driverId;
  const existingProfileDecision = decideProfileWrite({
    existing: live.profile,
    incoming: expectedProfile,
  });
  if (existingProfileDecision === 'foreign') {
    return result('refused', 'profile_foreign', driverId, writes, copiedRoutes, copiedWells, false);
  }
  let wroteProfile = existingProfileDecision === 'already_exact';
  let wroteAuthority = live.authorityOpId != null || (live.authority?.initialized === true);
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
      const wr = await store.writeProfile(driverId, expectedProfile);
      if (wr === 'foreign') throw new Error('profile_foreign');
      wroteProfile = wr === 'written' || wr === 'already_exact';
      writes.profile = wr === 'written';
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

    const preLive = await inspectLive(true);
    if (!preLive) {
      throw new Error('inspect_failed_before_link');
    }
    const prereq = decidePrerequisiteProof(proofInput(preLive));
    if (!prereq.ok) throw new Error(`prereq:${prereq.reason}`);

    // Link LAST — never stamp the approved row until identity, profile,
    // and authority are established and re-read.
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

    const termLive = await inspectLive(true);
    if (!termLive) {
      return result('unproven', 'compensation_unproven', driverId, writes, copiedRoutes, copiedWells, false);
    }
    const terminal = decideTerminalProof(proofInput(termLive));
    if (!terminal.ok) {
      return result(
        termLive.legacyLinkedDriverId === driverId ? 'linked_resumable' : 'unproven',
        terminal.reason,
        driverId,
        writes,
        copiedRoutes,
        copiedWells,
        false,
      );
    }
    return result('ok', 'converted', driverId, writes, copiedRoutes, copiedWells, true);
  } catch (err) {
    const liveAfter = await inspectLive(true);
    if (!liveAfter) {
      return result(
        'unproven',
        'compensation_unproven',
        driverId,
        writes,
        copiedRoutes,
        copiedWells,
        false,
      );
    }
    const terminal = decideTerminalProof(proofInput(liveAfter));
    if (terminal.ok || liveAfter.legacyLinkedDriverId === driverId) {
      return result(
        'linked_resumable',
        terminal.ok ? ((err as Error).message || 'conversion_incomplete_linked') : terminal.reason,
        driverId,
        writes,
        copiedRoutes,
        copiedWells,
        false,
      );
    }
    await compensatePreLink(store, {
      driverId,
      nameNorm,
      opId: input.opId,
      approvedKey,
      wroteProfile,
      wroteAuthority,
      expectedCompanyId: companyId,
    });
    return result(
      'rolled_back',
      (err as Error).message || 'conversion_failed',
      driverId,
      writes,
      copiedRoutes,
      copiedWells,
      false,
    );
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
      const existing = profiles.get(driverId) ?? null;
      const decision = decideProfileWrite({ existing, incoming: profile });
      if (decision === 'foreign') return 'foreign';
      if (decision === 'already_exact') return 'already_exact';
      profiles.set(driverId, { ...profile });
      return 'written';
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
    async removeAuthorityIfOwned(driverId: string, opId: string, expectedCompanyId?: string | null) {
      const a = authority.get(driverId);
      const d = decideAuthorityDelete({
        existing: a ?? null,
        myOpId: opId,
        myDriverId: driverId,
        expectedCompanyId,
      });
      if (d === 'removed') authority.delete(driverId);
      return d;
    },
    async inspect(driverId: string, nameNorm: string, approvedKey: string) {
      const cred = credentials.get(driverId);
      const idx = index.get(nameNorm);
      const prof = profiles.get(driverId) ?? null;
      const auth = authority.get(driverId) ?? null;
      const row = approved.get(approvedKey) ?? null;
      const journal = journalMap.get(`legacy:${approvedKey}`);
      return {
        credentialOpId: typeof cred?.opId === 'string' ? cred.opId : null,
        credentialDisplayNameNorm: typeof cred?.displayNameNorm === 'string' ? cred.displayNameNorm : null,
        credentialActive: typeof cred?.active === 'boolean' ? cred.active : null,
        credentialScryptValid: isServerScryptRecord(cred?.passcode),
        indexDriverId: idx?.driverId ?? null,
        profile: prof,
        profileOpId: typeof prof?.provisioningOpId === 'string' ? String(prof.provisioningOpId) : null,
        authority: auth,
        authorityOpId: typeof auth?.provisioningOpId === 'string' ? String(auth.provisioningOpId) : null,
        authorityOpenPeriodId: typeof auth?.openPeriodId === 'string' ? String(auth.openPeriodId) : null,
        legacyLinkedDriverId: typeof row?.migratedToDriverId === 'string' ? String(row.migratedToDriverId) : null,
        legacyLinkOpId: typeof row?.linkOpId === 'string' ? String(row.linkOpId) : null,
        approvedDisplayName: typeof row?.displayName === 'string' ? String(row.displayName) : null,
        approvedSecureProfileLinked: row?.secureProfileLinked === true,
        journalCompleted: journal ? journal.completed === true : null,
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
