/**
 * recordWellEvent — governed, authenticated callable to record an operational
 * well event (currently: hot_oiler_washout). The ONLY sanctioned write path for
 * the event that anchors a washout recovery window.
 *
 * IMPLEMENTED + tested (contract), but INTENTIONALLY NOT re-exported from
 * index.ts and NOT wired to calculateAFR: there is no client event producer yet
 * and washout-window behavior stays gated until one exists. When the producer
 * lands: re-export here and deploy via `functions:dashboard:recordWellEvent`.
 *
 * Producer/auth mapping:
 *   - WB-M FIELD DRIVER: requireSecureDriver (SSO token kind:'driver' →
 *     canonical driverId + companyId). A field driver is NOT a manager, so
 *     requireManageDrivers is deliberately NOT used for them.
 *   - DASHBOARD manager/dispatcher: requireManageDrivers (company-scoped) or a
 *     platform admin (cross-company).
 * Both prove company membership (from the token / caller), well existence
 * (companyWells/{companyId}/{wellId}), and the server resolves + persists the
 * company IANA timezone (companies/{companyId}.timezone) — never hardcoded, no
 * weakened rule, no direct client write.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireSecureDriver } from './security/requireDriverAuth';
import { requireManageDrivers } from './security/adminAuth';
import {
  validateAndBuildWellEvent,
  reconcileWellEventIdempotency,
  type WellEventInput,
  type EventCaller,
} from './afr/wellEventContract';

async function resolveEventCaller(request: httpsV2.CallableRequest<unknown>): Promise<EventCaller> {
  // Prefer a field-driver session (WB-M); fall back to a dashboard manager.
  if (request.auth?.token?.kind === 'driver') {
    const d = await requireSecureDriver(request);
    return { uid: d.driverId, companyId: d.companyId, isPlatformAdmin: false, role: 'driver' };
  }
  const m = await requireManageDrivers(request.auth?.uid, request.auth?.token as Record<string, unknown> | undefined);
  return { uid: m.uid, companyId: m.companyId, isPlatformAdmin: m.isPlatformAdmin, role: m.isPlatformAdmin ? 'platform' : 'manager' };
}

async function resolveCompanyTimeZone(companyId: string): Promise<string> {
  const snap = await admin.firestore().collection('companies').doc(companyId).get();
  const tz = snap.exists ? (snap.data()?.timezone || snap.data()?.ianaTimezone) : undefined;
  return typeof tz === 'string' ? tz : ''; // empty → contract rejects (timezone_unresolved)
}

async function wellExistsInCompany(companyId: string, wellId: string): Promise<boolean> {
  const snap = await admin.database().ref(`companyWells/${companyId}/${wellId}`).once('value');
  return snap.exists();
}

export const recordWellEvent = httpsV2.onCall(
  { timeoutSeconds: 20, memory: '256MiB' },
  async (request) => {
    const caller = await resolveEventCaller(request);
    const input = (request.data || {}) as WellEventInput;
    const companyId = String(input?.companyId || '').trim();
    const wellId = String(input?.wellId || '').trim();

    const [timeZone, wellExists] = await Promise.all([
      companyId ? resolveCompanyTimeZone(companyId) : Promise.resolve(''),
      companyId && wellId ? wellExistsInCompany(companyId, wellId) : Promise.resolve(false),
    ]);

    const decision = validateAndBuildWellEvent(input, caller, { serverNowMs: Date.now(), timeZone, wellExists });
    if (!decision.ok) throw new httpsV2.HttpsError(decision.code, decision.reason);

    // Idempotent create-if-absent; a reused eventId with a different payload is a
    // conflict, never a silent success.
    const ref = admin.database().ref(decision.path);
    const existing = (await ref.once('value')).val() as { payloadDigest?: string } | null;
    const outcome = reconcileWellEventIdempotency(existing, decision.record.payloadDigest);
    if (outcome.action === 'conflict') {
      throw new httpsV2.HttpsError('already-exists', outcome.reason);
    }
    if (outcome.action === 'create') {
      const txn = await ref.transaction((cur) => (cur ? undefined : decision.record));
      if (!txn.committed) {
        // Lost a race: re-reconcile against the winner.
        const winner = txn.snapshot.val() as { payloadDigest?: string } | null;
        if (reconcileWellEventIdempotency(winner, decision.record.payloadDigest).action === 'conflict') {
          throw new httpsV2.HttpsError('already-exists', 'event_id_reused_with_different_payload');
        }
      }
    }

    return {
      ok: true,
      eventId: decision.record.eventId,
      companyId, wellId,
      idempotent: outcome.action === 'idempotent',
      ianaTimezoneSnapshot: decision.record.ianaTimezoneSnapshot,
      serverRecordedAtUtc: decision.record.serverRecordedAtUtc,
    };
  },
);
