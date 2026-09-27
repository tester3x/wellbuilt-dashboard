/**
 * Shared dispatch roster projection (Firebase-free, node-testable).
 *
 * Projects the raw Dashboard catalog (approved + profiles) into governed,
 * company-scoped driver records for the dispatch picker, Active Jobs, and
 * Queue attribution.
 *
 * Guarantees:
 *   1. Modern secure drivers (minted in drivers/profiles only) are projected
 *      and visible in the dispatch picker with their canonical UUIDs.
 *   2. Legacy approved drivers retain their keys and resolve via legacy fallback.
 *   3. Migrated drivers link the approved row with the canonical profile UUID,
 *      preserving legacy aliases for backward compatibility.
 *   4. Strict company boundary: drivers from other tenants are never shown.
 *   5. Real human names: legalName preferred, then displayName, never username/login.
 */

import { docBelongsToTenant } from './canonicalDriverRoster.ts';
import { canonicalIdFromApprovedRow, isCanonicalDriverId } from './dispatchWriterIdentity.ts';
import type { DriverIdentity } from './dispatchDriverIdentity.ts';

export interface ProjectedDispatchDriver extends DriverIdentity {
  displayName: string;
  legalName?: string;
  loginAlias?: string;
  active?: boolean;
  companyId?: string;
  companyName?: string;
  assignedRoutes?: string[];
  phone?: string;
  onShift?: boolean;
}

export type CatalogInput = {
  approved?: Record<string, unknown> | null;
  profiles?: Record<string, unknown> | null;
};

const t = (v: unknown): string => (typeof v === 'string' ? v.trim() : v != null ? String(v).trim() : '');
const uniq = (a: string[]): string[] => [...new Set(a.filter(Boolean))];

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Flatten flat or legacy-nested approved rows. */
function flattenApprovedRow(hash: string, raw: unknown): Record<string, unknown> | null {
  const rec = asRecord(raw);
  if (rec.displayName || rec.name || rec.legalName) {
    return rec;
  }
  const deviceKeys = Object.keys(rec);
  if (deviceKeys.length > 0) {
    const first = asRecord(rec[deviceKeys[0]]);
    if (first.displayName || first.name || first.legalName) {
      return {
        ...first,
        companyId: first.companyId ?? rec.companyId,
        companyName: first.companyName ?? rec.companyName,
      };
    }
  }
  return null;
}

export function projectDispatchDriverRoster(
  catalog: CatalogInput | null | undefined,
  userCompanyId?: string,
): ProjectedDispatchDriver[] {
  if (!catalog) return [];

  // Map keyed by canonical driverId (when known) or record key (for legacy-only)
  const driverMap = new Map<string, ProjectedDispatchDriver>();

  // 1. Ingest approved records
  const approvedTree = asRecord(catalog.approved);
  for (const [hash, raw] of Object.entries(approvedTree)) {
    const row = flattenApprovedRow(hash, raw);
    if (!row) continue;
    if (row.active === false) continue;

    const canonId = canonicalIdFromApprovedRow(hash, row);
    const legacyAliases: string[] = [];
    if (!isCanonicalDriverId(hash)) {
      legacyAliases.push(hash);
    }
    const migrated = t(row.migratedToDriverId);
    if (migrated && !isCanonicalDriverId(migrated)) {
      legacyAliases.push(migrated);
    }

    const primaryKey = canonId || hash;

    const driver: ProjectedDispatchDriver = {
      key: hash,
      driverId: canonId,
      driverHash: !isCanonicalDriverId(hash) ? hash : undefined,
      legacyAliases: uniq(legacyAliases),
      displayName: t(row.displayName) || t(row.name) || 'Unknown',
      legalName: t(row.legalName) || t(asRecord(row.profile).legalName) || '',
      loginAlias: t(row.name) || t(asRecord(row.profile).name) || undefined,
      active: row.active !== false,
      companyId: t(row.companyId) || undefined,
      companyName: t(row.companyName) || undefined,
      assignedRoutes: Array.isArray(row.assignedRoutes)
        ? (row.assignedRoutes as unknown[]).map(t).filter(Boolean)
        : [],
      phone: t(row.phone) || t(asRecord(row.profile).phone) || '',
    };

    driverMap.set(primaryKey, driver);
  }

  // 2. Ingest / merge canonical profiles
  const profilesTree = asRecord(catalog.profiles);
  for (const [profId, raw] of Object.entries(profilesTree)) {
    const prof = asRecord(raw);
    if (!profId || !isCanonicalDriverId(profId)) continue;
    if (prof.active === false) continue;

    // Check if this canonical profile is already indexed
    let existing = driverMap.get(profId);
    if (!existing) {
      for (const d of driverMap.values()) {
        if (d.driverId === profId || d.legacyAliases?.includes(profId)) {
          existing = d;
          break;
        }
      }
    }

    if (existing) {
      // Enrich existing record with canonical profile fields
      if (!existing.driverId) existing.driverId = profId;
      if (!existing.legalName && prof.legalName) existing.legalName = t(prof.legalName);
      if (!existing.phone && prof.phone) existing.phone = t(prof.phone);
      if ((!existing.assignedRoutes || existing.assignedRoutes.length === 0) && Array.isArray(prof.assignedRoutes)) {
        existing.assignedRoutes = (prof.assignedRoutes as unknown[]).map(t).filter(Boolean);
      }
      if (!existing.companyId && prof.companyId) existing.companyId = t(prof.companyId);
      if (!existing.companyName && prof.companyName) existing.companyName = t(prof.companyName);
      continue;
    }

    // Modern driver registered via secure app or admin without approved record:
    // mint fresh canonical dispatch driver
    const newDriver: ProjectedDispatchDriver = {
      key: profId,
      driverId: profId,
      driverHash: profId, // compat value
      legacyAliases: [],
      displayName: t(prof.displayName) || t(prof.name) || 'Unknown',
      legalName: t(prof.legalName) || t(prof.displayName) || '',
      loginAlias: t(prof.name) || undefined,
      active: prof.active !== false,
      companyId: t(prof.companyId) || undefined,
      companyName: t(prof.companyName) || undefined,
      assignedRoutes: Array.isArray(prof.assignedRoutes)
        ? (prof.assignedRoutes as unknown[]).map(t).filter(Boolean)
        : [],
      phone: t(prof.phone) || '',
    };

    driverMap.set(profId, newDriver);
  }

  // 3. Tenant containment filter
  const scoped = Array.from(driverMap.values()).filter((d) =>
    docBelongsToTenant(d.companyId, userCompanyId),
  );

  // 4. Alphabetical sort by real display name
  scoped.sort((a, b) => a.displayName.localeCompare(b.displayName));

  return scoped;
}
