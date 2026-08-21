/**
 * Deterministic legacy → canonical assignment backfill planner.
 *
 * Dry-run is the default. Apply is a separate, explicit step that this
 * module never performs on its own.
 *
 * Mapping rule for a requested display identity:
 *   exactly one active legacy approved row
 *   exactly one active canonical profile
 *   matching companyId and normalized displayName
 * Ambiguous or duplicate mappings are refused.
 */
import {
  assignmentFieldForClient,
  normalizeAssignmentField,
} from './canonicalAssignment';
import {
  isCanonicalDriverId,
  isLegacyHashKey,
  normalizeDisplayIdentity,
} from './assignDriverAssignment';

export type MigrationIdentityRow = {
  id: string;
  displayName: string | null;
  companyId: string | null;
  active: boolean;
  assignedRoutes?: unknown;
  assignedWells?: unknown;
};

export type MigrationNameResult =
  | {
      ok: true;
      status: 'would_write' | 'already_applied';
      displayName: string;
      driverId: string;
      companyId: string;
      dualWrite: true;
      current: {
        assignedRoutes: string[] | null;
        assignedWells: string[] | null;
      };
      proposed: {
        assignedRoutes: string[];
        assignedWells: string[] | null;
      };
      wellsWouldWrite: boolean;
    }
  | {
      ok: false;
      displayName: string;
      reason: string;
    };

export type MigrationReport = {
  mode: 'dry-run';
  names: string[];
  results: MigrationNameResult[];
  wouldWriteCount: number;
  alreadyAppliedCount: number;
  refusedCount: number;
};

function sameStringArray(a: string[] | null, b: string[] | null): boolean {
  if (a === null && b === null) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function rowsForName(rows: MigrationIdentityRow[], name: string): MigrationIdentityRow[] {
  const want = normalizeDisplayIdentity(name);
  return rows.filter((r) => normalizeDisplayIdentity(r.displayName || '') === want);
}

export function evaluateAssignmentMigration(input: {
  requestedNames: string[];
  approved: MigrationIdentityRow[];
  profiles: MigrationIdentityRow[];
}): MigrationReport {
  const names = input.requestedNames.map((n) => n.trim()).filter(Boolean);
  const results: MigrationNameResult[] = [];

  for (const displayName of names) {
    const approvedHits = rowsForName(input.approved, displayName);
    const profileHits = rowsForName(input.profiles, displayName);

    if (approvedHits.length === 0) {
      results.push({ ok: false, displayName, reason: 'legacy_not_found' });
      continue;
    }
    if (approvedHits.length > 1) {
      results.push({ ok: false, displayName, reason: 'legacy_duplicate' });
      continue;
    }
    if (profileHits.length === 0) {
      results.push({ ok: false, displayName, reason: 'canonical_not_found' });
      continue;
    }
    if (profileHits.length > 1) {
      results.push({ ok: false, displayName, reason: 'canonical_duplicate' });
      continue;
    }

    const legacy = approvedHits[0];
    const profile = profileHits[0];

    if (isLegacyHashKey(profile.id) || !isCanonicalDriverId(profile.id)) {
      results.push({ ok: false, displayName, reason: 'canonical_id_invalid' });
      continue;
    }
    if (!legacy.active) {
      results.push({ ok: false, displayName, reason: 'legacy_inactive' });
      continue;
    }
    if (!profile.active) {
      results.push({ ok: false, displayName, reason: 'canonical_inactive' });
      continue;
    }
    const companyId = (profile.companyId || '').trim();
    const legacyCompany = (legacy.companyId || '').trim();
    if (!companyId || !legacyCompany || companyId !== legacyCompany) {
      results.push({ ok: false, displayName, reason: 'company_mismatch' });
      continue;
    }
    if (
      normalizeDisplayIdentity(profile.displayName || '') !==
      normalizeDisplayIdentity(legacy.displayName || '')
    ) {
      results.push({ ok: false, displayName, reason: 'display_identity_mismatch' });
      continue;
    }

    const legacyRoutes = normalizeAssignmentField(legacy.assignedRoutes);
    if (!legacyRoutes.present) {
      results.push({ ok: false, displayName, reason: 'legacy_assignment_missing' });
      continue;
    }

    const currentRoutes = assignmentFieldForClient(profile.assignedRoutes);
    const currentWells = assignmentFieldForClient(profile.assignedWells);
    const legacyWells = normalizeAssignmentField(legacy.assignedWells);
    const proposedWells = legacyWells.present ? legacyWells.values : null;
    const wellsWouldWrite = proposedWells !== null;

    const already =
      sameStringArray(currentRoutes, legacyRoutes.values) &&
      (!wellsWouldWrite || sameStringArray(currentWells, proposedWells));

    results.push({
      ok: true,
      status: already ? 'already_applied' : 'would_write',
      displayName,
      driverId: profile.id,
      companyId,
      dualWrite: true,
      current: {
        assignedRoutes: currentRoutes,
        assignedWells: currentWells,
      },
      proposed: {
        assignedRoutes: legacyRoutes.values,
        assignedWells: proposedWells,
      },
      wellsWouldWrite,
    });
  }

  return {
    mode: 'dry-run',
    names,
    results,
    wouldWriteCount: results.filter((r) => r.ok && r.status === 'would_write').length,
    alreadyAppliedCount: results.filter((r) => r.ok && r.status === 'already_applied').length,
    refusedCount: results.filter((r) => !r.ok).length,
  };
}

/** Public report never includes legacy hash keys. */
export function sanitizeMigrationReport(report: MigrationReport): MigrationReport {
  const json = JSON.stringify(report);
  if (/[a-f0-9]{64}/i.test(json)) {
    throw new Error('migration_report_leaked_legacy_key');
  }
  return report;
}
