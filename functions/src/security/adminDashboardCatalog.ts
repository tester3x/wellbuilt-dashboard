/**
 * Admin-SDK catalog reads for Dashboard. Live hosting still parent-gets
 * RTDB well_config / drivers/approved / users, which default-deny parents
 * reject. This callable is the recovery read path.
 *
 * Returns an explicit UI allowlist, scoped to the caller:
 * platform administrator → all companies; company staff → caller.companyId only.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireManageDrivers } from './adminAuth';
import { projectDashboardCatalog } from './dashboardCatalogProjection';

export const adminGetDashboardCatalog = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const caller = await requireManageDrivers(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );

    const rtdb = admin.database();
    const [approvedSnap, usersSnap, wellSnap] = await Promise.all([
      rtdb.ref('drivers/approved').once('value'),
      rtdb.ref('users').once('value'),
      rtdb.ref('well_config').once('value'),
    ]);

    const projected = projectDashboardCatalog({
      approved: approvedSnap.exists() ? approvedSnap.val() : {},
      users: usersSnap.exists() ? usersSnap.val() : {},
      wellConfig: wellSnap.exists() ? wellSnap.val() : {},
      caller,
    });

    return {
      ok: true as const,
      ...projected,
    };
  },
);
