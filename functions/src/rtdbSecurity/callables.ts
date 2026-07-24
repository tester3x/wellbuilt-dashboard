/**
 * RTDB security containment callables — bridge anonymous field apps and
 * authenticated dashboard surfaces without custom-token auth (Phase 2).
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';

const db = admin.database();

const DEFAULT_ROLE_CAPABILITIES: Record<string, string[]> = {
  it: ['manageDrivers', 'viewAllCompanies'],
  admin: ['manageDrivers'],
  manager: ['manageDrivers'],
  dispatch: [],
  payroll: [],
  viewer: [],
  driver: [],
};

function resolveCapsForRole(
  role: string,
  overrides: Record<string, string[]>,
): string[] {
  return overrides[role] ?? DEFAULT_ROLE_CAPABILITIES[role] ?? [];
}

async function requireManageDrivers(authUid: string): Promise<Record<string, unknown>> {
  const snap = await db.ref(`users/${authUid}`).once('value');
  if (!snap.exists()) {
    throw new httpsV2.HttpsError('permission-denied', 'Caller is not a registered dashboard user');
  }
  const userData = snap.val() as Record<string, unknown>;
  const role = typeof userData.role === 'string' ? userData.role : '';
  const companyId = typeof userData.companyId === 'string' ? userData.companyId : '';

  let roleCaps: Record<string, string[]> = {};
  if (companyId) {
    try {
      const cSnap = await admin.firestore().collection('companies').doc(companyId).get();
      roleCaps = (cSnap.data()?.roleCapabilities || {}) as Record<string, string[]>;
    } catch {
      // best-effort
    }
  }
  const caps = resolveCapsForRole(role, roleCaps);
  if (!caps.includes('manageDrivers') && role !== 'it' && role !== 'admin') {
    throw new httpsV2.HttpsError('permission-denied', 'manageDrivers capability required');
  }
  return userData;
}

async function requireFieldDriverAdmin(passcodeHash: string): Promise<Record<string, unknown>> {
  if (!passcodeHash || !/^[a-f0-9]{64}$/.test(passcodeHash)) {
    throw new httpsV2.HttpsError('invalid-argument', 'passcodeHash must be a 64-char hex SHA-256 hash');
  }
  const snap = await db.ref(`drivers/approved/${passcodeHash}`).once('value');
  if (!snap.exists()) {
    throw new httpsV2.HttpsError('permission-denied', 'Driver not found');
  }
  const data = snap.val() as Record<string, unknown>;
  if (data.isAdmin !== true) {
    throw new httpsV2.HttpsError('permission-denied', 'Field driver admin flag required');
  }
  return data;
}

function sanitizeWellKey(wellName: string): string {
  return wellName.replace(/[.#$[\]]/g, '').trim();
}

// ---------------------------------------------------------------------------
// checkDriverRegistrationStatus — replaces full drivers/pending tree polling
// ---------------------------------------------------------------------------
export const checkDriverRegistrationStatus = httpsV2.onCall(
  { timeoutSeconds: 15, memory: '256MiB' },
  async (request) => {
    const { passcodeHash } = (request.data || {}) as { passcodeHash?: string };
    if (!passcodeHash || !/^[a-f0-9]{64}$/.test(passcodeHash)) {
      throw new httpsV2.HttpsError('invalid-argument', 'passcodeHash is required');
    }

    const approvedSnap = await db.ref(`drivers/approved/${passcodeHash}`).once('value');
    if (approvedSnap.exists()) {
      return { status: 'approved' as const };
    }

    const pendingSnap = await db.ref('drivers/pending')
      .orderByChild('passcodeHash')
      .equalTo(passcodeHash)
      .once('value');

    if (pendingSnap.exists()) {
      return { status: 'pending' as const };
    }

    return { status: 'rejected' as const };
  },
);

// ---------------------------------------------------------------------------
// enableRouteRecording — replaces anonymous well_config PATCH from WB-T
// ---------------------------------------------------------------------------
export const enableRouteRecording = httpsV2.onCall(
  { timeoutSeconds: 15, memory: '256MiB' },
  async (request) => {
    const { wellName, driverHash } = (request.data || {}) as {
      wellName?: string;
      driverHash?: string;
    };
    if (!wellName || typeof wellName !== 'string' || wellName.length > 120) {
      throw new httpsV2.HttpsError('invalid-argument', 'wellName is required');
    }
    const safeKey = sanitizeWellKey(wellName);
    if (!safeKey) {
      throw new httpsV2.HttpsError('invalid-argument', 'wellName sanitizes to empty key');
    }

    if (driverHash && /^[a-f0-9]{64}$/.test(driverHash)) {
      const driverSnap = await db.ref(`drivers/approved/${driverHash}`).once('value');
      if (!driverSnap.exists()) {
        throw new httpsV2.HttpsError('permission-denied', 'Unknown driver hash');
      }
    }

    await db.ref(`well_config/${safeKey}`).update({
      routeRecording: true,
      routeGroupWell: safeKey,
    });

    return { ok: true, wellKey: safeKey };
  },
);

// ---------------------------------------------------------------------------
// listDashboardUsers — replaces full users-tree read in DriversTab
// ---------------------------------------------------------------------------
export const listDashboardUsers = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB' },
  async (request) => {
    const auth = request.auth;
    if (!auth?.uid) {
      throw new httpsV2.HttpsError('unauthenticated', 'Must be signed in');
    }
    await requireManageDrivers(auth.uid);

    const usersSnap = await db.ref('users').once('value');
    const users: Array<Record<string, unknown>> = [];
    if (usersSnap.exists()) {
      usersSnap.forEach((child) => {
        const val = child.val() as Record<string, unknown>;
        if (!val?.role || val.role === 'driver') return;
        users.push({
          uid: child.key,
          email: val.email || '',
          displayName: val.displayName || val.email || 'Unknown',
          role: val.role,
          roles: Array.isArray(val.roles) ? val.roles : undefined,
          companyId: val.companyId || undefined,
          companyName: val.companyName || undefined,
          driverHash: val.driverHash || undefined,
        });
      });
    }
    users.sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)));
    return { users };
  },
);

// ---------------------------------------------------------------------------
// fieldDriverAdmin — WB-M manager screen (passcodeHash + isAdmin gate)
// ---------------------------------------------------------------------------
export const fieldDriverAdmin = httpsV2.onCall(
  { timeoutSeconds: 60, memory: '512MiB' },
  async (request) => {
    const { passcodeHash, action, payload } = (request.data || {}) as {
      passcodeHash?: string;
      action?: string;
      payload?: Record<string, unknown>;
    };
    if (!passcodeHash) {
      throw new httpsV2.HttpsError('invalid-argument', 'passcodeHash is required');
    }
    await requireFieldDriverAdmin(passcodeHash);

    switch (action) {
      case 'listPending': {
        const snap = await db.ref('drivers/pending').once('value');
        const pending: Array<Record<string, unknown>> = [];
        if (snap.exists()) {
          snap.forEach((child) => {
            const entry = child.val() as Record<string, unknown>;
            if (entry.status === 'approved' || entry.status === 'rejected') return;
            pending.push({ key: child.key, ...entry });
          });
        }
        pending.sort((a, b) => {
          const at = new Date(String(a.requestedAt || 0)).getTime();
          const bt = new Date(String(b.requestedAt || 0)).getTime();
          return bt - at;
        });
        return { pending };
      }

      case 'listApproved': {
        const snap = await db.ref('drivers/approved').once('value');
        const approved: Array<Record<string, unknown>> = [];
        if (snap.exists()) {
          snap.forEach((child) => {
            const node = child.val() as Record<string, unknown>;
            if (node.displayName) {
              approved.push({ key: child.key, ...node });
            } else {
              Object.entries(node).forEach(([deviceId, entry]) => {
                if (entry && typeof entry === 'object' && (entry as Record<string, unknown>).displayName) {
                  approved.push({
                    key: child.key,
                    _legacyDeviceId: deviceId,
                    ...(entry as Record<string, unknown>),
                  });
                }
              });
            }
          });
        }
        return { approved };
      }

      case 'approve': {
        const pendingKey = payload?.pendingKey as string | undefined;
        const hash = payload?.targetHash as string | undefined;
        const displayName = payload?.displayName as string | undefined;
        const role = (payload?.role as string | undefined) || 'user';
        if (!pendingKey || !hash || !displayName) {
          throw new httpsV2.HttpsError('invalid-argument', 'pendingKey, targetHash, displayName required');
        }
        const driverData: Record<string, unknown> = {
          displayName,
          approvedAt: Date.now(),
          active: true,
          isAdmin: role === 'admin',
          isViewer: role === 'viewer',
        };
        await db.ref(`drivers/approved/${hash}`).set(driverData);
        await db.ref(`drivers/pending/${pendingKey}`).remove();
        return { ok: true };
      }

      case 'reject': {
        const pendingKey = payload?.pendingKey as string | undefined;
        if (!pendingKey) {
          throw new httpsV2.HttpsError('invalid-argument', 'pendingKey required');
        }
        await db.ref(`drivers/pending/${pendingKey}`).remove();
        return { ok: true };
      }

      case 'listProduction': {
        const days = Math.min(Number(payload?.days) || 7, 90);
        const snap = await db.ref('production').once('value');
        const entries: Array<Record<string, unknown>> = [];
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        const cutoffStr = cutoff.toISOString().slice(0, 10);

        if (snap.exists()) {
          const data = snap.val() as Record<string, Record<string, unknown>>;
          for (const wellKey of Object.keys(data)) {
            const wellData = data[wellKey];
            const wellName = (wellData.wellName as string) || wellKey.replace(/_/g, ' ');
            for (const dateKey of Object.keys(wellData)) {
              if (dateKey === 'wellName' || dateKey === 'updated') continue;
              if (dateKey < cutoffStr) continue;
              const dayData = wellData[dateKey] as Record<string, unknown>;
              entries.push({
                wellKey,
                wellName,
                date: dateKey,
                afrBbls: dayData.a ?? 0,
                windowBbls: dayData.w ?? 0,
                overnightBbls: dayData.o ?? 0,
                pullCount: dayData.n ?? 0,
                updatedAt: dayData.u ?? '',
              });
            }
          }
        }
        entries.sort((a, b) => String(b.date).localeCompare(String(a.date)));
        return { entries };
      }

      case 'listSystemLogs': {
        const days = Math.min(Number(payload?.days) || 7, 30);
        const snap = await db.ref('logs/system').once('value');
        const logs: Array<Record<string, unknown>> = [];
        const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
        if (snap.exists()) {
          snap.forEach((child) => {
            const entry = child.val() as Record<string, unknown>;
            const ts = typeof entry.timestamp === 'number'
              ? entry.timestamp
              : new Date(String(entry.timestamp || 0)).getTime();
            if (ts >= cutoffMs) {
              logs.push({ id: child.key, ...entry });
            }
          });
        }
        logs.sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
        return { logs };
      }

      default:
        throw new httpsV2.HttpsError('invalid-argument', `Unknown action: ${action}`);
    }
  },
);