export const LEGACY_WELL_POOL_COMPANY_ID = 'liquid-gold';

/**
 * Doc-level tenant match for containment filters.
 */
export function docBelongsToTenant(
  docCompanyId: string | null | undefined,
  userCompanyId: string | undefined,
): boolean {
  if (!userCompanyId) return true;
  if (docCompanyId === userCompanyId) return true;
  return userCompanyId === LEGACY_WELL_POOL_COMPANY_ID && !docCompanyId;
}

/**
 * Extracts the operational driver profile name assigned in the company catalog.
 * Preserves whatever operational name is assigned to the driver profile (e.g. "Mike ZFold7 Burger").
 * Never falls back to an authentication email or username.
 */
export function extractDriverProfileName(val: any): string {
  if (!val || typeof val !== 'object') return '';

  const candidate = (
    val.displayName ||
    val.legalName ||
    val.profile?.legalName ||
    val.name ||
    ''
  ).trim();

  // Prohibit falling back to authentication email addresses
  if (candidate.includes('@') && !candidate.includes(' ')) {
    return '';
  }

  return candidate;
}

/**
 * Builds the company-scoped driver map from the catalog.
 * Uses the company driver-profile name as its source.
 * Preserves whatever operational name is assigned to the driver profile.
 */
export function buildCanonicalDriverMap(
  catalog: { approved?: Record<string, unknown>; profiles?: Record<string, unknown> } | null | undefined,
  effectiveCompanyId: string | null | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  if (!catalog || !effectiveCompanyId) return map;

  const approved = (catalog.approved || {}) as Record<string, any>;
  Object.entries(approved).forEach(([hash, val]) => {
    if (!val || typeof val !== 'object') return;

    let profileName = '';
    let companyId: string | undefined = undefined;
    let driverId: string | undefined = undefined;
    let migratedId: string | undefined = undefined;

    if (val.displayName || val.name || val.legalName) {
      // Flat driver structure: drivers/approved/{hash}
      companyId = val.companyId;
      profileName = extractDriverProfileName(val);
      driverId = typeof val.driverId === 'string' ? val.driverId.trim() : undefined;
      migratedId = typeof val.migratedToDriverId === 'string' ? val.migratedToDriverId.trim() : undefined;
    } else {
      // Legacy nested structure: drivers/approved/{hash}/{deviceId}
      const deviceKeys = Object.keys(val);
      for (const k of deviceKeys) {
        const dev = val[k];
        if (dev && typeof dev === 'object') {
          companyId = companyId || dev.companyId;
          profileName = profileName || extractDriverProfileName(dev);
          driverId = driverId || (typeof dev.driverId === 'string' ? dev.driverId.trim() : undefined);
          migratedId = migratedId || (typeof dev.migratedToDriverId === 'string' ? dev.migratedToDriverId.trim() : undefined);
        }
      }
    }

    // Strict tenant containment: driver must belong to effectiveCompanyId
    if (docBelongsToTenant(companyId, effectiveCompanyId) && profileName) {
      if (hash) map.set(hash, profileName);
      if (driverId) map.set(driverId, profileName);
      if (migratedId) map.set(migratedId, profileName);
    }
  });

  // Also include canonical profiles if present in catalog
  const profiles = (catalog.profiles || {}) as Record<string, any>;
  Object.entries(profiles).forEach(([profId, val]) => {
    if (!val || typeof val !== 'object') return;
    const profileName = extractDriverProfileName(val);
    const companyId = val.companyId;
    if (docBelongsToTenant(companyId, effectiveCompanyId) && profileName) {
      if (profId) map.set(profId, profileName);
    }
  });

  return map;
}

/**
 * Resolves a driver's stable identifier (UID, hash, driverId) against the company-scoped map.
 * Returns the operational driver-profile name, or "Unknown driver".
 * Never falls back to an authentication username or email.
 */
export function resolveCanonicalDriverName(
  driverMap: Map<string, string>,
  driverId: string | null | undefined,
): string {
  if (!driverId || typeof driverId !== 'string' || !driverId.trim()) {
    return 'Unknown driver';
  }
  const match = driverMap.get(driverId.trim());
  if (match && match.trim()) {
    return match.trim();
  }
  return 'Unknown driver';
}

/**
 * Finds all driver IDs in the company-scoped roster whose operational profile name matches the query.
 */
export function findMatchingCanonicalDriverIds(
  driverMap: Map<string, string>,
  query: string,
): Set<string> {
  const matching = new Set<string>();
  const q = (query || '').trim().toLowerCase();
  if (!q) return matching;

  driverMap.forEach((profileName, id) => {
    if (profileName.toLowerCase().includes(q)) {
      matching.add(id);
    }
  });

  return matching;
}
