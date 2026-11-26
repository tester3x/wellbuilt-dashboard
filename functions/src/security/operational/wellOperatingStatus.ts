import * as admin from 'firebase-admin';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { requireSecureDriver } from '../requireDriverAuth';
import { requireTrustedCompanyCapability } from '../trustedStaffAuthority';
import { wellBelongsToDriverCompany } from './wbmWellScope';
import { canManageWellStatus, statusIntent } from './wellOperatingPolicy';
import { randomBytes } from 'crypto';

const fail = (message: string) => new HttpsError('failed-precondition', message);
function wellKey(key: unknown): string {
  if (typeof key !== 'string' || !key.trim() || key.length > 120 || /[.#$\[\]/]/.test(key)) throw new HttpsError('invalid-argument', 'Invalid well');
  return key;
}
async function load(companyId: string, key: string) {
  const db = admin.database();
  const config = (await db.ref('well_config/' + key).once('value')).val();
  if (!config || !wellBelongsToDriverCompany(config, companyId)) throw new HttpsError('permission-denied', 'Well is not available to this company');
  if (config.routeType === 'freshwater') throw fail('Use the fresh-water operating controls for this supply');
  const state = (await db.ref(`wells/${key}/status/isDown`).once('value')).val();
  return { config, down: typeof state === 'boolean' ? state : config.isDown === true };
}
async function apply(companyId: string, actor: string, intent: ReturnType<typeof statusIntent>, requestId?: string) {
  const db = admin.database(), key = intent.wellConfigKey;
  const lockRef = db.ref(`wellOperatingLocks/${companyId}/${key}`), token = randomBytes(16).toString('hex');
  const until = Date.now() + 60000;
  await lockRef.once('value');
  const locked = await lockRef.transaction(current => {
    if (current?.until > Date.now()) return;
    return { token, until };
  });
  if (!locked.committed || locked.snapshot.val()?.token !== token) throw fail('Another status change is in progress. Try again.');
  try {
  const ref = db.ref(`wellOperatingOperations/${companyId}/${intent.operationId}`);
  // Durable deterministic intent: retries cannot turn this into a second event.
  const prior = (await ref.once('value')).val();
  const binding = JSON.stringify([companyId, actor, key, intent.expectedDown, intent.down, requestId || null]);
  if (prior) {
    if (prior.binding !== binding) throw fail('Status operation does not match the original request');
    if (prior.status === 'applied') return { status: 'applied', down: intent.down };
  }
  const current = await load(companyId, key);
  if (current.down !== intent.expectedDown) throw fail('Well status changed. Refresh before changing it again.');
  const outgoing = (await db.ref('packets/outgoing').orderByChild('wellName').equalTo(key).once('value')).val() || {};
  const at = new Date().toISOString();
  const patch: Record<string, any> = {
    [`well_config/${key}/isDown`]: intent.down,
    [`wells/${key}/status/isDown`]: intent.down,
    [`wells/${key}/status/operatingStatusChangedAt`]: at,
    [`wellOperatingOperations/${companyId}/${intent.operationId}`]: { binding, companyId, actor, wellConfigKey: key,
      previousDown: intent.expectedDown, down: intent.down, at, status: 'applied', requestId: requestId || null },
  };
  for (const [id, value] of Object.entries(outgoing) as [string, any][]) {
    patch[`packets/outgoing/${id}/wellDown`] = intent.down;
    // Legacy down projections used the word Down as their level. Restore a
    // recorded level on explicit reactivation, without inventing a pickup.
    if (!intent.down && /down/i.test(value.currentLevel || '')) patch[`packets/outgoing/${id}/currentLevel`] = value.lastPullBottomLevel || 'Unknown';
  }
  if (requestId) {
    patch[`wellOperatingRequests/${companyId}/${requestId}/status`] = 'approved';
    patch[`wellOperatingRequests/${companyId}/${requestId}/reviewedBy`] = actor;
    patch[`wellOperatingRequests/${companyId}/${requestId}/reviewedAt`] = at;
  }
  if (Date.now() >= until - 10000) throw fail('Status change timed out. Try again with the same request.');
  await db.ref().update(patch);
  return { status: 'applied', down: intent.down };
  } finally {
    await lockRef.transaction(current => current?.token === token ? null : undefined);
  }
}

export async function driverWellOperatingStatusHandler(request: any) {
  const driver = await requireSecureDriver(request, { allowLegacyHash: false });
  if (!driver.companyId) throw fail('Company required');
  const data = request.data || {}, key = wellKey(data.wellConfigKey);
  const current = await load(driver.companyId, key);
  const profile = (await admin.database().ref(`drivers/profiles/${driver.driverId}`).once('value')).val() || {};
  const canChange = canManageWellStatus(profile, driver.companyId, key, current.config);
  if (data.action === 'status') return { down: current.down, canChange, route: current.config.route || null };
  let intent;
  try { intent = statusIntent(data); } catch (e) { throw new HttpsError('invalid-argument', (e as Error).message); }
  if (data.action === 'set') {
    if (!canChange) throw new HttpsError('permission-denied', 'Request dispatch/admin approval for this well');
    return apply(driver.companyId, driver.driverId, intent);
  }
  if (data.action !== 'request') throw new HttpsError('invalid-argument', 'Unknown action');
  const ref = admin.database().ref(`wellOperatingRequests/${driver.companyId}/${intent.operationId}`);
  const row = { ...intent, companyId: driver.companyId, driverId: driver.driverId, driverName: driver.displayName || driver.driverId,
    route: current.config.route || null, status: 'pending', requestedAt: new Date().toISOString() };
  const result = await ref.transaction(prior => prior || row);
  const saved = result.snapshot.val();
  if (saved.driverId !== driver.driverId || saved.wellConfigKey !== key || saved.down !== intent.down || saved.expectedDown !== intent.expectedDown)
    throw fail('Request identity conflict');
  return { status: saved.status, down: current.down };
}
export async function reviewWellOperatingStatusHandler(request: any) {
  if (request.auth?.token?.kind === 'driver') throw new HttpsError('permission-denied', 'Open dispatch/admin review with a staff session');
  let staff;
  try { staff = await requireTrustedCompanyCapability(request.auth?.uid, 'createDispatch'); }
  catch { staff = await requireTrustedCompanyCapability(request.auth?.uid, 'manageCompany'); }
  const data = request.data || {}, db = admin.database();
  if (data.action === 'list') {
    const rows = (await db.ref(`wellOperatingRequests/${staff.companyId}`).once('value')).val() || {};
    return { items: Object.entries(rows).filter(([, value]) => (value as any).status === 'pending').slice(0, 100).map(([id, value]) => ({ id, ...(value as any) })) };
  }
  if (!/^[a-zA-Z0-9_-]{12,100}$/.test(data.id || '') || !['approve', 'reject'].includes(data.action)) throw new HttpsError('invalid-argument', 'Invalid review');
  const ref = db.ref(`wellOperatingRequests/${staff.companyId}/${data.id}`), row = (await ref.once('value')).val();
  if (!row || row.companyId !== staff.companyId) throw new HttpsError('not-found', 'Request not found');
  if (row.status !== 'pending') return { status: row.status };
  const decision = await ref.transaction(current => {
    if (!current || current.status !== 'pending' || (current.reviewDecision
      && (current.reviewDecision !== data.action || current.reviewDecisionBy !== staff.uid))) return;
    return { ...current, reviewDecision: data.action, reviewDecisionBy: staff.uid };
  });
  if (!decision.committed) throw fail('Another reviewer already handled this request');
  if (data.action === 'reject') {
    await ref.update({ status: 'rejected', reviewedBy: staff.uid, reviewedAt: new Date().toISOString() });
    return { status: 'rejected' };
  }
  return apply(staff.companyId, staff.uid, statusIntent(row), data.id);
}
export const driverWellOperatingStatus = onCall({ region: 'us-central1' }, driverWellOperatingStatusHandler);
export const reviewWellOperatingStatus = onCall({ region: 'us-central1' }, reviewWellOperatingStatusHandler);
