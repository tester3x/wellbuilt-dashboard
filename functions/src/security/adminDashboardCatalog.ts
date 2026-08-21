/**
 * Admin-SDK catalog reads for Dashboard. Live hosting still parent-gets
 * RTDB well_config / drivers/approved / users, which default-deny parents
 * reject. This callable is the recovery read path.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireManageDrivers } from './adminAuth';

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export const adminGetDashboardCatalog = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    await requireManageDrivers(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );

    const rtdb = admin.database();
    const [approvedSnap, usersSnap, wellSnap] = await Promise.all([
      rtdb.ref('drivers/approved').once('value'),
      rtdb.ref('users').once('value'),
      rtdb.ref('well_config').once('value'),
    ]);

    return {
      ok: true as const,
      approved: approvedSnap.exists() ? approvedSnap.val() : {},
      users: usersSnap.exists() ? usersSnap.val() : {},
      wellConfig: wellSnap.exists() ? wellSnap.val() : {},
      counts: {
        approved: approvedSnap.exists() ? Object.keys(asRecord(approvedSnap.val())).length : 0,
        users: usersSnap.exists() ? Object.keys(asRecord(usersSnap.val())).length : 0,
        wellConfig: wellSnap.exists() ? Object.keys(asRecord(wellSnap.val())).length : 0,
      },
    };
  },
);
