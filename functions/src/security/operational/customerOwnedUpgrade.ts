/**
 * Customer-owned secure upgrade.
 *
 * The customer proves the existing legacy login and supplies a new password
 * from their own device. The administrator never types, sees, receives, or
 * logs it. Legacy login stays available until a separate audited retirement.
 *
 * ORDER:
 *   1. validate (zero writes on refuse)
 *   2. journal UUID claim (durable; retries reuse)
 *   3. identity (credential + name index) — skipped when already established
 *   4. canonical profile hydration (copy missing; report conflicts)
 *   5. empty initialized shift authority
 *   6. server-controlled 1:1 binding LAST
 *   7. mark journal completed
 *
 * Compensation deletes only artifacts whose ownership marker equals this
 * invocation's opId, and only before the binding is committed.
 */
import {
  attemptKeyId,
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
import {
  decideBindIdentity,
  decideBindingTerminalProof,
  parseBinding,
  type IdentityBinding,
} from './identityBinding';
import {
  applyHydrationCopy,
  previewCanonicalHydration,
  profileContainsForbiddenLegacyKey,
  type HydrationPreview,
  type OperationalField,
} from './canonicalProfileHydration';
import { evaluateHydrationTransaction } from './hydrationApplyTransaction';
import {
  decideAuthorityDelete,
  isServerScryptRecord,
  type PasscodeRecord,
} from './approvedRowConversion';

export type UpgradeFailAfter =
  | 'identity'
  | 'profile'
  | 'authority'
  | 'binding'
  | 'after_binding_byDriver'
  | 'journal_complete'
  | 'inspect';

export type UpgradeStatus =
  | 'ok'
  | 'refused'
  | 'rolled_back'
  | 'bound_resumable'
  | 'unproven';

export interface UpgradeInput {
  provenApprovedKey: string;
  displayName: string;
  passcodeRecord?: PasscodeRecord;
  callerUid: string;
  opId: string;
  failAfter?: UpgradeFailAfter;
  /** When set, bind this existing UUID (staff hydration of already-canonical). */
  existingDriverId?: string | null;
  /** Staff hydration does not create or replace credentials. */
  skipCredentialWrite?: boolean;
  expectedPreviewDigest?: string;
}

export interface UpgradeResult {
  status: UpgradeStatus;
  reason: string;
  driverId: string | null;
  writes: {
    credential: boolean;
    nameIndex: boolean;
    profile: boolean;
    authority: boolean;
    binding: boolean;
    journalCompleted: boolean;
  };
  preview: HydrationPreview | null;
  terminalProven: boolean;
}

export function emptyUpgradeWrites(): UpgradeResult['writes'] {
  return {
    credential: false,
    nameIndex: false,
    profile: false,
    authority: false,
    binding: false,
    journalCompleted: false,
  };
}

export interface UpgradeInspect {
  credentialOpId: string | null;
  credentialActive: boolean | null;
  credentialScryptValid: boolean;
  indexDriverId: string | null;
  profile: Record<string, unknown> | null;
  binding: IdentityBinding | null;
  bindingByDriver: IdentityBinding | null;
  bindingByApproved: IdentityBinding | null;
  journalCompleted: boolean | null;
}

export interface UpgradeStore {
  journal: ProvisioningJournalDeps;
  readApproved(key: string): Promise<Record<string, unknown> | null>;
  readProfile(driverId: string): Promise<Record<string, unknown> | null>;
  readBindingByDriver(driverId: string): Promise<IdentityBinding | null>;
  readBindingByApproved(approvedKey: string): Promise<IdentityBinding | null>;
  writeBinding(binding: IdentityBinding, opts?: { failAfter?: 'byDriver' }): Promise<'written' | 'repaired' | 'already_exact' | 'foreign'>;
  commitProfileHydration(input: {
    driverId: string;
    approvedKey: string;
    expectedDigest: string;
    legacyRow: Record<string, unknown>;
    copy: Partial<Record<OperationalField, unknown>>;
    preview: Pick<HydrationPreview, 'copy' | 'preserved' | 'conflicts'>;
    opId: string;
  }): Promise<'written' | 'already_exact' | 'stale_preview' | 'foreign'>;
  removeBindingIfOwned(input: {
    driverId: string;
    approvedKey: string;
    opId: string;
  }): Promise<'removed' | 'left_intact' | 'missing'>;
  writeIdentity(input: {
    driverId: string;
    nameNorm: string;
    displayName: string;
    passcodeRecord: PasscodeRecord;
    opId: string;
    callerUid: string;
  }): Promise<void>;
  compensateIdentity(input: {
    driverId: string;
    nameNorm: string;
    opId: string;
  }): Promise<{ deletedCredential: boolean; releasedIndex: boolean; superseded: boolean }>;
  writeProfile(driverId: string, profile: Record<string, unknown>): Promise<'written' | 'already_exact' | 'foreign' | 'stale_preview'>;
  removeProfileIfOwned(driverId: string, opId: string): Promise<'removed' | 'left_intact' | 'missing'>;
  ensureAuthority(input: {
    driverId: string;
    companyId: string | null;
    opId: string;
  }): Promise<{ action: string; wrote: boolean }>;
  removeAuthorityIfOwned(
    driverId: string,
    opId: string,
    expectedCompanyId?: string | null,
  ): Promise<'removed' | 'left_intact' | 'missing'>;
  inspect(driverId: string, nameNorm: string, approvedKey: string): Promise<UpgradeInspect>;
  readNameIndex(nameNorm: string): Promise<string | null>;
  readCredentialActive(driverId: string): Promise<boolean>;
}

function refuse(reason: string, writes: UpgradeResult['writes']): UpgradeResult {
  return {
    status: 'refused',
    reason,
    driverId: null,
    writes,
    preview: null,
    terminalProven: false,
  };
}

async function compensatePreBind(
  store: UpgradeStore,
  input: {
    driverId: string;
    nameNorm: string;
    opId: string;
    wroteProfile: boolean;
    wroteAuthority: boolean;
    skipCredentialWrite: boolean;
    expectedCompanyId?: string | null;
  },
): Promise<void> {
  if (input.wroteAuthority) {
    await store.removeAuthorityIfOwned(input.driverId, input.opId, input.expectedCompanyId);
  }
  if (input.wroteProfile) {
    await store.removeProfileIfOwned(input.driverId, input.opId);
  }
  if (!input.skipCredentialWrite) {
    await store.compensateIdentity({
      driverId: input.driverId,
      nameNorm: input.nameNorm,
      opId: input.opId,
    });
  }
}

export function decideTerminalUpgradeProof(input: {
  driverId: string;
  approvedKey: string;
  live: UpgradeInspect;
}): { ok: true } | { ok: false; reason: string } {
  if (input.live.indexDriverId !== input.driverId) {
    return { ok: false, reason: 'index_mismatch' };
  }
  if (!input.live.profile) return { ok: false, reason: 'profile_missing' };
  if (profileContainsForbiddenLegacyKey(input.live.profile)) {
    return { ok: false, reason: 'profile_leaks_legacy_key' };
  }
  const bound = decideBindingTerminalProof({
    driverId: input.driverId,
    approvedKey: input.approvedKey,
    byDriver: input.live.bindingByDriver,
    byApproved: input.live.bindingByApproved,
  });
  if (!bound.ok) return bound;
  if (input.live.journalCompleted !== true) {
    return { ok: false, reason: 'journal_incomplete' };
  }
  if (input.live.credentialActive !== true) {
    return { ok: false, reason: 'credential_inactive' };
  }
  if (input.live.credentialScryptValid !== true) {
    return { ok: false, reason: 'credential_scrypt_invalid' };
  }
  return { ok: true };
}

export async function runCustomerOwnedUpgrade(
  store: UpgradeStore,
  input: UpgradeInput,
): Promise<UpgradeResult> {
  const writes = emptyUpgradeWrites();
  const approvedKey = input.provenApprovedKey.trim();
  if (!approvedKey) return refuse('legacy_link_required', writes);

  const row = await store.readApproved(approvedKey);
  if (!row) return refuse('approved_row_missing', writes);
  if (row.active === false) return refuse('approved_row_inactive', writes);
  if (row.active !== true) return refuse('approved_row_malformed', writes);

  const nameNorm = normalizeDisplayName(input.displayName);
  const rowName = typeof row.displayName === 'string' ? row.displayName : '';
  if (normalizeDisplayName(rowName) !== nameNorm) {
    return refuse('approved_row_name_mismatch', writes);
  }

  const companyId =
    typeof row.companyId === 'string' && row.companyId.trim()
      ? row.companyId.trim().toLowerCase()
      : null;

  const existingByApproved = await store.readBindingByApproved(approvedKey);
  if (existingByApproved && existingByApproved.driverId && input.existingDriverId
    && existingByApproved.driverId !== input.existingDriverId) {
    return refuse('approved_key_already_bound', writes);
  }

  const indexOwner = await store.readNameIndex(nameNorm);
  const indexOwnerActive = indexOwner ? await store.readCredentialActive(indexOwner) : false;
  const establishedId = indexOwner && indexOwnerActive ? indexOwner : null;
  if (
    input.existingDriverId
    && establishedId
    && establishedId !== input.existingDriverId
  ) {
    return refuse('name_taken', writes);
  }

  const skipCredentialWrite = input.skipCredentialWrite === true || !!establishedId;

  const resolved = await resolveProvisioningUuid(
    store.journal,
    { kind: 'legacy', legacyHash: approvedKey },
    {
      requestedDriverId: input.existingDriverId || establishedId,
      nameNorm,
      companyId,
      isReset: skipCredentialWrite,
    },
  );
  if (resolved.decision.action === 'refuse' || !resolved.driverId) {
    return refuse('provisioning_refused', writes);
  }
  const driverId = resolved.driverId;

  const existingByDriver = await store.readBindingByDriver(driverId);
  const bindDecision = decideBindIdentity({
    driverId,
    approvedKey,
    opId: input.opId,
    existingByDriver,
    existingByApproved,
  });
  if (bindDecision.action === 'refuse') {
    return { ...refuse(bindDecision.reason, writes), driverId };
  }

  const existingProfile = await store.readProfile(driverId);
  const preview = previewCanonicalHydration(existingProfile, row, { driverId, approvedKey });
  if (input.expectedPreviewDigest && input.expectedPreviewDigest !== preview.digest) {
    return {
      status: 'refused',
      reason: 'stale_preview',
      driverId,
      writes,
      preview,
      terminalProven: false,
    };
  }
  const nextProfile = applyHydrationCopy(existingProfile, preview);
  nextProfile.provisioningOpId = existingProfile?.provisioningOpId || input.opId;
  if (typeof input.displayName === 'string' && !nextProfile.displayName) {
    nextProfile.displayName = input.displayName;
  }

  const inspectLive = async (honor: boolean): Promise<UpgradeInspect | null> => {
    if (honor && input.failAfter === 'inspect') return null;
    try {
      return await store.inspect(driverId, nameNorm, approvedKey);
    } catch {
      return null;
    }
  };

  const proof = (live: UpgradeInspect) =>
    decideTerminalUpgradeProof({ driverId, approvedKey, live });

  if (resolved.decision.action === 'already_completed') {
    const liveDone = await inspectLive(true);
    if (!liveDone) {
      return {
        status: 'unproven',
        reason: 'compensation_unproven',
        driverId,
        writes,
        preview,
        terminalProven: false,
      };
    }
    const terminal = proof(liveDone);
    if (terminal.ok) {
      writes.journalCompleted = true;
      writes.binding = true;
      return {
        status: 'ok',
        reason: 'already_completed',
        driverId,
        writes,
        preview,
        terminalProven: true,
      };
    }
    return {
      status: liveDone.binding?.driverId === driverId ? 'bound_resumable' : 'unproven',
      reason: terminal.reason,
      driverId,
      writes,
      preview,
      terminalProven: false,
    };
  }

  const liveStart = await inspectLive(false);
  if (!liveStart) {
    return {
      status: 'unproven',
      reason: 'compensation_unproven',
      driverId,
      writes,
      preview,
      terminalProven: false,
    };
  }

  let wroteIdentity = liveStart.credentialOpId != null && liveStart.indexDriverId === driverId;
  let wroteProfile = !!liveStart.profile;
  let wroteAuthority = false;
  const startBound = decideBindingTerminalProof({
    driverId,
    approvedKey,
    byDriver: liveStart.bindingByDriver,
    byApproved: liveStart.bindingByApproved,
  });
  let wroteBinding = startBound.ok;

  try {
    if (!skipCredentialWrite && !wroteIdentity) {
      if (!input.passcodeRecord) throw new Error('passcode_record_required');
      await store.writeIdentity({
        driverId,
        nameNorm,
        displayName: input.displayName,
        passcodeRecord: input.passcodeRecord,
        opId: input.opId,
        callerUid: input.callerUid,
      });
      wroteIdentity = true;
      writes.credential = true;
      writes.nameIndex = true;
    }
    if (input.failAfter === 'identity') throw new Error('injected: after identity');

    const wr = input.expectedPreviewDigest
      ? await store.commitProfileHydration({
          driverId,
          approvedKey,
          expectedDigest: input.expectedPreviewDigest,
          legacyRow: row,
          copy: preview.copy,
          preview,
          opId: input.opId,
        })
      : await store.writeProfile(driverId, nextProfile);
    if (wr === 'stale_preview') {
      return {
        status: 'refused',
        reason: 'stale_preview',
        driverId,
        writes,
        preview,
        terminalProven: false,
      };
    }
    if (wr === 'foreign') throw new Error('profile_foreign');
    writes.profile = wr === 'written';
    wroteProfile = wr === 'written' || wr === 'already_exact' || wroteProfile;
    if (input.failAfter === 'profile') throw new Error('injected: after profile');

    const auth = await store.ensureAuthority({
      driverId,
      companyId,
      opId: input.opId,
    });
    if (auth.action === 'refuse') throw new Error('authority_refuse');
    wroteAuthority = auth.wrote;
    writes.authority = auth.wrote;
    if (input.failAfter === 'authority') throw new Error('injected: after authority');

    if (!wroteBinding) {
      const stamped = await store.writeBinding({
        driverId,
        approvedKey,
        status: 'active',
        opId: input.opId,
      }, input.failAfter === 'after_binding_byDriver' ? { failAfter: 'byDriver' } : undefined);
      if (stamped === 'foreign') throw new Error('binding_foreign');
      wroteBinding = true;
      writes.binding = stamped === 'written' || stamped === 'repaired';
    }
    if (input.failAfter === 'binding') throw new Error('injected: after binding');

    if (input.failAfter === 'journal_complete') {
      throw new Error('injected: before journal_complete');
    }
    await store.journal.markCompleted(attemptKeyId({ kind: 'legacy', legacyHash: approvedKey }));
    writes.journalCompleted = true;

    const termLive = await inspectLive(true);
    if (!termLive) {
      return {
        status: 'unproven',
        reason: 'compensation_unproven',
        driverId,
        writes,
        preview,
        terminalProven: false,
      };
    }
    const terminal = proof(termLive);
    if (!terminal.ok) {
      return {
        status: termLive.binding?.driverId === driverId ? 'bound_resumable' : 'unproven',
        reason: terminal.reason,
        driverId,
        writes,
        preview,
        terminalProven: false,
      };
    }
    return {
      status: 'ok',
      reason: 'upgraded',
      driverId,
      writes,
      preview,
      terminalProven: true,
    };
  } catch (err) {
    const liveAfter = await inspectLive(true);
    if (!liveAfter) {
      return {
        status: 'unproven',
        reason: 'compensation_unproven',
        driverId,
        writes,
        preview,
        terminalProven: false,
      };
    }
    if (
      liveAfter.binding?.driverId === driverId
      || liveAfter.bindingByDriver?.driverId === driverId
      || liveAfter.bindingByApproved?.approvedKey === approvedKey
    ) {
      return {
        status: 'bound_resumable',
        reason: (err as Error).message || 'upgrade_incomplete_bound',
        driverId,
        writes,
        preview,
        terminalProven: false,
      };
    }
    await compensatePreBind(store, {
      driverId,
      nameNorm,
      opId: input.opId,
      wroteProfile,
      wroteAuthority,
      skipCredentialWrite,
      expectedCompanyId: companyId,
    });
    return {
      status: 'rolled_back',
      reason: (err as Error).message || 'upgrade_failed',
      driverId,
      writes,
      preview,
      terminalProven: false,
    };
  }
}

export function createMemoryUpgradeStore(): UpgradeStore & {
  approved: Map<string, Record<string, unknown>>;
  credentials: Map<string, Record<string, unknown>>;
  index: Map<string, { driverId: string }>;
  profiles: Map<string, Record<string, unknown>>;
  authority: Map<string, Record<string, unknown>>;
  bindingsByDriver: Map<string, IdentityBinding>;
  bindingsByApproved: Map<string, IdentityBinding>;
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
  const bindingsByDriver = new Map<string, IdentityBinding>();
  const bindingsByApproved = new Map<string, IdentityBinding>();
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
    bindingsByDriver,
    bindingsByApproved,
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
        return `bbbbbbbb-cccc-4ddd-8eee-${String(box.uuidSeq).padStart(12, '0')}`;
      },
    },
    async readApproved(key: string) {
      return approved.get(key) ?? null;
    },
    async readProfile(driverId: string) {
      return profiles.get(driverId) ?? null;
    },
    async readBindingByDriver(driverId: string) {
      return bindingsByDriver.get(driverId) ?? null;
    },
    async readBindingByApproved(approvedKey: string) {
      return bindingsByApproved.get(approvedKey) ?? null;
    },
    async writeBinding(
      binding: IdentityBinding,
      opts?: { failAfter?: 'byDriver' },
    ): Promise<'written' | 'repaired' | 'already_exact' | 'foreign'> {
      const decision = decideBindIdentity({
        driverId: binding.driverId,
        approvedKey: binding.approvedKey,
        status: binding.status,
        opId: binding.opId,
        existingByDriver: bindingsByDriver.get(binding.driverId) ?? null,
        existingByApproved: bindingsByApproved.get(binding.approvedKey) ?? null,
      });
      if (decision.action === 'refuse') return 'foreign';
      if (decision.action === 'already_exact') return 'already_exact';
      const payload = decision.payload;
      bindingsByDriver.set(payload.driverId, { ...payload });
      if (opts?.failAfter === 'byDriver') {
        throw new Error('injected: partial binding');
      }
      bindingsByApproved.set(payload.approvedKey, { ...payload });
      return decision.action === 'repair' ? 'repaired' : 'written';
    },
    async commitProfileHydration(input: {
      driverId: string;
      approvedKey: string;
      expectedDigest: string;
      legacyRow: Record<string, unknown>;
      copy: Partial<Record<OperationalField, unknown>>;
      preview: Pick<HydrationPreview, 'copy' | 'preserved' | 'conflicts'>;
      opId: string;
    }): Promise<'written' | 'already_exact' | 'stale_preview' | 'foreign'> {
      const current = profiles.get(input.driverId) ?? null;
      const gate = evaluateHydrationTransaction({
        current,
        driverId: input.driverId,
        approvedKey: input.approvedKey,
        expectedDigest: input.expectedDigest,
        legacyRow: input.legacyRow,
        copy: input.copy,
        preview: input.preview,
        opId: input.opId,
      });
      if (!gate.ok) {
        if (gate.reason === 'stale_preview') return 'stale_preview';
        return 'foreign';
      }
      profiles.set(input.driverId, gate.next);
      return 'written';
    },
    async removeBindingIfOwned(input: { driverId: string; approvedKey: string; opId: string }) {
      const b = bindingsByDriver.get(input.driverId);
      if (!b) return 'missing';
      if (b.opId !== input.opId || b.approvedKey !== input.approvedKey) return 'left_intact';
      bindingsByDriver.delete(input.driverId);
      bindingsByApproved.delete(input.approvedKey);
      return 'removed';
    },
    async writeIdentity(input: {
      driverId: string;
      nameNorm: string;
      displayName: string;
      passcodeRecord: PasscodeRecord;
      opId: string;
      callerUid: string;
    }) {
      const idx = index.get(input.nameNorm);
      const existingDriverId = readIndexOwner(!!idx, idx);
      let incumbentCredential = readIncumbentCredential(false, undefined);
      if (existingDriverId && existingDriverId !== 'malformed' && existingDriverId !== input.driverId) {
        const other = credentials.get(existingDriverId);
        incumbentCredential = readIncumbentCredential(!!other, other);
      }
      const claim = decideNameIndexClaim({
        existingDriverId,
        targetDriverId: input.driverId,
        incumbentCredential,
      });
      if (!claim.allow) throw new Error(`index_claim:${claim.reason}`);
      const existingCred = credentials.get(input.driverId);
      if (existingCred && typeof existingCred.opId === 'string' && existingCred.opId !== input.opId) {
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
        mustResetPasscode: false,
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
    async writeProfile(driverId: string, profile: Record<string, unknown>): Promise<'written' | 'already_exact' | 'foreign' | 'stale_preview'> {
      if (profileContainsForbiddenLegacyKey(profile)) {
        throw new Error('profile_leaks_legacy_key');
      }
      const existing = profiles.get(driverId);
      if (existing && existing.provisioningOpId && existing.provisioningOpId !== profile.provisioningOpId) {
        const same = JSON.stringify({ ...existing, provisioningOpId: null })
          === JSON.stringify({ ...profile, provisioningOpId: null });
        if (!same && existing.assignmentRevision != null) {
          profiles.set(driverId, profile);
          return 'written';
        }
      }
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
      const bindingByDriver = bindingsByDriver.get(driverId) ?? null;
      const bindingByApproved = bindingsByApproved.get(approvedKey) ?? null;
      const term = decideBindingTerminalProof({
        driverId,
        approvedKey,
        byDriver: bindingByDriver,
        byApproved: bindingByApproved,
      });
      const journal = journalMap.get(`legacy:${approvedKey}`);
      return {
        bindingByDriver,
        bindingByApproved,
        binding: term.ok ? term.binding : null,
        credentialOpId: typeof cred?.opId === 'string' ? cred.opId : null,
        credentialActive: typeof cred?.active === 'boolean' ? cred.active : null,
        credentialScryptValid: isServerScryptRecord(cred?.passcode),
        indexDriverId: idx?.driverId ?? null,
        profile: prof,
        journalCompleted: journal ? journal.completed === true : null,
      };
    },
    async readNameIndex(nameNorm: string) {
      return index.get(nameNorm)?.driverId ?? null;
    },
    async readCredentialActive(driverId: string) {
      const cred = credentials.get(driverId);
      return !!cred && cred.active !== false;
    },
  };
  return box;
}

export { parseBinding };
