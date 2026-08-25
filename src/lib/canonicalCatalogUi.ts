/**
 * Fail-closed canonical catalog interpretation for the Admin employees page.
 * Absence of `profiles` on a successful callable is NOT an empty catalog —
 * Phase 1 adminGetDashboardCatalog never returned that field.
 */

export type CanonicalCatalogStatus = 'loading' | 'unavailable' | 'empty' | 'ok';

export type SecureLoginUiState = 'create' | 'secured' | 'none' | 'unknown' | 'duplicate';

export type CanonicalProfileView = {
  driverId: string;
  displayName: string;
  legalName?: string;
  companyId?: string;
};

export function catalogHasProfilesField(catalog: unknown): boolean {
  return !!catalog && typeof catalog === 'object' && !Array.isArray(catalog)
    && Object.prototype.hasOwnProperty.call(catalog, 'profiles');
}

export function interpretCatalogProfiles(
  catalog: unknown,
  loadFailed: boolean,
): { status: CanonicalCatalogStatus; profiles: Record<string, unknown> } {
  if (loadFailed || catalog == null) {
    return { status: 'unavailable', profiles: {} };
  }
  if (!catalogHasProfilesField(catalog)) {
    return { status: 'unavailable', profiles: {} };
  }
  const raw = (catalog as { profiles?: unknown }).profiles;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { status: 'unavailable', profiles: {} };
  }
  const profiles = raw as Record<string, unknown>;
  return {
    status: Object.keys(profiles).length === 0 ? 'empty' : 'ok',
    profiles,
  };
}

export function parseCanonicalProfiles(
  profiles: Record<string, unknown>,
): CanonicalProfileView[] {
  const out: CanonicalProfileView[] = [];
  for (const [id, val] of Object.entries(profiles)) {
    if (!val || typeof val !== 'object') continue;
    const rec = val as Record<string, unknown>;
    out.push({
      driverId: id,
      displayName: String(rec.displayName || rec.name || 'Unknown'),
      legalName: typeof rec.legalName === 'string' ? rec.legalName : undefined,
      companyId: typeof rec.companyId === 'string' ? rec.companyId : undefined,
    });
  }
  return out;
}

export function createSecureLoginAllowed(status: CanonicalCatalogStatus): boolean {
  return status === 'ok' || status === 'empty';
}

function norm(s: string | undefined): string {
  return (s || '').trim().toLowerCase();
}

/** Name match for warnings only — never a binding. */
export function unboundSameNameProfile(
  row: { displayName?: string; legalName?: string; driverId?: string; key?: string },
  profiles: CanonicalProfileView[],
): CanonicalProfileView | null {
  const boundId = (row.driverId || '').trim();
  if (boundId && boundId !== row.key && profiles.some((p) => p.driverId === boundId)) {
    return null;
  }
  const names = [row.displayName, row.legalName].map(norm).filter(Boolean);
  if (names.length === 0) return null;
  for (const p of profiles) {
    const pn = [p.displayName, p.legalName].map(norm).filter(Boolean);
    if (pn.some((n) => names.includes(n))) return p;
  }
  return null;
}

export function secureLoginUiState(input: {
  isWbAdmin: boolean;
  catalogStatus: CanonicalCatalogStatus;
  driverActive: boolean;
  hasCanonicalDriverId: boolean;
  unboundSameName: CanonicalProfileView | null;
}): SecureLoginUiState {
  if (!input.isWbAdmin) return 'none';
  if (!createSecureLoginAllowed(input.catalogStatus)) return 'unknown';
  if (input.hasCanonicalDriverId) return 'secured';
  if (input.unboundSameName) return 'duplicate';
  return input.driverActive ? 'create' : 'none';
}
