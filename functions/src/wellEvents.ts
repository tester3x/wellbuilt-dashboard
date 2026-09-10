/**
 * Governed washout-event callables — the ONLY sanctioned write path.
 *
 * IMPLEMENTED + emulator-tested, but wiring (re-export from index.ts) and deploy
 * happen only after emulator proof + a client producer. No weakened rule, no
 * direct client write.
 *
 * Producer/auth mapping (proven against datastore identity — well key = wellName,
 * companyId slug; no separate canonical wellId; company tz resolved server-side):
 *   - recordWellEvent: WB-M FIELD DRIVER via requireSecureDriver (token
 *     kind:'driver' → driverId + companyId; a driver is NOT a manager, so
 *     requireManageDrivers is deliberately not used for them), OR Dashboard
 *     manager/platform via requireManageDrivers.
 *   - voidWellEvent: MANAGER/platform only (never a field driver); auditable
 *     overlay — the original event is never deleted; a voided event never
 *     activates AFR; repeated void is idempotent.
 * Both prove company membership + well existence (companyWells/{companyId}/{wellKey})
 * and trigger the smallest targeted per-well recompute request (no broad scan).
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireSecureDriver } from './security/requireDriverAuth';
import { requireManageDrivers } from './security/adminAuth';
import {
  validateAndBuildWellEvent, reconcileWellEventIdempotency, decideVoidWellEvent,
  type WellEventInput, type EventCaller, type WellEventRecord,
} from './afr/wellEventContract';

async function resolveDriverCaller(request: httpsV2.CallableRequest<unknown>): Promise<EventCaller | null> {
  if (request.auth?.token?.kind !== 'driver') return null;
  const d = await requireSecureDriver(request);
  return { uid: d.driverId, companyId: d.companyId, isPlatformAdmin: false, role: 'driver' };
}
async function resolveManagerCaller(request: httpsV2.CallableRequest<unknown>): Promise<EventCaller> {
  const m = await requireManageDrivers(request.auth?.uid, request.auth?.token as Record<string, unknown> | undefined);
  return { uid: m.uid, companyId: m.companyId, isPlatformAdmin: m.isPlatformAdmin, role: m.isPlatformAdmin ? 'platform' : 'manager' };
}

async function resolveCompanyTimeZone(companyId: string): Promise<string> {
  // REQUIRE an explicit companies/{companyId}.timezone. State is not a reliable
  // timezone identity — no fallback; unresolved → contract rejects.
  const snap = await admin.firestore().collection('companies').doc(companyId).get();
  const data = snap.exists ? (snap.data() || {}) : {};
  const explicit = data.timezone || data.ianaTimezone;
  return typeof explicit === 'string' ? explicit : '';
}
async function wellExistsInCompany(companyId: string, wellKey: string): Promise<boolean> {
  return (await admin.database().ref(`companyWells/${companyId}/${wellKey}`).once('value')).exists();
}
/** Smallest targeted recompute signal for ONE well (no broad scan). Consumed by
 *  a future per-well recompute worker (out of scope this batch). */
async function requestWellRecompute(companyId: string, wellKey: string, reason: string, eventId: string): Promise<void> {
  await admin.database().ref(`well_recompute_requests/${companyId}/${wellKey}`).set({
    requestedAtUtc: Date.now(), reason, byEventId: eventId,
  });
}

export const recordWellEvent = httpsV2.onCall(
  { timeoutSeconds: 20, memory: '256MiB' },
  async (request) => {
    const caller = (await resolveDriverCaller(request)) || (await resolveManagerCaller(request));
    const input = (request.data || {}) as WellEventInput;
    const companyId = String(input?.companyId || '').trim();
    const wellKey = String(input?.wellKey || '').trim();

    const [timeZone, wellExists] = await Promise.all([
      companyId ? resolveCompanyTimeZone(companyId) : Promise.resolve(''),
      companyId && wellKey ? wellExistsInCompany(companyId, wellKey) : Promise.resolve(false),
    ]);

    const decision = validateAndBuildWellEvent(input, caller, { serverNowMs: Date.now(), timeZone, wellExists });
    if (!decision.ok) throw new httpsV2.HttpsError(decision.code, decision.reason);

    const ref = admin.database().ref(decision.path);
    const existing = (await ref.once('value')).val() as { payloadDigest?: string } | null;
    const outcome = reconcileWellEventIdempotency(existing, decision.record.payloadDigest);
    if (outcome.action === 'conflict') throw new httpsV2.HttpsError('already-exists', outcome.reason);
    if (outcome.action === 'create') {
      const txn = await ref.transaction((cur) => (cur ? undefined : decision.record));
      if (!txn.committed) {
        const winner = txn.snapshot.val() as { payloadDigest?: string } | null;
        if (reconcileWellEventIdempotency(winner, decision.record.payloadDigest).action === 'conflict') {
          throw new httpsV2.HttpsError('already-exists', 'event_id_reused_with_different_payload');
        }
      } else {
        await requestWellRecompute(companyId, wellKey, 'washout_event_recorded', decision.record.eventId);
      }
    }
    return {
      ok: true, eventId: decision.record.eventId, companyId, wellKey,
      idempotent: outcome.action === 'idempotent',
      ianaTimezoneSnapshot: decision.record.ianaTimezoneSnapshot,
      serverRecordedAtUtc: decision.record.serverRecordedAtUtc,
    };
  },
);

export const voidWellEvent = httpsV2.onCall(
  { timeoutSeconds: 20, memory: '256MiB' },
  async (request) => {
    // Void is a management action — never a field driver.
    const caller = await resolveManagerCaller(request);
    const data = (request.data || {}) as { companyId?: string; wellKey?: string; eventId?: string; reason?: string };
    const companyId = String(data.companyId || '').trim();
    const wellKey = String(data.wellKey || '').trim();
    const eventId = String(data.eventId || '').trim();
    if (!companyId || !wellKey || !eventId) throw new httpsV2.HttpsError('invalid-argument', 'companyId_wellKey_eventId_required');

    const ref = admin.database().ref(`well_events/${companyId}/${wellKey}/${eventId}`);
    const existing = (await ref.once('value')).val() as WellEventRecord | null;
    const decision = decideVoidWellEvent(existing, caller, { serverNowMs: Date.now(), reason: data.reason });
    if (!decision.ok) throw new httpsV2.HttpsError(decision.code, decision.reason);

    if (decision.action === 'void') {
      // Overlay only — original fields are preserved (auditable), never deleted.
      await ref.update({
        voidedAtUtc: decision.record.voidedAtUtc,
        voidedBy: decision.record.voidedBy,
        voidReason: decision.record.voidReason,
      });
      await requestWellRecompute(companyId, wellKey, 'washout_event_voided', eventId);
    }
    return { ok: true, eventId, companyId, wellKey, action: decision.action };
  },
);
