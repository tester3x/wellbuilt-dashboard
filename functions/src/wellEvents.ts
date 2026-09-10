/**
 * recordWellEvent — governed, authenticated callable to record an operational
 * well event (currently: hot_oiler_washout). This is the ONLY sanctioned write
 * path for the event that later anchors a washout recovery window.
 *
 * IMPLEMENTED + tested (contract validation), but INTENTIONALLY NOT re-exported
 * from index.ts and NOT wired into calculateAFR: there is no client event
 * producer yet, and washout-window behavior stays gated until one exists. When
 * the producer lands: re-export this from index.ts and deploy via
 * `functions:dashboard:recordWellEvent`.
 *
 * Guarantees: authenticated + company-scoped (requireManageDrivers); canonical
 * companyId/wellId (never the display wellName); idempotent by eventId
 * (create-if-absent); server-stamped record time + recorder identity; no direct
 * client write, no weakened rule.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireManageDrivers } from './security/adminAuth';
import { validateAndBuildWellEvent, type WellEventInput } from './afr/wellEventContract';

export const recordWellEvent = httpsV2.onCall(
  { timeoutSeconds: 20, memory: '256MiB' },
  async (request) => {
    const caller = await requireManageDrivers(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );
    const decision = validateAndBuildWellEvent(
      (request.data || {}) as WellEventInput,
      { uid: caller.uid, companyId: caller.companyId, isPlatformAdmin: caller.isPlatformAdmin },
      Date.now(),
    );
    if (!decision.ok) {
      throw new httpsV2.HttpsError(decision.code, decision.reason);
    }

    // Idempotent create-if-absent keyed by eventId.
    const ref = admin.database().ref(decision.path);
    const txn = await ref.transaction((existing) => (existing ? undefined : decision.record));
    const alreadyExists = !txn.committed && txn.snapshot.exists();

    return {
      ok: true,
      eventId: decision.record.eventId,
      companyId: decision.record.companyId,
      wellId: decision.record.wellId,
      alreadyExists,
      serverRecordedAtUtc: decision.record.serverRecordedAtUtc,
    };
  },
);
