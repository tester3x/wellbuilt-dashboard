/**
 * Narrow WB-T well-config callable. One selected well, allowlisted fields only.
 * Does not return a WB-M catalog and does not use assignedRoutes browsing.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireSecureDriver } from '../requireDriverAuth';
import { evaluateWbtWellLookup } from './wbtWellConfigAuthorize';

export const resolveWbtWellConfig = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const driver = await requireSecureDriver(request, { allowLegacyHash: false });
    if (!driver.companyId) {
      throw new httpsV2.HttpsError('failed-precondition', 'company_required');
    }
    const data = (request.data || {}) as {
      wellConfigKey?: unknown;
      wellName?: unknown;
      wellId?: unknown;
    };
    const wellSnap = await admin.database().ref('well_config').once('value');
    const wellConfig = wellSnap.exists() ? (wellSnap.val() as Record<string, unknown>) : {};
    const decided = evaluateWbtWellLookup({
      wellConfigKey: data.wellConfigKey,
      wellName: data.wellName,
      wellId: data.wellId,
      companyId: driver.companyId,
      wellConfig,
    });
    if (!decided.ok) {
      const arg = new Set([
        'missing_well_identity',
        'invalid_wellConfigKey',
        'stale_well_binding',
        'ambiguous_well',
      ]);
      const denied = new Set(['cross_company_well']);
      if (denied.has(decided.reason)) {
        throw new httpsV2.HttpsError('permission-denied', decided.reason);
      }
      throw new httpsV2.HttpsError(
        arg.has(decided.reason) ? 'invalid-argument' : 'not-found',
        decided.reason,
      );
    }
    return {
      ok: true as const,
      wellConfigKey: decided.wellConfigKey,
      wellName: decided.wellName,
      wellId: decided.wellId,
      companyId: decided.companyId,
      config: decided.config,
    };
  },
);
