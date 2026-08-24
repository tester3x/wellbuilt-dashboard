import * as admin from 'firebase-admin';
import * as httpsV2 from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { requireManageDrivers } from './adminAuth';
import { hashPasscodeScrypt, normalizeDisplayName, validateRegistrationFields } from './passcode';
import { runCustomerOwnedUpgrade } from './operational/customerOwnedUpgrade';
import { productionUpgradeStore } from './operational/customerOwnedUpgradeStore';
import { canonicalApprovedRowFingerprint } from './operational/identityBinding';
import { checkRateLimit, hashIp } from './rateLimit';
import {
  DRIVER_RECOVERY_TTL_MS,
  allowedRecoveryReturnUri,
  classifyRedemption,
  genericRequestReceipt,
  secretsMatch,
  validSecretHash,
  type DriverRecoveryPurpose,
} from './driverRecoveryContract';

const REQUESTS = 'driver_account_recovery';
const AUDIT = 'driver_account_recovery_audit';
const GENERIC_DENIAL = 'Recovery could not be completed';
const ID_RE = /^[0-9a-f-]{36}$/i;

function requestRef(id: string) {
  if (!ID_RE.test(id)) throw new httpsV2.HttpsError('invalid-argument', GENERIC_DENIAL);
  return admin.firestore().collection(REQUESTS).doc(id);
}

async function audit(event: string, requestId: string, detail: Record<string, unknown> = {}) {
  await admin.firestore().collection(AUDIT).add({
    event, requestId, detail, at: FieldValue.serverTimestamp(),
  });
}

function purposeOf(v: unknown): DriverRecoveryPurpose {
  if (v === 'forgot_login' || v === 'forgot_passcode' || v === 'legacy_upgrade') return v;
  throw new httpsV2.HttpsError('invalid-argument', GENERIC_DENIAL);
}
function requestIpHash(request: httpsV2.CallableRequest): string {
  const raw = request.rawRequest?.headers?.['x-forwarded-for'];
  const ip = (typeof raw === 'string' ? raw.split(',')[0] : request.rawRequest?.ip) || undefined;
  return hashIp(ip);
}

/** Enumeration-resistant public request. Client owns requestId/status secret. */
export const requestDriverAccountRecovery = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const d = (request.data || {}) as Record<string, unknown>;
    const requestId = String(d.requestId || '');
    const statusSecretHash = String(d.statusSecretHash || '');
    const audience = String(d.audience || '');
    const returnUri = allowedRecoveryReturnUri(audience, d.returnUri);
    if (!validSecretHash(statusSecretHash)) {
      throw new httpsV2.HttpsError('invalid-argument', GENERIC_DENIAL);
    }
    const purpose = purposeOf(d.purpose);
    if (!await checkRateLimit({ bucket: 'driver_recovery_request', key: requestIpHash(request), limit: 5, windowMs: 15 * 60 * 1000 })) {
      return genericRequestReceipt();
    }
    const ref = requestRef(requestId);
    const now = Date.now();
    const minimal = {
      legalNameHint: String(d.legalNameHint || '').trim().slice(0, 80),
      companyHint: String(d.companyHint || '').trim().slice(0, 80),
      contactHint: String(d.contactHint || '').trim().slice(0, 160),
    };
    await admin.firestore().runTransaction(async (tx) => {
      const old = await tx.get(ref);
      if (old.exists) return; // identical public receipt; never enumerate
      tx.create(ref, {
        purpose, audience, returnUri, stateHash: String(d.stateHash || '').slice(0, 64),
        statusSecretHash, ...minimal, state: 'pending', attempts: 0,
        createdAtMs: now, expiresAtMs: now + DRIVER_RECOVERY_TTL_MS,
      });
    });
    await audit('requested', requestId, { purpose, audience });
    return genericRequestReceipt();
  },
);

export const getOwnRecoveryRequestStatus = httpsV2.onCall(
  { timeoutSeconds: 15, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const d = (request.data || {}) as Record<string, unknown>;
    const snap = await requestRef(String(d.requestId || '')).get();
    const data = snap.data();
    if (!data || !secretsMatch(String(d.statusSecret || ''), String(data.statusSecretHash || ''))) {
      return { state: 'pending' }; // same shape for missing/wrong
    }
    const expired = Date.now() >= Number(data.expiresAtMs || 0);
    return { state: expired ? 'expired' : String(data.state || 'pending') };
  },
);

export const listDriverAccountRecoveryRequests = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB' }, async request => {
    const caller = await requireManageDrivers(request.auth?.uid, request.auth?.token as Record<string, unknown>);
    const snap = await admin.firestore().collection(REQUESTS).orderBy('createdAtMs', 'desc').limit(100).get();
    return { requests: snap.docs.map(doc => {
      const d = doc.data();
      if (caller.companyId && d.companyId && caller.companyId !== d.companyId) return null;
      return { requestId: doc.id, purpose: d.purpose, state: d.state,
        legalNameHint: d.legalNameHint || '', companyHint: d.companyHint || '', contactHint: d.contactHint || '',
        createdAtMs: d.createdAtMs, expiresAtMs: d.expiresAtMs };
    }).filter(Boolean) };
  },
);

/** Admin supplies only a locally-generated secret HASH; raw recovery value never reaches Dashboard backend. */
export const approveDriverAccountRecovery = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB' },
  async (request) => {
    const caller = await requireManageDrivers(request.auth?.uid, request.auth?.token as Record<string, unknown>);
    const d = (request.data || {}) as Record<string, unknown>;
    const requestId = String(d.requestId || '');
    const recoverySecretHash = String(d.recoverySecretHash || '');
    if (!validSecretHash(recoverySecretHash)) throw new httpsV2.HttpsError('invalid-argument', GENERIC_DENIAL);
    const ref = requestRef(requestId);
    const reqSnap = await ref.get();
    const rec = reqSnap.data();
    if (!rec || rec.state !== 'pending' || Date.now() >= Number(rec.expiresAtMs || 0)) {
      throw new httpsV2.HttpsError('failed-precondition', GENERIC_DENIAL);
    }

    const approvedKey = typeof d.approvedKey === 'string' ? d.approvedKey : '';
    const driverId = typeof d.driverId === 'string' ? d.driverId : '';
    let targetKind: 'legacy' | 'secure';
    let profile: Record<string, unknown>;
    let normalizedName: string;
    let credentialGeneration = 0;
    if (approvedKey && !driverId) {
      const row = (await admin.database().ref(`drivers/approved/${approvedKey}`).once('value')).val();
      if (!row || row.active !== true) throw new httpsV2.HttpsError('failed-precondition', GENERIC_DENIAL);
      targetKind = 'legacy'; profile = row;
      normalizedName = normalizeDisplayName(String(row.displayName || ''));
    } else if (driverId && !approvedKey) {
      const [p, c] = await Promise.all([
        admin.database().ref(`drivers/profiles/${driverId}`).once('value'),
        admin.firestore().collection('driver_credentials').doc(driverId).get(),
      ]);
      if (!p.exists() || !c.exists || p.val()?.active === false || c.data()?.active === false) {
        throw new httpsV2.HttpsError('failed-precondition', GENERIC_DENIAL);
      }
      targetKind = 'secure'; profile = p.val();
      normalizedName = normalizeDisplayName(String(c.data()?.displayName || profile.displayName || ''));
      credentialGeneration = Number(c.data()?.credentialGeneration || 0);
    } else {
      throw new httpsV2.HttpsError('invalid-argument', GENERIC_DENIAL);
    }
    const companyId = String(profile.companyId || '');
    if (!companyId || (caller.companyId && caller.companyId !== companyId)) {
      throw new httpsV2.HttpsError('permission-denied', GENERIC_DENIAL);
    }
    const existingIndex = await admin.firestore().collection('driver_name_index').doc(normalizedName).get();
    if (targetKind === 'legacy' && existingIndex.exists) {
      throw new httpsV2.HttpsError('failed-precondition', GENERIC_DENIAL);
    }
    await ref.update({
      state: 'authorized', targetKind, approvedKey: approvedKey || null, driverId: driverId || null,
      normalizedName, companyId, profileDigest: canonicalApprovedRowFingerprint(profile),
      credentialGeneration, recoverySecretHash, approvedBy: caller.uid,
      approvedAtMs: Date.now(), expiresAtMs: Date.now() + DRIVER_RECOVERY_TTL_MS,
    });
    await audit('authorized', requestId, { actorUid: caller.uid, targetKind, companyId });
    return { ok: true }; // never return name, key, secret, or verifier
  },
);

async function terminalAdminAction(request: httpsV2.CallableRequest, state: 'denied' | 'cancelled') {
  const caller = await requireManageDrivers(request.auth?.uid, request.auth?.token as Record<string, unknown>);
  const requestId = String((request.data as any)?.requestId || '');
  const ref = requestRef(requestId);
  await admin.firestore().runTransaction(async tx => {
    const snap = await tx.get(ref); if (!snap.exists) return;
    const d = snap.data()!;
    if (d.state === 'used') throw new httpsV2.HttpsError('failed-precondition', GENERIC_DENIAL);
    if (caller.companyId && d.companyId && caller.companyId !== d.companyId) {
      throw new httpsV2.HttpsError('permission-denied', GENERIC_DENIAL);
    }
    tx.update(ref, { state, terminalBy: caller.uid, terminalAtMs: Date.now(), recoverySecretHash: FieldValue.delete() });
  });
  await audit(state, requestId, { actorUid: caller.uid });
  return { ok: true };
}

export const denyDriverAccountRecovery = httpsV2.onCall({ timeoutSeconds: 15 }, r => terminalAdminAction(r, 'denied'));
export const cancelDriverAccountRecovery = httpsV2.onCall({ timeoutSeconds: 15 }, r => terminalAdminAction(r, 'cancelled'));

export const redeemDriverAccountRecovery = httpsV2.onCall(
  { timeoutSeconds: 60, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const d = (request.data || {}) as Record<string, unknown>;
    const requestId = String(d.requestId || '');
    if (!await checkRateLimit({ bucket: 'driver_recovery_redeem', key: `${requestId}:${requestIpHash(request)}`, limit: 10, windowMs: 15 * 60 * 1000 })) {
      throw new httpsV2.HttpsError('resource-exhausted', GENERIC_DENIAL);
    }
    const redemptionAttemptId = String(d.redemptionAttemptId || '');
    const secret = String(d.recoverySecret || '');
    const newPasscode = String(d.newPasscode || '');
    if (!ID_RE.test(redemptionAttemptId)) throw new httpsV2.HttpsError('permission-denied', GENERIC_DENIAL);
    try { validateRegistrationFields({ displayName: 'recovery-user', passcode: newPasscode }); }
    catch { throw new httpsV2.HttpsError('permission-denied', GENERIC_DENIAL); }
    const ref = requestRef(requestId);
    const snap = await ref.get(); const rec = snap.data();
    if (!rec) throw new httpsV2.HttpsError('permission-denied', GENERIC_DENIAL);
    const profile = rec.targetKind === 'legacy'
      ? (await admin.database().ref(`drivers/approved/${rec.approvedKey}`).once('value')).val()
      : (await admin.database().ref(`drivers/profiles/${rec.driverId}`).once('value')).val();
    const cred = rec.targetKind === 'secure'
      ? await admin.firestore().collection('driver_credentials').doc(rec.driverId).get() : null;
    const decision = classifyRedemption({
      state: rec.state, now: Date.now(), expiresAt: Number(rec.expiresAtMs || 0),
      attempts: Number(rec.attempts || 0), secretMatches: secretsMatch(secret, rec.recoverySecretHash),
      profileDigestMatches: !!profile && canonicalApprovedRowFingerprint(profile) === rec.profileDigest,
      companyMatches: !!profile && profile.companyId === rec.companyId,
      credentialGenerationMatches: !cred || Number(cred.data()?.credentialGeneration || 0) === Number(rec.credentialGeneration || 0),
      sameRedemptionAttempt: rec.redemptionAttemptId === redemptionAttemptId,
    });
    if (!decision.allow) {
      await ref.update({ attempts: FieldValue.increment(1) }).catch(() => undefined);
      await audit('redemption_denied', requestId, { reason: decision.reason });
      throw new httpsV2.HttpsError('permission-denied', GENERIC_DENIAL);
    }
    await admin.firestore().runTransaction(async tx => {
      const live = await tx.get(ref); const x = live.data();
      if (!x || (x.state !== 'authorized' && !(x.state === 'redeeming' && x.redemptionAttemptId === redemptionAttemptId))) {
        throw new httpsV2.HttpsError('permission-denied', GENERIC_DENIAL);
      }
      tx.update(ref, { state: 'redeeming', redemptionAttemptId });
    });
    const passcodeRecord = await hashPasscodeScrypt(newPasscode);
    let driverId: string;
    if (rec.targetKind === 'legacy') {
      const result = await runCustomerOwnedUpgrade(
        productionUpgradeStore(admin.firestore(), admin.database()),
        { provenApprovedKey: rec.approvedKey, displayName: profile.displayName, passcodeRecord,
          callerUid: 'driver-recovery', opId: redemptionAttemptId },
      );
      if (result.status !== 'ok' || !result.terminalProven || !result.driverId) {
        throw new httpsV2.HttpsError('failed-precondition', GENERIC_DENIAL);
      }
      driverId = result.driverId;
    } else {
      driverId = rec.driverId;
      const credRef = admin.firestore().collection('driver_credentials').doc(driverId);
      await admin.firestore().runTransaction(async tx => {
        const live = await tx.get(credRef);
        if (!live.exists || Number(live.data()?.credentialGeneration || 0) !== Number(rec.credentialGeneration || 0)) {
          throw new httpsV2.HttpsError('failed-precondition', GENERIC_DENIAL);
        }
        tx.update(credRef, { passcode: passcodeRecord, credentialGeneration: FieldValue.increment(1),
          passcodeChangedAt: FieldValue.serverTimestamp(), opId: FieldValue.delete() });
      });
      const uid = `driver_${driverId.replace(/-/g, '').slice(0, 28)}`;
      await admin.auth().revokeRefreshTokens(uid);
    }
    await ref.update({ state: 'used', usedAtMs: Date.now(), driverId,
      recoverySecretHash: FieldValue.delete(), statusSecretHash: FieldValue.delete() });
    await audit('used', requestId, { targetKind: rec.targetKind, driverId });
    return { ok: true }; // portal tells user to reopen app; identity is not returned
  },
);

export const getDriverSecureLoginStatus = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB' },
  async request => {
    const caller = await requireManageDrivers(request.auth?.uid, request.auth?.token as Record<string, unknown>);
    const d = (request.data || {}) as Record<string, unknown>;
    const keys = Array.isArray(d.approvedKeys) ? d.approvedKeys : [d.approvedKey];
    if (keys.length > 250 || keys.some(k => typeof k !== 'string')) {
      throw new httpsV2.HttpsError('invalid-argument', 'Invalid status request');
    }
    const statuses = await Promise.all(keys.map(async raw => {
      const approvedKey = String(raw || '');
      const row = (await admin.database().ref(`drivers/approved/${approvedKey}`).once('value')).val();
      if (!row || (caller.companyId && caller.companyId !== row.companyId)) {
        return { classification: 'partial_or_malformed', secureActive: false };
      }
      const binding = (await admin.database().ref(`drivers/identityBindings/byApproved/${approvedKey}`).once('value')).val();
      const driverId = binding?.driverId || row.migratedToDriverId || null;
      const [credential, profile] = driverId ? await Promise.all([
        admin.firestore().collection('driver_credentials').doc(driverId).get(),
        admin.database().ref(`drivers/profiles/${driverId}`).once('value'),
      ]) : [null, null];
      const secure = !!credential?.exists && credential.data()?.active !== false && !!profile?.exists();
      return { classification: secure ? (row.active === true ? 'converted_with_legacy_active' : 'secure_only') :
        (driverId ? 'partial_or_malformed' : 'legacy_only'), secureActive: secure };
    }));
    return { statuses }; // positional: never echo approved/verifier keys
  },
);
