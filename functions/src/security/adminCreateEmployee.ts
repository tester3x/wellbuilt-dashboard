import * as https from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { randomUUID } from 'crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { requireManageDrivers, DashboardCaller } from './adminAuth';
import { hashPasscodeScrypt, verifyPasscodeScrypt, normalizeDisplayName, validateRegistrationFields } from './passcode';
import { ensureInitializedEmptyShiftAuthority, assertEnsureAuthorityOk } from './operational/ensureEmptyShiftAuthority';
import { writeSecurityAudit } from './audit';

export function employeeCompany(caller: DashboardCaller, requested: unknown): string {
  const companyId = typeof requested === 'string' ? requested.trim() : '';
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(companyId)) throw new https.HttpsError('invalid-argument', 'Select a company');
  if (!caller.isPlatformAdmin && (!caller.companyId || caller.companyId !== companyId)) throw new https.HttpsError('permission-denied', 'You can only add employees to your own company');
  return companyId;
}

/** New secure mobile employee, never a legacy conversion or credential reset.
 * Cross-store work is resumable. Credentials stay disabled until the profile
 * and shift authority exist. Route access is deliberately empty until assigned.
 */
export const adminCreateEmployee = https.onCall({ timeoutSeconds: 60, memory: '256MiB' }, async request => {
  const caller = await requireManageDrivers(request.auth?.uid, request.auth?.token);
  const data = request.data || {};
  const allowed = ['requestId', 'displayName', 'legalName', 'passcode', 'companyId'];
  if (Object.keys(data).some(k => !allowed.includes(k))) throw new https.HttpsError('invalid-argument', 'Unexpected account fields');
  if (typeof data.requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(data.requestId)) throw new https.HttpsError('invalid-argument', 'Request ID required');
  const companyId = employeeCompany(caller, data.companyId);
  let fields: ReturnType<typeof validateRegistrationFields>;
  try { fields = validateRegistrationFields(data); }
  catch { throw new https.HttpsError('invalid-argument', 'Enter a display name, legal name and a passcode of at least 6 characters'); }
  if (!fields.legalName?.trim()) throw new https.HttpsError('invalid-argument', 'Legal name required');
  const db = admin.firestore();
  const company = await db.collection('companies').doc(companyId).get();
  if (!company.exists || company.data()?.active === false || ['suspended', 'inactive', 'deleted'].includes(company.data()?.status)) throw new https.HttpsError('failed-precondition', 'Company is missing or inactive');
  const nameNorm = normalizeDisplayName(fields.displayName);
  const companyName = company.data()?.name || companyId;
  const operation = db.collection('admin_employee_creation').doc(data.requestId);
  const index = db.collection('driver_name_index').doc(nameNorm);
  const passcode = await hashPasscodeScrypt(fields.passcode);
  const candidateId = randomUUID();
  const claim = await db.runTransaction(async tx => {
    const [prior, owner] = await Promise.all([tx.get(operation), tx.get(index)]);
    if (prior.exists) {
      const p = prior.data()!;
      if (p.actorUid !== caller.uid || p.companyId !== companyId || p.nameNorm !== nameNorm || p.legalName !== fields.legalName) throw new https.HttpsError('failed-precondition', 'Retry must use the same employee details');
      if (owner.data()?.driverId !== p.driverId) throw new https.HttpsError('failed-precondition', 'Account changed; administrator review required');
      const credential = await tx.get(db.collection('driver_credentials').doc(p.driverId));
      if (!credential.exists) throw new https.HttpsError('failed-precondition', 'Account was removed; administrator review required');
      if (!p.complete && !await verifyPasscodeScrypt(fields.passcode, credential.data()!.passcode)) throw new https.HttpsError('failed-precondition', 'Retry with the original passcode; this request does not reset credentials');
      return { driverId: String(p.driverId), complete: p.complete === true };
    }
    if (owner.exists) throw new https.HttpsError('already-exists', 'This secure login name is already registered or pending. No account was changed.');
    tx.create(operation, { actorUid: caller.uid, companyId, companyName, nameNorm, legalName: fields.legalName, driverId: candidateId, complete: false, createdAt: FieldValue.serverTimestamp() });
    tx.create(index, { driverId: candidateId });
    tx.create(db.collection('driver_credentials').doc(candidateId), { displayName: fields.displayName, displayNameNorm: nameNorm, passcode, active: false, mustResetPasscode: false, temporaryAssigned: false, creationRequestId: data.requestId, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), setBy: caller.uid });
    return { driverId: candidateId, complete: false };
  });
  if (claim.complete) return { ok: true, driverId: claim.driverId, alreadyCreated: true };
  const profileRef = admin.database().ref(`drivers/profiles/${claim.driverId}`);
  const profile = await profileRef.transaction(current => {
    if (current) return current.creationRequestId === data.requestId && current.companyId === companyId ? current : undefined;
    return { displayName: fields.displayName, name: fields.displayName, legalName: fields.legalName, companyId, companyName, active: false, roles: ['driver'], isAdmin: false, isViewer: false, mustUseSecureAuth: true, assignedRoutes: [], assignedWells: [], assignmentRevision: 0, source: 'admin_created', schemaVersion: 1, creationRequestId: data.requestId, approvedAt: Date.now(), approvedBy: caller.uid };
  });
  if (!profile.committed) throw new https.HttpsError('failed-precondition', 'Profile changed; creation stopped without overwriting it');
  const authority = await ensureInitializedEmptyShiftAuthority(db, { driverId: claim.driverId, companyId });
  assertEnsureAuthorityOk(authority);
  if (authority.decision.action === 'skip') throw new https.HttpsError('failed-precondition', 'Company shift authority missing');
  const activated = await profileRef.transaction(current => {
    if (current === null) return null; // server retry for a cold cache
    if (current.creationRequestId !== data.requestId || current.companyId !== companyId) return;
    return { ...current, active: true };
  });
  if (!activated.committed || !activated.snapshot.exists()) throw new https.HttpsError('failed-precondition', 'Profile changed before activation');
  await db.runTransaction(async tx => {
    const credentialRef = db.collection('driver_credentials').doc(claim.driverId);
    const [credential, owner] = await Promise.all([tx.get(credentialRef), tx.get(index)]);
    if (credential.data()?.creationRequestId !== data.requestId || owner.data()?.driverId !== claim.driverId) throw new https.HttpsError('failed-precondition', 'Identity changed before activation');
    tx.update(credentialRef, { active: true, updatedAt: FieldValue.serverTimestamp() });
    tx.update(operation, { complete: true });
  });
  await writeSecurityAudit({ action: 'adminCreateEmployee', actorUid: caller.uid, driverId: claim.driverId, detail: { companyId } });
  return { ok: true, driverId: claim.driverId, alreadyCreated: false };
});
