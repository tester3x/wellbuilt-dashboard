/**
 * Server-only one-time legacy → scrypt conversion.
 *
 * NEVER executed against production in this phase. The callable wiring is
 * live in source so emulator tests can prove the transaction. Production
 * invocation is a later, separately authorized deploy.
 *
 * Journaled, resumable state machine:
 *   started → credential_written → profile_written → auth_ensured
 *   → claims_set → index_written → legacy_disabled → completed
 *
 * A retry that sees its own journal/index/credential MUST resume missing
 * steps. modern_exists is only returned when the modern identity is
 * complete and is not this journal's in-flight conversion.
 *
 * preservationInvariants() is enforced BEFORE any mutation.
 *
 * Rollout: ALLOW_LEGACY_LOGIN_MIGRATION must be authorized and available
 * before Class-2 testers receive a secure-only build. Never restore
 * client-side/public legacy login.
 */
import { randomUUID } from 'crypto';
import {
  hashPasscodeScrypt,
  legacySha256NamePasscode,
  normalizeDisplayName,
} from './passcode';
import { readIncumbentCredential, readIndexOwner } from './nameIndexClaim';

export const CLASS2_MIGRATE_NAMES = Object.freeze([
  'tablets10',
  'iphone16',
  'adans',
  'marcial lebaron',
  'wisho-135',
] as const);

/** Existing modern identities — never recreate, never migrate. */
export const CLASS1_PRESERVE_NAMES = Object.freeze(['mikes24', 'mikezfold'] as const);

export const MIGRATION_STEPS = Object.freeze([
  'started',
  'credential_written',
  'profile_written',
  'auth_ensured',
  'claims_set',
  'index_written',
  'legacy_disabled',
  'completed',
] as const);

export type MigrationStep = (typeof MIGRATION_STEPS)[number];

/** Server-owned fields copied from the verified approved row. Nothing else. */
export const METADATA_COPY_FIELDS = Object.freeze([
  'displayName',
  'legalName',
  'name',
  'companyId',
  'companyName',
  'registrationCompany',
  'isAdmin',
  'isViewer',
  'roles',
  'assignedRoutes',
  'assignedCustomers',
  'dashboardUid',
  'dashboardRole',
  'defaultPackageId',
  'truckNumber',
  'trailerNumber',
  'profile',
  'tier',
] as const);

export type MigrationRefuse =
  | 'not_allowlisted'
  | 'class1_must_use_modern'
  | 'modern_exists'
  | 'modern_inactive'
  | 'legacy_missing'
  | 'legacy_inactive'
  | 'legacy_name_mismatch'
  | 'name_taken'
  | 'indeterminate'
  | 'malformed_legacy'
  | 'passcode_mismatch'
  | 'preservation_failed';

export type MigrationDecision =
  | { action: 'modern_only'; reason: 'index_present' | 'class1_must_use_modern' }
  | { action: 'refuse'; reason: MigrationRefuse }
  | { action: 'migrate'; nameNorm: string };

export function isClass2MigrateName(nameNorm: string): boolean {
  return (CLASS2_MIGRATE_NAMES as readonly string[]).includes(nameNorm);
}

export function isClass1PreserveName(nameNorm: string): boolean {
  return (CLASS1_PRESERVE_NAMES as readonly string[]).includes(nameNorm);
}

/**
 * Pure gate. Called BEFORE any legacy hash is computed when a modern
 * index already exists — so a deactivated modern account cannot fall
 * through to an active legacy row.
 *
 * Incomplete journals are NOT decided here. applyOneTimeLegacyMigration
 * inspects the journal and resumes.
 */
export function decideAuthenticationPath(input: {
  nameNorm: string;
  modernIndexExists: boolean;
  modernCredentialActive: boolean | null;
}): MigrationDecision {
  if (input.modernIndexExists) {
    if (input.modernCredentialActive === false) {
      return { action: 'refuse', reason: 'modern_inactive' };
    }
    return { action: 'modern_only', reason: 'index_present' };
  }
  if (isClass1PreserveName(input.nameNorm)) {
    return { action: 'modern_only', reason: 'class1_must_use_modern' };
  }
  if (!isClass2MigrateName(input.nameNorm)) {
    return { action: 'refuse', reason: 'not_allowlisted' };
  }
  return { action: 'migrate', nameNorm: input.nameNorm };
}

/**
 * Secure-only Class-2 clients are forbidden until the migrator is
 * separately authorized AND available. Never restore public legacy login.
 */
export function class2SecureOnlyClientAllowed(input: {
  migrationAuthorizedAndAvailable: boolean;
}): boolean {
  return input.migrationAuthorizedAndAvailable === true;
}

export function pickServerOwnedMetadata(legacyRow: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of METADATA_COPY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(legacyRow, key) && legacyRow[key] !== undefined) {
      out[key] = legacyRow[key];
    }
  }
  return out;
}

export function assertLegacyRowUsable(
  displayName: string,
  row: Record<string, unknown> | null | undefined,
): { ok: true } | { ok: false; reason: MigrationRefuse } {
  if (!row || typeof row !== 'object') return { ok: false, reason: 'legacy_missing' };
  if (row.active === false) return { ok: false, reason: 'legacy_inactive' };
  const rowName = typeof row.displayName === 'string' ? row.displayName : '';
  if (!rowName) return { ok: false, reason: 'malformed_legacy' };
  if (normalizeDisplayName(rowName) !== normalizeDisplayName(displayName)) {
    return { ok: false, reason: 'legacy_name_mismatch' };
  }
  return { ok: true };
}

/** iPhone16 / TabletS10 / Class-2 invariants. Never inferred from a client. */
export function preservationInvariants(displayName: string, meta: Record<string, unknown>) {
  const name = normalizeDisplayName(displayName);
  const hasDisplay = typeof meta.displayName === 'string' && meta.displayName.trim().length > 0;
  const hasCompany = typeof meta.companyId === 'string' && meta.companyId.trim().length > 0;
  const base = {
    requireDisplayName: hasDisplay,
    requireCompany: hasCompany,
  };
  if (name === 'iphone16') {
    return {
      ...base,
      requireAdmin: meta.isAdmin === true,
      requireCompanyLiquidGold: meta.companyId === 'liquid-gold',
      requireRouteCount: Array.isArray(meta.assignedRoutes) && meta.assignedRoutes.length === 3,
      requireCustomerCount: Array.isArray(meta.assignedCustomers) && meta.assignedCustomers.length === 1,
    };
  }
  if (name === 'tablets10') {
    return {
      ...base,
      requireDashboardUid: typeof meta.dashboardUid === 'string' && meta.dashboardUid.length > 0,
      requireDashboardRole: typeof meta.dashboardRole === 'string' && meta.dashboardRole.length > 0,
    };
  }
  return base;
}

export function assertPreservationInvariants(
  displayName: string,
  meta: Record<string, unknown>,
): { ok: true } | { ok: false; reason: 'preservation_failed'; failed: string[] } {
  const inv = preservationInvariants(displayName, meta) as Record<string, boolean>;
  const failed = Object.entries(inv)
    .filter(([, v]) => v !== true)
    .map(([k]) => k);
  if (failed.length) return { ok: false, reason: 'preservation_failed', failed };
  return { ok: true };
}

export function stepRank(step: string | undefined): number {
  const i = (MIGRATION_STEPS as readonly string[]).indexOf(step || '');
  return i < 0 ? -1 : i;
}

export function isIncompleteJournal(status?: string): boolean {
  return !!status && status !== 'completed';
}

export interface MigrationStores {
  getNameIndex(nameNorm: string): Promise<{ exists: boolean; driverId?: unknown }>;
  getCredential(driverId: string): Promise<{ exists: boolean; data?: Record<string, unknown> }>;
  getJournal(legacyHash: string): Promise<{
    exists: boolean;
    driverId?: string;
    status?: string;
    nameNorm?: string;
  }>;
  getLegacyApproved(legacyHash: string): Promise<Record<string, unknown> | null>;
  claimJournal(
    legacyHash: string,
    nameNorm: string,
    driverId: string,
  ): Promise<{ driverId: string; created: boolean; nameTaken?: boolean }>;
  writeJournal(legacyHash: string, data: Record<string, unknown>): Promise<void>;
  writeCredential(driverId: string, data: Record<string, unknown>): Promise<void>;
  writeIndex(nameNorm: string, driverId: string): Promise<void>;
  writeProfile(driverId: string, profile: Record<string, unknown>): Promise<void>;
  disableLegacyLogin(legacyHash: string, driverId: string, nowMs: number): Promise<void>;
  ensureAuthUser(driverId: string, displayName: string): Promise<string>;
  setGlobalClaims(
    driverId: string,
    claims: { kind: 'driver'; driverId: string; companyId: string | null; roles: string[] },
  ): Promise<void>;
  nowMs(): number;
}

export type MigrationApplyResult =
  | { ok: true; driverId: string; reused: boolean; status: MigrationStep }
  | { ok: false; reason: MigrationRefuse };

export async function applyOneTimeLegacyMigration(
  stores: MigrationStores,
  input: { displayName: string; passcode: string; failAfter?: MigrationStep },
): Promise<MigrationApplyResult> {
  const nameNorm = normalizeDisplayName(input.displayName);
  if (isClass1PreserveName(nameNorm)) {
    return { ok: false, reason: 'class1_must_use_modern' };
  }
  if (!isClass2MigrateName(nameNorm)) {
    return { ok: false, reason: 'not_allowlisted' };
  }

  const legacyHash = legacySha256NamePasscode(input.displayName, input.passcode);
  const journal = await stores.getJournal(legacyHash);
  const existingIndex = await stores.getNameIndex(nameNorm);

  if (existingIndex.exists) {
    const owner = readIndexOwner(true, { driverId: existingIndex.driverId });
    if (typeof owner !== 'string') return { ok: false, reason: 'indeterminate' };
    const cred = await stores.getCredential(owner);
    const state = readIncumbentCredential(cred.exists, cred.data);
    const ownJournal = journal.exists && journal.driverId === owner;
    if (ownJournal && isIncompleteJournal(journal.status)) {
      // Resume our own in-flight conversion. Do not return modern_exists.
    } else {
      if (state === 'inactive') return { ok: false, reason: 'modern_inactive' };
      return { ok: false, reason: 'modern_exists' };
    }
  }

  const legacy = await stores.getLegacyApproved(legacyHash);
  const usable = assertLegacyRowUsable(input.displayName, legacy);
  if (!usable.ok) return { ok: false, reason: usable.reason };

  const meta = pickServerOwnedMetadata(legacy as Record<string, unknown>);
  const preserved = assertPreservationInvariants(input.displayName, meta);
  if (!preserved.ok) return { ok: false, reason: 'preservation_failed' };

  const proposedId = journal.driverId && journal.exists ? journal.driverId : randomUUID();
  const claimed = await stores.claimJournal(legacyHash, nameNorm, proposedId);
  if (claimed.nameTaken) {
    return { ok: false, reason: 'name_taken' };
  }
  if (!claimed.created) {
    const owned = journal.exists && journal.driverId === claimed.driverId;
    if (!owned) {
      const afterClaim = await stores.getJournal(legacyHash);
      if (!afterClaim.exists || afterClaim.driverId !== claimed.driverId) {
        return { ok: false, reason: 'name_taken' };
      }
    }
  }
  const driverId = claimed.driverId;
  const reused = !claimed.created;
  const journalAfter = await stores.getJournal(legacyHash);
  let status: MigrationStep | '' = journalAfter.exists ? ((journalAfter.status as MigrationStep) || 'started') : 'started';

  const stop = (at: MigrationStep): MigrationApplyResult | null => {
    if (input.failAfter && input.failAfter === at) {
      return { ok: true, driverId, reused, status: at };
    }
    return null;
  };

  if (stepRank(status) < stepRank('started')) {
    await stores.writeJournal(legacyHash, {
      driverId,
      nameNorm,
      status: 'started',
      createdAt: stores.nowMs(),
      updatedAt: stores.nowMs(),
    });
    status = 'started';
    const early = stop('started');
    if (early) return early;
  }

  if (stepRank(status) < stepRank('credential_written')) {
    const passcodeRecord = await hashPasscodeScrypt(input.passcode);
    await stores.writeCredential(driverId, {
      active: true,
      displayName: (meta.displayName as string) || input.displayName,
      displayNameNorm: nameNorm,
      passcode: passcodeRecord,
      mustResetPasscode: false,
      source: 'legacy_one_time_migration',
      migratedFromLegacy: true,
      createdAt: stores.nowMs(),
      updatedAt: stores.nowMs(),
    });
    await stores.writeJournal(legacyHash, {
      driverId,
      nameNorm,
      status: 'credential_written',
      updatedAt: stores.nowMs(),
    });
    status = 'credential_written';
    const early = stop('credential_written');
    if (early) return early;
  }

  const profile = {
    ...meta,
    displayName: (meta.displayName as string) || input.displayName,
    displayNameNorm: nameNorm,
    roles: Array.isArray(meta.roles) && meta.roles.length ? meta.roles : ['driver'],
    active: true,
    driverId,
    migratedFromLegacy: true,
    migratedAt: stores.nowMs(),
    schemaVersion: 1,
  };

  if (stepRank(status) < stepRank('profile_written')) {
    await stores.writeProfile(driverId, profile);
    await stores.writeJournal(legacyHash, {
      driverId,
      nameNorm,
      status: 'profile_written',
      updatedAt: stores.nowMs(),
    });
    status = 'profile_written';
    const early = stop('profile_written');
    if (early) return early;
  }

  if (stepRank(status) < stepRank('auth_ensured')) {
    await stores.ensureAuthUser(driverId, String(profile.displayName || input.displayName));
    await stores.writeJournal(legacyHash, {
      driverId,
      nameNorm,
      status: 'auth_ensured',
      updatedAt: stores.nowMs(),
    });
    status = 'auth_ensured';
    const early = stop('auth_ensured');
    if (early) return early;
  }

  if (stepRank(status) < stepRank('claims_set')) {
    const roles: string[] = Array.isArray(meta.roles) ? (meta.roles as string[]) : ['driver'];
    await stores.setGlobalClaims(driverId, {
      kind: 'driver',
      driverId,
      companyId: typeof meta.companyId === 'string' ? meta.companyId : null,
      roles,
    });
    await stores.writeJournal(legacyHash, {
      driverId,
      nameNorm,
      status: 'claims_set',
      updatedAt: stores.nowMs(),
    });
    status = 'claims_set';
    const early = stop('claims_set');
    if (early) return early;
  }

  if (stepRank(status) < stepRank('index_written')) {
    await stores.writeIndex(nameNorm, driverId);
    await stores.writeJournal(legacyHash, {
      driverId,
      nameNorm,
      status: 'index_written',
      updatedAt: stores.nowMs(),
    });
    status = 'index_written';
    const early = stop('index_written');
    if (early) return early;
  }

  if (stepRank(status) < stepRank('legacy_disabled')) {
    await stores.disableLegacyLogin(legacyHash, driverId, stores.nowMs());
    await stores.writeJournal(legacyHash, {
      driverId,
      nameNorm,
      status: 'legacy_disabled',
      updatedAt: stores.nowMs(),
    });
    status = 'legacy_disabled';
    const early = stop('legacy_disabled');
    if (early) return early;
  }

  await stores.writeJournal(legacyHash, {
    driverId,
    nameNorm,
    status: 'completed',
    updatedAt: stores.nowMs(),
  });
  return { ok: true, driverId, reused, status: 'completed' };
}
