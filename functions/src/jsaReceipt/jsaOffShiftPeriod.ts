import * as admin from 'firebase-admin';
import * as https from 'firebase-functions/v2/https';
import { createHash } from 'crypto';
import { resolveSubject } from '../security/operational/shiftAuthorityCallables';
import { decideResolve, shiftAuthorityPath, type ShiftAuthorityRecord } from '../security/operational/shiftAuthority';
import { parseAuthPrincipal, requireAudience } from './jsaReceiptCore';
import type { JsaWorkPeriod } from './jsaWorkPeriod';

export const jsaOffShiftPeriod = https.onCall(async request => {
  const principal = parseAuthPrincipal({ uid: request.auth?.uid, claims: request.auth?.token });
  if (!principal.ok || !['wbt', 'jsa'].some(app => requireAudience(principal.value, app).ok)) {
    throw new https.HttpsError('permission-denied', 'Driver session required.');
  }
  const owner = await resolveSubject(request);
  if (owner.companyId !== principal.value.companyId || owner.driverId !== principal.value.driverId) {
    throw new https.HttpsError('permission-denied', 'Driver session changed.');
  }
  const { operation, periodId } = request.data || {};
  if (operation !== 'read' && (operation !== 'end' || typeof periodId !== 'string' || !/^[a-f0-9]{48}$/.test(periodId))) {
    throw new https.HttpsError('invalid-argument', 'Invalid JSA period request.');
  }
  const db = admin.firestore();
  const key = createHash('sha256').update(JSON.stringify([owner.companyId, owner.driverId])).digest('hex');
  const active = db.doc('jsa_active_work_periods/' + key);
  return db.runTransaction(async tx => {
    const authority = await tx.get(db.doc(shiftAuthorityPath(owner.driverId)));
    const shift = decideResolve((authority.data() || null) as ShiftAuthorityRecord | null, owner);
    const period = (await tx.get(active)).data() as JsaWorkPeriod | undefined;
    if (shift.state !== 'none' || period?.state !== 'open' || period.shiftId !== null
        || period.companyId !== owner.companyId || period.driverId !== owner.driverId) {
      if (operation === 'read') return { periodId: null };
      throw new https.HttpsError('failed-precondition', 'No open off-shift JSA.');
    }
    const completed = await tx.get(db.collection('jsa_governed_requests')
      .where('companyId', '==', owner.companyId)
      .where('driverId', '==', owner.driverId)
      .where('binding.jsaPeriodId', '==', period.id)
      .where('state', '==', 'completed').limit(1));
    if (completed.empty || (operation === 'end' && period.id !== periodId)) {
      if (operation === 'read') return { periodId: null };
      throw new https.HttpsError('failed-precondition', 'Off-shift JSA changed. Reopen the summary.');
    }
    if (operation === 'read') return { periodId: period.id };
    const finalized = { ...period, state: 'finalized', finalizedAtMs: Date.now(), finalizationReason: 'driver_ended_off_shift' };
    tx.set(active, finalized);
    tx.set(db.doc('jsa_work_periods/' + period.id), finalized);
    return { periodId: period.id, ended: true };
  });
});
