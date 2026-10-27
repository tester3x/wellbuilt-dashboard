import type { FreshWaterState } from './operational/freshWaterSupplyCore';
/**
 * Admin-SDK catalog reads for Dashboard. Live hosting still parent-gets
 * RTDB well_config / drivers/approved / users / packets/outgoing, which
 * default-deny parents reject. This callable is the recovery read path.
 *
 * Employees/users/pending: company-scoped (platform = all).
 * wellConfig/wellStatus: canViewGlobalWellPool (platform + liquid-gold).
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import {
  requireTrustedCompanyCapability,
  TRUSTED_CAPABILITY_MANAGE_DRIVERS,
} from './trustedStaffAuthority';
import { staffWriteDispatchAccessFromTrusted } from './operational/staffWriteDispatch';
import { requireRegisteredDashboardUser, type DashboardCaller } from './adminAuth';
import {
  callerCanViewGlobalWellPool,
  pickAllowlisted,
  projectDashboardCatalog,
  projectWellStatus,
  WELL_CONFIG_ALLOWLIST,
  WELL_STATUS_ALLOWLIST,
  WELL_HISTORY_ALLOWLIST,
} from './dashboardCatalogProjection';
import { projectWellPerformance, wellKeyFromName } from './operational/selectWellPerformance';
import { requestedAdminWellName } from './operational/staffWellPerformanceRequest';
import { DEMO_COMPANY_ID } from '../liveDemo/runtime';

function trustedCatalogCaller(access: { uid: string; companyId: string; isPlatformAdmin: false }): DashboardCaller {
  return {
    uid: access.uid,
    companyId: access.companyId,
    roles: [],
    caps: [TRUSTED_CAPABILITY_MANAGE_DRIVERS],
    isPlatformAdmin: false,
  };
}

async function requireTrustedCatalogCaller(authUid: string | undefined): Promise<DashboardCaller> {
  const trusted = await requireTrustedCompanyCapability(authUid, TRUSTED_CAPABILITY_MANAGE_DRIVERS);
  const access = staffWriteDispatchAccessFromTrusted(trusted);
  if (!access.ok) {
    throw new httpsV2.HttpsError(
      access.reason === 'unauthenticated' ? 'unauthenticated' : 'permission-denied',
      access.reason,
    );
  }
  return trustedCatalogCaller(access);
}

export const adminGetDashboardCatalog = httpsV2.onCall(
  { timeoutSeconds: 60, memory: '512MiB', enforceAppCheck: false },
  async (request) => {
    const caller = await requireTrustedCatalogCaller(request.auth?.uid);

    const rtdb = admin.database();
    const [approvedSnap, profilesSnap, usersSnap, wellSnap, pendingSnap, outgoingSnap] = await Promise.all([
      rtdb.ref('drivers/approved').once('value'),
      rtdb.ref('drivers/profiles').once('value'),
      rtdb.ref('users').once('value'),
      rtdb.ref('well_config').once('value'),
      rtdb.ref('drivers/pending').once('value'),
      rtdb.ref('packets/outgoing').once('value'),
    ]);

    const projected = projectDashboardCatalog({
      approved: approvedSnap.exists() ? approvedSnap.val() : {},
      profiles: profilesSnap.exists() ? profilesSnap.val() : {},
      users: usersSnap.exists() ? usersSnap.val() : {},
      wellConfig: wellSnap.exists() ? wellSnap.val() : {},
      pending: pendingSnap.exists() ? pendingSnap.val() : {},
      outgoing: outgoingSnap.exists() ? outgoingSnap.val() : {},
      caller,
    });

    return {
      ok: true as const,
      ...projected,
    };
  },
);

/** Approved secure identities for the demo tenant. Legacy simulator stubs are excluded. */
export const adminGetDemoDriverRoster = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const sharedDemoViewer = request.auth?.uid === 'wellbuilt-demo-shared-viewer'
      && request.auth.token.staffCompanyId === DEMO_COMPANY_ID
      && request.auth.token.staffRole === 'demo_viewer'
      && request.auth.token.isDemo === true;
    if (!sharedDemoViewer) {
      const caller = await requireTrustedCatalogCaller(request.auth?.uid);
      if (caller.companyId !== DEMO_COMPANY_ID) {
        throw new httpsV2.HttpsError('permission-denied', 'demo_company_scope_required');
      }
    }
    const snap = await admin.database().ref('drivers/profiles').once('value');
    const profiles = (snap.val() || {}) as Record<string, Record<string, unknown>>;
    const candidates = Object.entries(profiles).filter(([id, profile]) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
      && profile?.companyId === DEMO_COMPANY_ID
      && profile?.active !== false
      && Array.isArray(profile?.roles) && profile.roles.includes('driver'));
    const entries = await Promise.all(candidates.map(async ([id, profile]) => {
      const credential = await admin.firestore().collection('driver_credentials').doc(id).get();
      if (!credential.exists || credential.get('active') === false) return null;
      return [id, {
        driverId: id,
        companyId: DEMO_COMPANY_ID,
        displayName: String(profile.displayName || profile.legalName || ''),
        legalName: String(profile.legalName || profile.displayName || ''),
        assignedRoutes: Array.isArray(profile.assignedRoutes) ? profile.assignedRoutes : [],
        shiftPlan: profile.shiftPlan && typeof profile.shiftPlan === 'object' ? profile.shiftPlan : {},
        usualShift: profile.usualShift === 'day' || profile.usualShift === 'night' ? profile.usualShift : null,
        weeklyDaysOff: Array.isArray(profile.weeklyDaysOff) ? profile.weeklyDaysOff : [],
        active: true,
        isDemo: true,
      }] as const;
    }));
    return { ok: true as const, profiles: Object.fromEntries(entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null)) };
  },
);

/** Well pool for any registered Dashboard user (home / mobile / well / dispatch). */
export const adminGetWellPool = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const sharedDemoViewer = request.auth?.uid === 'wellbuilt-demo-shared-viewer'
      && request.auth.token.staffCompanyId === DEMO_COMPANY_ID
      && request.auth.token.staffRole === 'demo_viewer'
      && request.auth.token.isDemo === true;
    const requestedCompany = typeof request.data?.companyId === 'string' ? request.data.companyId : '';
    if (sharedDemoViewer) {
      if (requestedCompany && requestedCompany !== DEMO_COMPANY_ID) {
        throw new httpsV2.HttpsError('permission-denied', 'demo_company_scope_required');
      }
      return demoCompanyWellPool();
    }
    if (requestedCompany === DEMO_COMPANY_ID) {
      try {
        const staff = await requireTrustedCatalogCaller(request.auth?.uid);
        if (staff.companyId === DEMO_COMPANY_ID) return demoCompanyWellPool();
      } catch { /* Platform readers use the registered-user path below. */ }
      const reader = await requireRegisteredDashboardUser(request.auth?.uid, request.auth?.token);
      if (reader.isPlatformAdmin !== true) {
        throw new httpsV2.HttpsError('permission-denied', 'demo_company_scope_required');
      }
      return demoCompanyWellPool();
    }
    const caller = await requireTrustedCatalogCaller(request.auth?.uid);
    if (caller.companyId === DEMO_COMPANY_ID) return demoCompanyWellPool();
    if (requestedCompany && requestedCompany !== caller.companyId
      && !(caller.companyId === 'liquid-gold' && requestedCompany === 'liquid-gold')) {
      return { ok: true as const, canViewWellPool: false,
        wellConfig: {}, wellStatus: {}, counts: { wellConfig: 0, wellStatus: 0 } };
    }
    const projected = projectDashboardCatalog({
      approved: {},
      users: {},
      wellConfig: {},
      outgoing: {},
      caller,
    });
    if (!projected.canViewWellPool) {
      return {
        ok: true as const,
        canViewWellPool: false,
        wellConfig: {},
        wellStatus: {},
        counts: { wellConfig: 0, wellStatus: 0 },
      };
    }
    const rtdb = admin.database();
    const [wellSnap, outgoingSnap] = await Promise.all([
      rtdb.ref('well_config').once('value'),
      rtdb.ref('packets/outgoing').once('value'),
    ]);
    const full = projectDashboardCatalog({
      approved: {},
      users: {},
      wellConfig: wellSnap.exists() ? wellSnap.val() : {},
      outgoing: outgoingSnap.exists() ? outgoingSnap.val() : {},
      caller,
    });
    const inventory = (await rtdb.ref('fresh_water_supply/'+caller.companyId).once('value')).val() || {};
    for (const [key, cfg] of Object.entries(full.wellConfig)) {
      const c=cfg as Record<string, unknown>;
      if (c.routeType !== 'freshwater' || c.companyId !== caller.companyId) continue;
      const state=inventory[String(c.inventoryGroupId)] as FreshWaterState | undefined;
      full.wellStatus[key] = { inventoryLevelFeet: state?.levelFeet ?? null,
        isDown: state?.isDown === true, inventoryAsOfUTC: state?.asOfUTC ?? null, inventoryDailyBbl: state?.dailyUseBbl ?? null };
    }
    return {
      ok: true as const,
      canViewWellPool: true,
      wellConfig: full.wellConfig,
      wellStatus: full.wellStatus,
      counts: { wellConfig: full.counts.wellConfig, wellStatus: full.counts.wellStatus },
    };
  },
);

async function demoCompanyWellPool() {
  const rtdb = admin.database();
  const [wellSnap, outgoingSnap] = await Promise.all([
    rtdb.ref('well_config').once('value'),
    rtdb.ref('packets/outgoing').orderByChild('companyId').equalTo(DEMO_COMPANY_ID).once('value'),
  ]);
  return projectDemoCompanyWellPool(wellSnap.val(), outgoingSnap.val());
}

export function projectDemoCompanyWellPool(rawConfig: unknown, rawOutgoing: unknown) {
  const rawWells = asRecord(rawConfig);
  const wellConfig: Record<string, Record<string, unknown>> = {};
  for (const [name, raw] of Object.entries(rawWells)) {
    const config = asRecord(raw);
    if (config.companyId === DEMO_COMPANY_ID && config.isDemo === true) {
      wellConfig[name] = pickAllowlisted(config, WELL_CONFIG_ALLOWLIST);
    }
  }
  const ownOutgoing = Object.fromEntries(Object.entries(asRecord(rawOutgoing))
    .filter(([, value]) => asRecord(value).companyId === DEMO_COMPANY_ID));
  const projected = projectWellStatus(ownOutgoing);
  const wellStatus: Record<string, Record<string, unknown>> = {};
  for (const [name, status] of Object.entries(projected)) {
    if (name in wellConfig && status.companyId === DEMO_COMPANY_ID) {
      wellStatus[name] = pickAllowlisted(status, WELL_STATUS_ALLOWLIST);
    }
  }
  return { ok: true as const, canViewWellPool: true,
    wellConfig, wellStatus,
    counts: { wellConfig: Object.keys(wellConfig).length, wellStatus: Object.keys(wellStatus).length } };
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export const adminGetWellHistory = httpsV2.onCall(
  { timeoutSeconds: 60, memory: '512MiB', enforceAppCheck: false },
  async (request) => {
    const caller = await requireTrustedCatalogCaller(request.auth?.uid);
    if (!callerCanViewGlobalWellPool(caller)) {
      throw new httpsV2.HttpsError('permission-denied', 'Caller cannot view the global well pool');
    }
    const wellName = typeof request.data?.wellName === 'string' ? request.data.wellName.trim() : '';
    if (!wellName) throw new httpsV2.HttpsError('invalid-argument', 'wellName required');
    const clean = wellName.toLowerCase().replace(/\s/g, '');
    const snap = await admin.database().ref('packets/processed').once('value');
    const pulls: Record<string, unknown>[] = [];
    if (snap.exists()) {
      const tree = asRecord(snap.val());
      for (const [key, val] of Object.entries(tree)) {
        if (key.startsWith('edit_')) continue;
        const rec = asRecord(val);
        const recName = typeof rec.wellName === 'string' ? rec.wellName : '';
        if (recName.toLowerCase().replace(/\s/g, '') !== clean) continue;
        const picked = pickAllowlisted({ ...rec, packetId: rec.packetId || key }, WELL_HISTORY_ALLOWLIST);
        pulls.push(picked);
      }
    }
    pulls.sort((a, b) => {
      const at = Date.parse(String(a.dateTimeUTC || a.dateTime || '')) || 0;
      const bt = Date.parse(String(b.dateTimeUTC || b.dateTime || '')) || 0;
      return bt - at;
    });
    return { ok: true as const, wellName, pulls };
  },
);

export const adminGetWellPerformance = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const caller = await requireTrustedCatalogCaller(request.auth?.uid);
    if (!callerCanViewGlobalWellPool(caller)) {
      throw new httpsV2.HttpsError('permission-denied', 'Caller cannot view the global well pool');
    }
    const requested = requestedAdminWellName(request.data);
    if (requested) {
      const wellKey = wellKeyFromName(requested);
      const nodeSnap = await admin.database().ref(`performance/${wellKey}`).once('value');
      const projection = projectWellPerformance({
        requestedWellName: requested,
        node: nodeSnap.exists() ? nodeSnap.val() : null,
      });
      return {
        ok: true as const,
        wellName: projection.wellName,
        updated: projection.updated,
        rows: projection.rows,
      };
    }
    const snap = await admin.database().ref('performance').once('value');
    const rows: Record<string, { d: string; a: number; p: number }[]> = {};
    if (snap.exists()) {
      const tree = asRecord(snap.val());
      for (const [wellKey, val] of Object.entries(tree)) {
        const rec = asRecord(val);
        const rowNode = asRecord(rec.rows);
        const list: { d: string; a: number; p: number }[] = [];
        for (const row of Object.values(rowNode)) {
          const r = asRecord(row);
          if (typeof r.d === 'string' && typeof r.a === 'number' && typeof r.p === 'number') {
            list.push({ d: r.d, a: r.a, p: r.p });
          }
        }
        if (list.length) rows[wellKey] = list;
      }
    }
    return { ok: true as const, rows };
  },
);
