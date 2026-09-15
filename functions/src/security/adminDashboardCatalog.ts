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
import { requireManageDrivers, requireRegisteredDashboardUser, type DashboardCaller } from './adminAuth';
import {
  callerCanViewGlobalWellPool,
  pickAllowlisted,
  projectDashboardCatalog,
  WELL_HISTORY_ALLOWLIST,
} from './dashboardCatalogProjection';
import { projectWellPerformance, wellKeyFromName } from './operational/selectWellPerformance';
import { requestedAdminWellName } from './operational/staffWellPerformanceRequest';

export const adminGetDashboardCatalog = httpsV2.onCall(
  { timeoutSeconds: 60, memory: '512MiB', enforceAppCheck: false },
  async (request) => {
    const caller = await requireManageDrivers(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );

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

/**
 * Well-pool-SPECIFIC deny-by-default global-access gate.
 *
 * Deliberately NOT the shared `callerCanViewGlobalWellPool` (which also gates
 * adminGetDashboardCatalog / adminGetWellHistory / adminGetWellPerformance /
 * deletePull / staffWriteWellConfig and is intentionally left UNCHANGED by this
 * containment — see the audit for the full caller inventory). Global well-pool
 * access requires a server-authoritative PLATFORM administrator (unscoped admin/it,
 * i.e. `isPlatformAdmin === true`) who ALSO holds an explicit global-privilege
 * capability. It grants on NEITHER:
 *   - a bare missing companyId (a no-companyId non-admin is denied), NOR
 *   - Liquid Gold company membership (company NAME is never a grant), NOR
 *   - a company-scoped role — a tenant cannot self-escalate via company
 *     roleCapabilities because isPlatformAdmin requires the absence of a companyId.
 * Fails closed on any missing identity.
 */
export const GLOBAL_WELL_POOL_PRIVILEGES = ['viewAllCompanies', 'viewWellPool'] as const;
export function callerHasGlobalWellPoolAccess(
  caller: Pick<DashboardCaller, 'isPlatformAdmin' | 'caps'>,
): boolean {
  if (!caller || caller.isPlatformAdmin !== true) return false;
  const caps = Array.isArray(caller.caps) ? caller.caps : [];
  return GLOBAL_WELL_POOL_PRIVILEGES.some((p) => caps.includes(p));
}

/** Well pool — GLOBAL data, gated deny-by-default (see callerHasGlobalWellPoolAccess). */
export const adminGetWellPool = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const caller = await requireRegisteredDashboardUser(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );
    // CONTAINMENT: adminGetWellPool returns the GLOBAL well_config + packets/outgoing
    // pool. Deny by default — only a platform admin holding an explicit global
    // privilege is served. Every other persona (ordinary tenant admin/dispatcher/
    // viewer, Liquid Gold member, no-companyId non-admin) receives an IDENTICAL honest
    // empty result with no cross-tenant metadata. A safe tenant-scoped source does not
    // exist yet: packets/outgoing status rows carry no companyId, so a wellName-keyed
    // join would cross-associate same-named wells across tenants. We therefore do NOT
    // expose the global pool to scoped callers as a convenience fallback.
    if (!callerHasGlobalWellPoolAccess(caller)) {
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
    return {
      ok: true as const,
      canViewWellPool: true,
      wellConfig: full.wellConfig,
      wellStatus: full.wellStatus,
      counts: { wellConfig: full.counts.wellConfig, wellStatus: full.counts.wellStatus },
    };
  },
);

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export const adminGetWellHistory = httpsV2.onCall(
  { timeoutSeconds: 60, memory: '512MiB', enforceAppCheck: false },
  async (request) => {
    const caller = await requireRegisteredDashboardUser(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );
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
    const caller = await requireRegisteredDashboardUser(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );
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
