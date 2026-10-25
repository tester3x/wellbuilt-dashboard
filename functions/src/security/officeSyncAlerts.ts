import { createHash } from 'crypto';
import * as admin from 'firebase-admin';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { loadCanonicalDriverAuthority, productionCanonicalDriverReaders } from './canonicalDriverAuthority';
import { requireRegisteredDashboardUser } from './adminAuth';
import { requireTrustedCompanyCapability, TRUSTED_CAPABILITY_MANAGE_DRIVERS } from './trustedStaffAuthority';

export interface SyncAlertReport {
  operationId: string; kind: string; resourceId: string; state: 'open' | 'resolved';
  reason: 'rejected_update' | 'repeated_delivery_failure'; attempts: number; createdAtMs: number;
}
const KINDS = new Set(['invoiceCreate', 'invoiceStart', 'invoiceClose', 'dispatchCreate', 'dispatchAccept', 'dispatchResolve', 'dispatchStage', 'dispatchComplete', 'jsaStampLocations', 'jsaJobCoverage', 'ticket_submit', 'ticket_update', 'wb_pull', 'wb_edit', 'timeline_sync', 'phone_split', 'photo_upload', 'photo_metadata', 'photo_validation']);
export function parseSyncAlertReport(raw: unknown, now: number): SyncAlertReport {
  const x = raw as SyncAlertReport;
  const keys = ['operationId', 'kind', 'resourceId', 'state', 'reason', 'attempts', 'createdAtMs'];
  if (!x || typeof x !== 'object' || Array.isArray(x) || Object.keys(x).length !== keys.length || !keys.every(k => Object.prototype.hasOwnProperty.call(x, k))
    || ![x.operationId, x.resourceId].every(s => typeof s === 'string' && /^[A-Za-z0-9_:.\-]{1,300}$/.test(s))
    || !KINDS.has(x.kind) || !['open', 'resolved'].includes(x.state)
    || !['rejected_update', 'repeated_delivery_failure'].includes(x.reason)
    || !Number.isSafeInteger(x.attempts) || x.attempts < 1 || x.attempts > 1000000
    || !Number.isSafeInteger(x.createdAtMs) || x.createdAtMs <= 0 || x.createdAtMs > now
    || (x.state === 'open' && x.reason === 'repeated_delivery_failure' && (x.attempts < 5 || now - x.createdAtMs < 10 * 60000))) {
    throw new HttpsError('invalid-argument', 'invalid_sync_alert');
  }
  return x;
}
export function syncAlertId(company: string, driver: string, op: string): string {
  return createHash('sha256').update(JSON.stringify([company, driver, 'wbt', op])).digest('hex');
}
/** Resolution is permanent for an operation id: delayed retries cannot reopen it. */
export function syncAlertTransition(existing: { status?: string } | null, state: 'open' | 'resolved') {
  if (existing?.status === 'resolved') return 'unchanged';
  return state === 'resolved' ? 'resolved' : existing ? 'unchanged' : 'open';
}

export const reportDriverSyncAlert = onCall({ timeoutSeconds: 20, enforceAppCheck: false }, async request => {
  const claims = request.auth?.token;
  if (!request.auth?.uid || claims?.kind !== 'driver' || typeof claims.driverId !== 'string') throw new HttpsError('unauthenticated', 'driver_required');
  const owner = await loadCanonicalDriverAuthority(claims.driverId, productionCanonicalDriverReaders());
  if (!owner?.active || owner.companyId !== claims.companyId || (claims.app !== undefined && claims.app !== 'wbt')) throw new HttpsError('permission-denied', 'driver_scope_changed');
  const now = Date.now(), report = parseSyncAlertReport(request.data, now);
  const db = admin.firestore();
  // Client text never establishes resource ownership or routes the incident.
  const collection = report.kind.startsWith('dispatch') ? 'dispatches' : report.kind.startsWith('invoice') ? 'invoices' : null;
  if (collection) {
    const resource = await db.collection(collection).doc(report.resourceId).get();
    if (resource.exists && (resource.data()?.companyId !== owner.companyId || resource.data()?.driverId !== owner.driverId)) throw new HttpsError('permission-denied', 'foreign_resource');
  }
  const id = syncAlertId(owner.companyId, owner.driverId, report.operationId);
  const ref = db.collection('office_sync_alerts').doc(id);
  await db.runTransaction(async tx => {
    const old = await tx.get(ref);
    const transition = syncAlertTransition(old.exists ? old.data()! : null, report.state);
    if (transition === 'unchanged') return;
    tx.set(ref, {
      companyId: owner.companyId, driverId: owner.driverId, driverName: owner.displayName || 'Driver', app: 'wbt',
      operationId: report.operationId, kind: report.kind, resourceId: report.resourceId,
      reason: report.reason, attempts: report.attempts, createdAtMs: report.createdAtMs,
      firstReportedAtMs: old.data()?.firstReportedAtMs || now, updatedAtMs: now, status: transition,
      ...(transition === 'resolved' ? { resolvedAtMs: now } : {}),
    }, { merge: true });
  });
  return { ok: true, id };
});

export const adminListSyncAlerts = onCall({ timeoutSeconds: 20, enforceAppCheck: false }, async request => {
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'staff_required');
  const raw = request.data;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => k !== 'companyId')) throw new HttpsError('invalid-argument', 'invalid_scope');
  const staff = await requireRegisteredDashboardUser(request.auth.uid);
  let companyId: string;
  if (staff.isPlatformAdmin) companyId = raw.companyId;
  else {
    const trusted = await requireTrustedCompanyCapability(request.auth.uid, TRUSTED_CAPABILITY_MANAGE_DRIVERS);
    companyId = trusted.companyId;
    if (raw.companyId !== undefined && raw.companyId !== companyId) throw new HttpsError('permission-denied', 'foreign_company');
  }
  if (typeof companyId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(companyId)) throw new HttpsError('invalid-argument', 'company_required');
  const result = await admin.firestore().collection('office_sync_alerts').where('companyId', '==', companyId).where('status', '==', 'open').limit(50).get();
  return { alerts: result.docs.map(doc => ({ id: doc.id, ...doc.data() })) };
});
