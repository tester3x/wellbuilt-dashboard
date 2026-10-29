/** Self-service owner bootstrap. New isolated tenant only; never adopts an
 * existing company or grants platform authority. A journal survives retries
 * across Firestore, RTDB and Auth; credentials stay inactive until provisioned. */
import * as admin from 'firebase-admin';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { hashPasscodeScrypt, normalizeDisplayName, validateRegistrationFields, verifyPasscodeScrypt } from './passcode';
import { checkRateLimit, hashIp } from './rateLimit';
import { driverAuthUid, ensureDriverAuthUser } from './tokenMint';
import { assertEnsureAuthorityOk, ensureInitializedEmptyShiftAuthority } from './operational/ensureEmptyShiftAuthority';
import { parseTrustedStaffAuthorityRecord } from './trustedStaffAuthority';
import { CONTRACT_VERSION, type PlanDefinition } from '@tester3x/wellbuilt-contracts';

export function ownerFreePlan(companyId: string): PlanDefinition {
  return { contractVersion: CONTRACT_VERSION, planId: `free-${companyId.replace(/_/g, '-')}`, displayName: 'Standalone JSA & DVIR',
    status: 'active', capabilities: ['jsa', 'dvir', 'companyDefinedWorkPeriod'], apps: {
      'wellbuilt-jsa': { included: true, requiresActiveShift: false },
      'wellbuilt-equipment': { included: true, requiresActiveShift: false },
      'wellbuilt-dashboard': { included: true, requiresActiveShift: false },
      'wellbuilt-suite': { included: true, requiresActiveShift: false },
      'wellbuilt-tickets': { included: false }, 'wellbuilt-mobile': { included: false },
    } };
}

export const OWNER_CAPABILITIES = Object.freeze(['viewHome', 'viewSettings', 'viewAdmin', 'manageCompany',
  'manageDrivers', 'manageRolesAndCapabilities', 'viewEQuipment', 'manageEquipment', 'manageEquipmentAssignments',
  'viewDVIR', 'manageDVIR', 'viewEquipmentDocuments', 'manageEquipmentDocuments', 'viewSafety', 'manageSafety']);

export function ownerSignupInput(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['schemaVersion', 'companyName', 'displayName', 'passcode'].includes(key))) {
    throw new HttpsError('invalid-argument', 'Invalid company signup');
  }
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== 1 || !['companyName', 'displayName', 'passcode'].every(key => typeof input[key] === 'string')) {
    throw new HttpsError('invalid-argument', 'Company name, app sign-in name and password are required');
  }
  const companyName = String(input.companyName).trim();
  if (companyName.length < 2 || companyName.length > 120 || /[\u0000-\u001f]/.test(companyName)) {
    throw new HttpsError('invalid-argument', 'Company name must be 2–120 characters');
  }
  try {
    const fields = validateRegistrationFields({ displayName: String(input.displayName), passcode: String(input.passcode) });
    return { ...fields, companyName };
  } catch { throw new HttpsError('invalid-argument', 'Use a sign-in name of 2–64 characters and a password of 6–128 characters'); }
}

export function ownerCompanyId(uid: string): string {
  return 'co_' + createHash('sha256').update(`owner-company-v1:${uid}`).digest('hex').slice(0, 28);
}
const fs = () => admin.firestore();
const stamp = () => admin.firestore.FieldValue.serverTimestamp();
const refuse = (): never => { throw new HttpsError('failed-precondition', 'This account or sign-in name already belongs to another setup. Use its existing sign-in.'); };
type Journal = { uid: string; companyId: string; companyName: string; displayName: string; nameNorm: string;
  driverId: string; joinCode: string; state: 'reserved' | 'ready' | 'complete' };

async function ownJournal(uid: string): Promise<Journal> {
  const row = await fs().collection('owner_company_signups').doc(uid).get();
  const j = row.data() as Journal | undefined;
  if (!j || j.uid !== uid || j.companyId !== ownerCompanyId(uid)) return refuse();
  return j;
}
async function summary(uid: string) {
  const j = await ownJournal(uid);
  const [authority, company] = await Promise.all([
    fs().collection('trusted_staff_authority').doc(uid).get(), fs().collection('companies').doc(j.companyId).get(),
  ]);
  const parsed = parseTrustedStaffAuthorityRecord(authority.data(), uid);
  if (j.state !== 'complete' || !parsed.ok || parsed.companyId !== j.companyId
    || !parsed.capabilities.includes('manageCompany') || company.data()?.status !== 'active') {
    throw new HttpsError('failed-precondition', 'Company setup is not complete or access has changed.');
  }
  const [credential, profile, appAuthority] = await Promise.all([
    fs().collection('driver_credentials').doc(j.driverId).get(), admin.database().ref(`drivers/profiles/${j.driverId}`).get(),
    fs().collection('trusted_staff_authority').doc(driverAuthUid(j.driverId)).get(),
  ]);
  const app = parseTrustedStaffAuthorityRecord(appAuthority.data(), driverAuthUid(j.driverId));
  if (credential.data()?.active !== true || profile.val()?.active !== true || profile.val()?.companyId !== j.companyId
    || !app.ok || app.companyId !== j.companyId) return refuse();
  return { ok: true, schemaVersion: 1, companyId: j.companyId, companyName: j.companyName,
    displayName: j.displayName, driverId: j.driverId, joinCode: j.joinCode };
}

export const createOwnerCompany = onCall({ region: 'us-central1', timeoutSeconds: 120, memory: '512MiB' }, async request => {
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Create or sign in to your account first');
  const uid = request.auth.uid;
  const fields = ownerSignupInput(request.data);
  const user = await admin.auth().getUser(uid);
  if (user.disabled || !user.email || !user.providerData.some(provider => provider.providerId === 'password')) {
    throw new HttpsError('permission-denied', 'An email/password account is required');
  }
  if (!(await checkRateLimit({ bucket: 'owner_signup', key: hashIp(request.rawRequest.ip) + '_' + uid,
    limit: 15, windowMs: 60 * 60 * 1000 }))) throw new HttpsError('resource-exhausted', 'Please wait before retrying company setup');
  const current = (await admin.database().ref(`users/${uid}`).get()).val() || {};
  const companyId = ownerCompanyId(uid);
  if ((current.companyId && current.companyId !== companyId)
    || (!current.companyId && ['admin', 'it'].includes(current.role))) return refuse();
  const journalRef = fs().collection('owner_company_signups').doc(uid);
  const nameNorm = normalizeDisplayName(fields.displayName);
  const passcode = await hashPasscodeScrypt(fields.passcode);
  const proposed: Journal = { uid, companyId, companyName: fields.companyName, displayName: fields.displayName,
    nameNorm, driverId: randomUUID(), joinCode: [...randomBytes(8)].map(byte => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[byte % 32]).join(''), state: 'reserved' };
  const j = await fs().runTransaction(async tx => {
    const prior = await tx.get(journalRef);
    if (prior.exists) {
      const saved = prior.data() as Journal;
      if (saved.uid !== uid || saved.companyId !== companyId || saved.companyName !== fields.companyName || saved.nameNorm !== nameNorm) return refuse();
      return saved;
    }
    const refs = [fs().collection('companies').doc(companyId), fs().collection('driver_name_index').doc(nameNorm),
      fs().collection('trusted_staff_authority').doc(uid), fs().collection('platform_admins').doc(uid)];
    const rows = await Promise.all(refs.map(ref => tx.get(ref)));
    if (rows.some(row => row.exists)) return refuse();
    const codeRef = fs().collection('company_join_codes').doc(createHash('sha256').update(proposed.joinCode).digest('hex'));
    if ((await tx.get(codeRef)).exists) throw new HttpsError('aborted', 'Please retry company setup');
    const plan = ownerFreePlan(companyId);
    const planRef = fs().collection('plans').doc(plan.planId);
    if ((await tx.get(planRef)).exists) return refuse();
    // Firestore transactions require every read before the first write.
    tx.create(journalRef, { ...proposed, createdAt: stamp() });
    tx.create(refs[0], { name: fields.companyName, status: 'provisioning', ownerUid: uid, createdAt: stamp(), createdBy: uid,
      timeZone: 'America/Chicago', wellbuiltContract: { contractVersion: CONTRACT_VERSION, configurationVersion: 1,
        planId: plan.planId, entitlementOverrides: [], contractEnforced: true,
        workPeriodConfiguration: { mode: 'company_defined_period', timezone: 'America/Chicago', startLocalTime: '00:00', durationMinutes: 1440 },
        appConfiguration: {} } });
    tx.create(planRef, { ...plan });
    tx.create(refs[1], { driverId: proposed.driverId });
    tx.create(fs().collection('driver_credentials').doc(proposed.driverId), { displayNameNorm: nameNorm,
      displayName: fields.displayName, passcode, active: false, mustResetPasscode: false,
      source: 'owner_signup', ownerSignupUid: uid, createdAt: stamp(), updatedAt: stamp() });
    tx.create(codeRef, { companyId, code: proposed.joinCode, active: false, createdAt: stamp(), createdBy: uid });
    tx.create(fs().collection('company_join_codes_by_company').doc(companyId), { digest: codeRef.id, updatedAt: stamp() });
    tx.create(fs().collection('security_audit').doc(), { action: 'createOwnerCompany', actorUid: uid, driverId: proposed.driverId,
      detail: { companyId, state: 'reserved' }, ts: stamp() });
    return proposed;
  });
  const credentialRef = fs().collection('driver_credentials').doc(j.driverId);
  const credential = (await credentialRef.get()).data();
  if (!credential || credential.ownerSignupUid !== uid || !(await verifyPasscodeScrypt(fields.passcode, credential.passcode))) return refuse();
  if (j.state === 'complete') return summary(uid);
  const profileRef = admin.database().ref(`drivers/profiles/${j.driverId}`);
  const profileResult = await profileRef.transaction(prior => {
    if (prior) return prior.ownerSignupUid === uid && prior.companyId === companyId ? prior : undefined;
    return { displayName: j.displayName, legalName: j.displayName, name: j.displayName, companyId,
      companyName: j.companyName, active: false, roles: ['driver', 'admin'], isAdmin: true, isViewer: false,
      ownerSignupUid: uid, ownerSignupState: 'preparing', source: 'owner_signup', schemaVersion: 1 };
  });
  if (!profileResult.committed) return refuse();
  assertEnsureAuthorityOk(await ensureInitializedEmptyShiftAuthority(fs(), { driverId: j.driverId, companyId }));
  const appUid = await ensureDriverAuthUser(j.driverId, j.displayName);
  if (appUid !== driverAuthUid(j.driverId)) return refuse();
  await fs().runTransaction(async tx => {
    const journal = (await tx.get(journalRef)).data() as Journal;
    if (journal.state !== 'reserved') return;
    const authorityRefs = [uid, appUid].map(id => fs().collection('trusted_staff_authority').doc(id));
    if ((await Promise.all(authorityRefs.map(ref => tx.get(ref)))).some(row => row.exists)) return refuse();
    const [index, cred, company] = await Promise.all([
      tx.get(fs().collection('driver_name_index').doc(j.nameNorm)), tx.get(credentialRef),
      tx.get(fs().collection('companies').doc(companyId)),
    ]);
    if (index.data()?.driverId !== j.driverId || cred.data()?.ownerSignupUid !== uid || cred.data()?.active !== false
      || company.data()?.ownerUid !== uid || company.data()?.status !== 'provisioning') return refuse();
    authorityRefs.forEach((ref, index) => tx.create(ref, { schemaVersion: 1, uid: index === 0 ? uid : appUid,
      companyId, active: true, capabilities: [...OWNER_CAPABILITIES] }));
    tx.update(credentialRef, { active: true, updatedAt: stamp() });
    tx.update(fs().collection('companies').doc(companyId), { status: 'active' });
    tx.update(fs().collection('company_join_codes').doc(createHash('sha256').update(j.joinCode).digest('hex')), { active: true });
    tx.update(journalRef, { state: 'ready' });
  });
  // A retry must not undo a later revocation.
  const authority = parseTrustedStaffAuthorityRecord((await fs().collection('trusted_staff_authority').doc(uid).get()).data(), uid);
  if (!authority.ok || authority.companyId !== companyId || !authority.capabilities.includes('manageCompany')) return refuse();
  const appAuthority = parseTrustedStaffAuthorityRecord((await fs().collection('trusted_staff_authority').doc(appUid).get()).data(), appUid);
  if (!appAuthority.ok || appAuthority.companyId !== companyId
    || (await credentialRef.get()).data()?.active !== true
    || (await fs().collection('companies').doc(companyId).get()).data()?.status !== 'active') return refuse();
  const activated = await profileRef.transaction(prior => {
    if (!prior || prior.ownerSignupUid !== uid || prior.companyId !== companyId) return;
    if (prior.ownerSignupState === 'ready') return prior.active === true ? prior : undefined;
    return { ...prior, active: true, ownerSignupState: 'ready', approvedAt: Date.now() };
  });
  if (!activated.committed) return refuse();
  const bound = await admin.database().ref(`users/${uid}`).transaction(prior => {
    if (prior?.companyId && prior.companyId !== companyId) return;
    if (!prior?.companyId && ['admin', 'it'].includes(prior?.role)) return;
    return { ...(prior || {}), companyId, companyName: j.companyName, email: user.email,
      displayName: j.displayName, role: 'admin', roles: ['admin'], status: 'active', onboardingStatus: 'active' };
  });
  if (!bound.committed) return refuse();
  await journalRef.update({ state: 'complete', completedAt: stamp() });
  return summary(uid);
});

export const getOwnerCompanySetup = onCall({ region: 'us-central1', timeoutSeconds: 20 }, async request => {
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in required');
  return summary(request.auth.uid);
});
