import * as https from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { SSO_SESSION_APP_CLAIM, SSO_SESSION_APP_EQUIPMENT } from '@tester3x/wellbuilt-contracts';
import { resolveSubject, SHIFT_AUTHORITY_OPTIONS } from './shiftAuthorityCallables';
import { isPeriodId, shiftAuthorityPath, shiftDayPath } from './shiftAuthority';
import { assertExpectedOwner, assertLedgerOwner, emptyLedger, parseCompletion,
  recordCompletion, selectDvirEntry, type DvirLedger, type DvirSubject } from './dvirCompletion';

const OWNER_KEYS = ['expectedDriverId', 'expectedCompanyId'];
const db = () => admin.firestore();
const ledgerRef = (driverId: string, shiftId: string) =>
  db().doc(`driver_dvir_completions/${driverId}/shifts/${shiftId}`);

function payload(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || Object.keys(raw).some(k => !keys.includes(k))) {
    throw new https.HttpsError('invalid-argument', 'invalid_dvir_request');
  }
  const data = raw as Record<string, unknown>;
  if (!isPeriodId(data.shiftId)) throw new https.HttpsError('invalid-argument', 'invalid_dvir_shift');
  return data;
}

async function subject(request: https.CallableRequest, data: Record<string, unknown>, equipment: boolean) {
  const who = await resolveSubject(request);
  if (equipment && request.auth?.token[SSO_SESSION_APP_CLAIM] !== SSO_SESSION_APP_EQUIPMENT) {
    throw new https.HttpsError('permission-denied', 'equipment_session_required');
  }
  try { assertExpectedOwner(data, who); }
  catch { throw new https.HttpsError('permission-denied', 'dvir_owner_changed'); }
  return who;
}

/** Existence and ownership come from server-authored shift history, not the date-shaped ID. */
async function requireOwnedShift(who: DvirSubject, shiftId: string): Promise<void> {
  const [authority, day] = await Promise.all([
    db().doc(shiftAuthorityPath(who.driverId)).get(),
    db().doc(shiftDayPath(who.driverId, shiftId.slice(0, 10))).get(),
  ]);
  const a = authority.data();
  const d = day.data();
  const owned = (r: FirebaseFirestore.DocumentData | undefined) =>
    r?.driverId === who.driverId && r?.companyId === who.companyId;
  const authorityMatches = owned(a) && a?.initialized === true
    && (a?.openPeriodId === shiftId || a?.lastClosedPeriodId === shiftId);
  const historyMatches = owned(d) && Array.isArray(d?.events)
    && d.events.some((event: { type?: string; shiftId?: string }) =>
      (event.type === 'login' || event.type === 'logout') && event.shiftId === shiftId);
  if (!authorityMatches && !historyMatches) {
    const recovered = (await ledgerRef(who.driverId, shiftId).get()).data();
    if (recovered?.origin === 'legacy_local_recovery' && owned(recovered) && recovered.shiftId === shiftId) return;
    throw new https.HttpsError('permission-denied', 'dvir_shift_not_owned');
  }
}

function checked(raw: FirebaseFirestore.DocumentData | undefined, who: DvirSubject, shiftId: string): DvirLedger {
  if (!raw) return emptyLedger(who, shiftId);
  const ledger = raw as DvirLedger;
  try { assertLedgerOwner(ledger, who, shiftId); }
  catch { throw new https.HttpsError('permission-denied', 'dvir_ledger_owner_mismatch'); }
  return ledger;
}

export const recordDriverDvirCompletion = https.onCall(SHIFT_AUTHORITY_OPTIONS, async request => {
  const data = payload(request.data, [...OWNER_KEYS, 'shiftId', 'inspectionId', 'phase', 'completedAt', 'reportDigest']);
  const who = await subject(request, data, true);
  const shiftId = data.shiftId as string;
  let completion;
  try { completion = parseCompletion(data, Date.now()); }
  catch { throw new https.HttpsError('invalid-argument', 'invalid_dvir_completion'); }
  await requireOwnedShift(who, shiftId);
  const ref = ledgerRef(who.driverId, shiftId);
  return db().runTransaction(async tx => {
    const snap = await tx.get(ref);
    const old = checked(snap.data(), who, shiftId);
    let next;
    try { next = recordCompletion(old, completion); }
    catch { throw new https.HttpsError('already-exists', 'dvir_completion_conflict'); }
    if (next !== old) tx.set(ref, { ...next, updatedAt: FieldValue.serverTimestamp() });
    return { protocolVersion: 1, ...next, created: next !== old };
  });
});

/** Register an existing Post-Trip draft without certifying any inspection. */
export const registerDriverDvirPostTrip = https.onCall(SHIFT_AUTHORITY_OPTIONS, async request => {
  const data = payload(request.data, [...OWNER_KEYS, 'shiftId']);
  const who = await subject(request, data, true);
  const shiftId = data.shiftId as string;
  let origin: 'shift_authority' | 'legacy_local_recovery' = 'shift_authority';
  try { await requireOwnedShift(who, shiftId); }
  catch (error) {
    if (!(error instanceof https.HttpsError) || error.message !== 'dvir_shift_not_owned') throw error;
    // Older app versions could create LOCAL shifts without server claims. A
    // recovery obligation is not a retroactive shift claim or a completion.
    // Only an older period under this active canonical driver's current shift
    // can enter this explicitly labeled lane; current/future periods cannot.
    const a = (await db().doc(shiftAuthorityPath(who.driverId)).get()).data();
    if (a?.driverId !== who.driverId || a?.companyId !== who.companyId || a?.initialized !== true
        || !isPeriodId(a.openPeriodId) || shiftId >= a.openPeriodId) throw error;
    origin = 'legacy_local_recovery';
  }
  const ref = ledgerRef(who.driverId, shiftId);
  await db().runTransaction(async tx => {
    const snap = await tx.get(ref);
    const old = checked(snap.data(), who, shiftId);
    if (!old.postTrip) tx.set(ref, { ...old, origin: old.origin ?? origin, postTripPending: true,
      postTripStarted: true, updatedAt: FieldValue.serverTimestamp() });
  });
  return { protocolVersion: 1, registered: true };
});

export const resolveDriverDvirStatus = https.onCall(SHIFT_AUTHORITY_OPTIONS, async request => {
  const data = payload(request.data, [...OWNER_KEYS, 'shiftId']);
  const who = await subject(request, data, false);
  const shiftId = data.shiftId as string;
  await requireOwnedShift(who, shiftId);
  const snap = await ledgerRef(who.driverId, shiftId).get();
  return { protocolVersion: 1, present: snap.exists, ...checked(snap.data(), who, shiftId) };
});

export const resolveEquipmentDvirEntry = https.onCall(SHIFT_AUTHORITY_OPTIONS, async request => {
  const data = payload(request.data, [...OWNER_KEYS, 'shiftId', 'phase']);
  const who = await subject(request, data, true);
  if (data.phase !== 'pre_trip' && data.phase !== 'post_trip') {
    throw new https.HttpsError('invalid-argument', 'invalid_dvir_phase');
  }
  const shiftId = data.shiftId as string;
  await requireOwnedShift(who, shiftId);
  const pending = await db().collection(`driver_dvir_completions/${who.driverId}/shifts`)
    .where('postTripPending', '==', true).get();
  const result = selectDvirEntry(pending.docs.map(d => d.data() as DvirLedger), who,
    { shiftId, phase: data.phase });
  return { protocolVersion: 1, ...who, ...result };
});
