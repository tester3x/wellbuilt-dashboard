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
import { canonicalWellKey } from './operational/emergencyEstimationHold';
import { requireManageDrivers, requireRegisteredDashboardUser } from './adminAuth';
import {
  callerCanViewGlobalWellPool,
  pickAllowlisted,
  projectDashboardCatalog,
  WELL_HISTORY_ALLOWLIST,
} from './dashboardCatalogProjection';

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

/** Well pool for any registered Dashboard user (home / mobile / well / dispatch). */
export const adminGetWellPool = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const caller = await requireRegisteredDashboardUser(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );
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
    const [wellSnap, outgoingSnap, wellsSnap] = await Promise.all([
      rtdb.ref('well_config').once('value'),
      rtdb.ref('packets/outgoing').once('value'),
      rtdb.ref('emergencyHolds').once('value'),
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
      // Merge the emergency estimation hold onto each projected status row, so
      // the client can freeze a well without being handed the whole wells node.
      // The hold carries the pull it was taken against; the client honours it
      // only while that is still the row's latest pull.
      wellStatus: attachEstimationHolds(
        full.wellStatus,
        wellsSnap.exists() ? (wellsSnap.val() as Record<string, unknown>) : {},
      ),
      counts: { wellConfig: full.counts.wellConfig, wellStatus: full.counts.wellStatus },
    };
  },
);

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Copy the emergency hold onto the matching projected status row.
 *
 * Joined on the canonical well key, not the raw name, so a legacy "Gabriel1"
 * status row still finds the hold taken against "Gabriel 1".
 *
 * Only the two fields a consumer needs in order to decide whether to freeze —
 * who took the hold and why is audit material, not display material, and stays
 * in the database.
 */
export function attachEstimationHolds(
  wellStatus: Record<string, Record<string, unknown>>,
  holdRoot: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const byKey = new Map<string, Record<string, unknown>>();
  for (const [key, val] of Object.entries(holdRoot)) byKey.set(canonicalWellKey(key), asRecord(val));

  const out: Record<string, Record<string, unknown>> = {};
  for (const [wellName, row] of Object.entries(wellStatus)) {
    const hold = byKey.get(canonicalWellKey(wellName)) ?? {};
    out[wellName] = hold.active === true && typeof hold.heldAtPullUTC === 'string'
      ? { ...row, estimationHoldActive: true, estimationHeldAtPullUTC: hold.heldAtPullUTC }
      : row;
  }
  return out;
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
