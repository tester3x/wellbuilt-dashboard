/**
 * Authenticated reference-data reads for field apps after default-deny.
 * Returns non-secret catalogs: app_registry slice, company public fields, job packages.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireSecureDriver } from '../requireDriverAuth';

export const getDriverReferenceBundle = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const data = (request.data || {}) as { driverHash?: string };
    if (data.driverHash != null) {
      throw new httpsV2.HttpsError('permission-denied', 'legacy_hash_rejected');
    }
    const driver = await requireSecureDriver(request);

    const fs = admin.firestore();
    const [apps, packages] = await Promise.all([
      fs.collection('app_registry').get(),
      fs.collection('job_packages').limit(50).get(),
    ]);

    let company: Record<string, unknown> | null = null;
    if (driver.companyId) {
      const c = await fs.collection('companies').doc(driver.companyId).get();
      if (c.exists) {
        const d = c.data() || {};
        // Public subset only
        company = {
          id: c.id,
          name: d.name,
          tier: d.tier,
          roleLabels: d.roleLabels,
        };
      }
    }

    // Driver profile (self)
    const prof = await admin.database().ref(`drivers/profiles/${driver.driverId}`).once('value');

    return {
      driverId: driver.driverId,
      companyId: driver.companyId || null,
      profile: prof.val() || null,
      company,
      appRegistry: apps.docs.map((d) => ({ id: d.id, ...d.data() })),
      jobPackages: packages.docs.map((d) => ({ id: d.id, name: d.data()?.name, ...d.data() })),
    };
  },
);

export type WellConfigRow = Record<string, unknown> & { wellName?: string; companyId?: string; route?: string };

/** Company + assignment scoped well config. Unscoped wells are omitted. */
export function selectAssignedWellConfig(input: {
  catalog: Record<string, WellConfigRow | null | undefined>;
  companyId: string;
  assignedRoutes?: unknown;
  assignedWells?: unknown;
}): Record<string, WellConfigRow> {
  const companyId = (input.companyId || '').trim();
  if (!companyId) return {};
  const wells = Array.isArray(input.assignedWells)
    ? input.assignedWells.map((w) => String(w).toLowerCase())
    : [];
  const routes = Array.isArray(input.assignedRoutes)
    ? input.assignedRoutes.map((r) => String(r).toLowerCase())
    : [];
  const out: Record<string, WellConfigRow> = {};
  for (const [wellName, raw] of Object.entries(input.catalog || {})) {
    if (!raw || typeof raw !== 'object') continue;
    const rowCompany = typeof raw.companyId === 'string' ? raw.companyId.trim() : '';
    if (!rowCompany || rowCompany !== companyId) continue;
    if (wells.length && !wells.includes(wellName.toLowerCase())) continue;
    const route = typeof raw.route === 'string' ? raw.route.toLowerCase() : '';
    if (routes.length && (!route || !routes.includes(route))) continue;
    out[wellName] = { ...raw, wellName, companyId };
  }
  return out;
}

export const getDriverWellConfig = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const data = (request.data || {}) as { driverHash?: string };
    if (data.driverHash != null) {
      throw new httpsV2.HttpsError('permission-denied', 'legacy_hash_rejected');
    }
    const driver = await requireSecureDriver(request);
    if (!driver.companyId) {
      throw new httpsV2.HttpsError('permission-denied', 'company_required');
    }
    const snap = await admin.database().ref('well_config').once('value');
    const catalog = (snap.val() || {}) as Record<string, WellConfigRow>;
    const wells = selectAssignedWellConfig({
      catalog,
      companyId: driver.companyId,
      assignedRoutes: driver.assignedRoutes,
      assignedWells: driver.assignedWells,
    });
    return { ok: true, companyId: driver.companyId, wells };
  },
);
