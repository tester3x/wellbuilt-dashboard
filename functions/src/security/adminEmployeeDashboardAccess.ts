import * as https from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireManageDrivers, DashboardCaller } from './adminAuth';
import { writeSecurityAudit } from './audit';

export const DASHBOARD_ROLES = ['viewer', 'dispatch', 'payroll', 'manager', 'admin', 'it'] as const;
export function authorizeEmployeeDashboard(caller: DashboardCaller, companyId: unknown, roles: unknown): string[] {
  if (!caller.isPlatformAdmin && !caller.roles.some(r => r === 'admin' || r === 'it')) throw new https.HttpsError('permission-denied', 'Dashboard access must be managed by an administrator');
  if (typeof companyId !== 'string' || !companyId.trim()) throw new https.HttpsError('failed-precondition', 'Assign the employee to a company first');
  if (!caller.isPlatformAdmin && caller.companyId !== companyId) throw new https.HttpsError('permission-denied', 'Employee is outside your company');
  if (!Array.isArray(roles) || !roles.length || roles.some(r => !(DASHBOARD_ROLES as readonly unknown[]).includes(r))) throw new https.HttpsError('invalid-argument', 'Select valid dashboard roles');
  if (roles.includes('it') && !caller.isPlatformAdmin && !caller.roles.includes('it')) throw new https.HttpsError('permission-denied', 'Only an owner or WB administrator can grant Owner / IT');
  return [...new Set(roles as string[])];
}

/** Explicit canonical employee ↔ email login linkage. Never guesses from names
 * or repurposes a platform/other-company login. App credentials are untouched.
 */
export const adminEmployeeDashboardAccess = https.onCall({ timeoutSeconds: 60, memory: '256MiB' }, async request => {
  const caller = await requireManageDrivers(request.auth?.uid, request.auth?.token);
  const data = request.data || {};
  if (Object.keys(data).some(k => !['driverId', 'email', 'roles', 'generateSetupLink'].includes(k))) throw new https.HttpsError('invalid-argument', 'Unexpected fields');
  const driverId = data.driverId;
  const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
  if (typeof driverId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(driverId) || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new https.HttpsError('invalid-argument', 'Employee ID and valid email required');
  const db = admin.database();
  const profileRef = db.ref(`drivers/profiles/${driverId}`);
  const profile = (await profileRef.once('value')).val();
  if (!profile || profile.active === false) throw new https.HttpsError('failed-precondition', 'Employee is missing or inactive');
  const roles = authorizeEmployeeDashboard(caller, profile.companyId, data.roles);
  const companyId = profile.companyId;
  const primaryRole = [...roles].sort((a, b) => DASHBOARD_ROLES.indexOf(b as any) - DASHBOARD_ROLES.indexOf(a as any))[0];
  const auth = admin.auth();
  // Stable UID allows recovery if Auth creation succeeds but linking fails.
  const newUid = `dashboard_${driverId}`;
  let account: admin.auth.UserRecord;
  let created = false;
  try { account = await auth.getUserByEmail(email); }
  catch (error) {
    if ((error as { code?: string }).code !== 'auth/user-not-found') throw error;
    if (profile.dashboardUid) throw new https.HttpsError('failed-precondition', 'Employee already has a dashboard login. Email changes require account recovery.');
    try {
      account = await auth.createUser({ uid: newUid, email, emailVerified: false, displayName: profile.legalName || profile.displayName, disabled: true });
      created = true;
    } catch (creationError) {
      if (!['auth/email-already-exists', 'auth/uid-already-exists'].includes((creationError as { code?: string }).code || '')) throw creationError;
      account = await auth.getUserByEmail(email);
    }
  }
  if (profile.dashboardUid && profile.dashboardUid !== account.uid) throw new https.HttpsError('failed-precondition', 'Employee is already linked to a different dashboard account');
  const userRef = db.ref(`users/${account.uid}`);
  const existing = (await userRef.once('value')).val();
  const pendingNewAccount = account.uid === newUid && (!existing || existing.dashboardProvisioningPending === true);
  if (account.disabled && !pendingNewAccount) throw new https.HttpsError('failed-precondition', 'Dashboard account is disabled; contact its administrator');
  const allowedUser = (value: any) => value
    ? value.companyId === companyId && (!value.driverId || value.driverId === driverId) && !value.driverHash
    : account.uid === newUid;
  if (!allowedUser(existing)) throw new https.HttpsError('failed-precondition', 'That email belongs to an unrelated, legacy-linked, or platform account. It was not changed.');
  // Claim the employee link before granting privileges; concurrent competing
  // emails cannot both become the employee's dashboard account.
  let linkValid = false;
  const link = await profileRef.transaction(current => {
    linkValid = false;
    if (current === null) return null;
    if (current.companyId !== companyId || current.active === false || (current.dashboardUid && current.dashboardUid !== account.uid)) return;
    linkValid = true;
    return { ...current, dashboardUid: account.uid, dashboardEmail: email };
  });
  if (!link.committed || !linkValid) throw new https.HttpsError('failed-precondition', 'Employee changed while linking; no dashboard permissions were granted');
  // Existing-company checks run again on the transaction's current value,
  // not merely the earlier read. A cold null can create only our stable UID.
  let userValid = false;
  const userWrite = await userRef.transaction(current => {
    userValid = false;
    if (current === null && account.uid !== newUid) return null;
    if (!allowedUser(current)) return;
    userValid = true;
    return { ...(current || {}), email, displayName: profile.legalName || profile.displayName, companyId, companyName: profile.companyName || companyId, driverId, roles, role: primaryRole, dashboardProvisioningPending: pendingNewAccount };
  });
  if (!userWrite.committed || !userValid) throw new https.HttpsError('failed-precondition', 'Dashboard account changed. Link may be pending; retry with the same email.');
  // No newly provisioned login can authenticate as an unscoped default viewer
  // during a partial failure. Enable only after its scoped user record exists.
  if (pendingNewAccount) {
    await auth.updateUser(account.uid, { disabled: false });
    await userRef.update({ dashboardProvisioningPending: false });
  }
  await writeSecurityAudit({ action: 'adminEmployeeDashboardAccess', actorUid: caller.uid, driverId, detail: { dashboardUid: account.uid, companyId, roles } });
  let setupLink: string | null = null;
  let setupLinkError: string | null = null;
  if (data.generateSetupLink === true || created) {
    try { setupLink = await auth.generatePasswordResetLink(email); }
    catch { setupLinkError = 'Account linked, but password link could not be generated. Retry Generate password link.'; }
  }
  return { ok: true, uid: account.uid, email, companyId, roles, setupLink, setupLinkError };
});
