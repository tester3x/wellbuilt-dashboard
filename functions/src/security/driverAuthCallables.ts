/**
 * WellBuilt driver identity — server-enforced registration, login, approval.
 * Clients must not write drivers/approved or credential documents.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { ServerValue } from 'firebase-admin/database';
import { randomUUID } from 'crypto';
import {
  hashPasscodeScrypt,
  verifyPasscodeScrypt,
  normalizeDisplayName,
  validateRegistrationFields,
  ScryptRecord,
  legacySha256NamePasscode,
  PASSCODE_MIN_LEN,
} from './passcode';
import { checkRateLimit, hashIp } from './rateLimit';
import { writeSecurityAudit } from './audit';
import { requireManageDrivers, requirePlatformAdmin } from './adminAuth';
import { resolveCompanyJoinCode } from './companyOnboarding';
import {
  PENDING_REGISTRATION_TTL_MS,
  isPendingExpired,
  pendingExpiresAtMs,
  pendingReservationId,
  pollStatusFor,
  reservationIsActive,
} from './registrationLifecycle';
import {
  claimRefusalMessage,
  decideCompensation,
  decideNameIndexClaim,
  readIncumbentCredential,
  readIndexOwner,
  type IncumbentCredentialState,
} from './nameIndexClaim';
import {
  readSessionAudience,
  containsClientClaimMaterial,
  sessionClaimsForAudience,
} from '@tester3x/wellbuilt-contracts';
import type { GlobalDriverClaims, SessionDriverClaims } from './tokenMint';

const rtdb = () => admin.database();
const fs = () => admin.firestore();

async function releasePendingReservation(nameNorm: string, pendingId: string, status: string): Promise<void> {
  const ref = fs().collection('driver_provisioning_attempts').doc(pendingReservationId(nameNorm));
  await fs().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (snap.exists && snap.data()?.pendingId === pendingId) {
      tx.set(ref, { ...snap.data(), status, closedAtMs: Date.now() });
    }
  });
}

async function expirePendingRegistration(
  pendingId: string,
  pending: Record<string, unknown>,
  nowMs: number,
): Promise<boolean> {
  if (!isPendingExpired(pending, nowMs)) return false;
  const credRef = fs().collection('pending_credentials').doc(pendingId);
  let nameNorm = String(pending.nameNorm || '');
  const claimed = await fs().runTransaction(async tx => {
    const snap = await tx.get(credRef);
    const value = snap.data();
    nameNorm = String(value?.displayNameNorm || nameNorm);
    // A missing credential is a recoverable partial write. The authoritative
    // RTDB request still expires, but credential material must never be recreated.
    if (!snap.exists) return true;
    if (value?.status === 'expired') return true;
    if ((value?.status || 'pending') !== 'pending' || Number(value?.expiresAtMs || pendingExpiresAtMs(pending, nowMs)) > nowMs) return false;
    tx.update(credRef, { status: 'expired', closedAtMs: nowMs, passcode: FieldValue.delete() });
    return true;
  });
  if (!claimed) return false;
  if (!nameNorm) {
    const reservation = await fs().collection('driver_provisioning_attempts')
      .where('pendingId', '==', pendingId).limit(1).get();
    const value = reservation.docs[0]?.data();
    if (value?.pendingId === pendingId) nameNorm = String(value.nameNorm || '');
  }
  const ref = rtdb().ref(`drivers/pending_secure/${pendingId}`);
  await ref.update({ status: 'expired', expiredAt: nowMs });
  if (nameNorm) await releasePendingReservation(nameNorm, pendingId, 'expired');
  await rtdb().ref(`drivers/pending/${pendingId}`).update({ status: 'expired', expiredAt: nowMs }).catch(() => undefined);
  return true;
}

/** Flip true only after all clients register App Check. */
const ENFORCE_APPCHECK = process.env.SECURITY_ENFORCE_APPCHECK === 'true';

function assertAppCheck(request: httpsV2.CallableRequest): void {
  if (!ENFORCE_APPCHECK) return;
  if (!request.app) {
    throw new httpsV2.HttpsError('failed-precondition', 'App Check required');
  }
}

function clientMeta(request: httpsV2.CallableRequest) {
  const ip =
    (request.rawRequest?.headers?.['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    request.rawRequest?.ip ||
    undefined;
  return {
    ipHash: hashIp(ip),
    appCheckPresent: !!request.app,
    appId: request.app?.appId || null,
  };
}

function mapValidationError(code: string): never {
  const map: Record<string, string> = {
    invalid_display_name: 'Display name is required (2–64 characters)',
    invalid_display_name_chars: 'Display name contains invalid characters',
    invalid_passcode_length: 'Passcode must be 6–128 characters',
    invalid_legal_name: 'Legal name is too long',
    invalid_company_name: 'Company name is too long',
  };
  throw new httpsV2.HttpsError('invalid-argument', map[code] || code);
}

// ── Registration ──────────────────────────────────────────────────────────

export const requestDriverRegistration = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    assertAppCheck(request);
    const meta = clientMeta(request);
    const allowed = await checkRateLimit({
      bucket: 'register',
      key: meta.ipHash,
      limit: 5,
      windowMs: 60 * 60 * 1000,
    });
    if (!allowed) {
      throw new httpsV2.HttpsError('resource-exhausted', 'Too many registration attempts. Try later.');
    }

    let fields: ReturnType<typeof validateRegistrationFields>;
    try {
      fields = validateRegistrationFields(request.data || {});
    } catch (e) {
      mapValidationError((e as Error).message);
    }

    const nameNorm = normalizeDisplayName(fields.displayName);
    const source = typeof (request.data as any)?.source === 'string'
      ? String((request.data as any).source).slice(0, 16)
      : 'unknown';
    const companyCode = String((request.data as any)?.companyCode || '').trim();
    if (!companyCode) {
      throw new httpsV2.HttpsError('invalid-argument', 'Company join code is required');
    }
    const company = await resolveCompanyJoinCode(companyCode);

    // Block if active secure driver already uses this display name
    const idx = await fs().collection('driver_name_index').doc(nameNorm).get();
    if (idx.exists) {
      const existingId = idx.data()?.driverId as string | undefined;
      if (existingId) {
        const cred = await fs().collection('driver_credentials').doc(existingId).get();
        if (cred.exists && cred.data()?.active !== false) {
          throw new httpsV2.HttpsError(
            'already-exists',
            'This name is already registered. Sign in or choose another name.',
          );
        }
      }
    }

    const candidatePendingId = randomUUID();
    const passcodeRecord = await hashPasscodeScrypt(fields.passcode);
    const requestedAtMs = Date.now();
    const expiresAtMs = requestedAtMs + PENDING_REGISTRATION_TTL_MS;
    // Registration reservation lives in the existing durable provisioning
    // journal collection, namespaced separately from approval attempts.
    const reservationRef = fs().collection('driver_provisioning_attempts').doc(pendingReservationId(nameNorm));
    const reservation = await fs().runTransaction(async tx => {
      const existing = await tx.get(reservationRef);
      const value = existing.data();
      if (reservationIsActive(value, requestedAtMs)) {
        if (value?.companyId !== company.companyId) {
          throw new httpsV2.HttpsError('already-exists', 'A registration for this name is already pending');
        }
        return { pendingId: String(value.pendingId), created: false, record: value! };
      }
      const record = {
        pendingId: candidatePendingId,
        nameNorm,
        displayName: fields.displayName,
        legalName: fields.legalName || null,
        companyName: company.companyName,
        companyId: company.companyId,
        source,
        appId: meta.appId,
        status: 'pending',
        requestedAtMs,
        expiresAtMs,
      };
      tx.set(reservationRef, record);
      tx.set(fs().collection('pending_credentials').doc(candidatePendingId), {
        passcode: passcodeRecord,
        displayNameNorm: nameNorm,
        status: 'pending',
        createdAtMs: requestedAtMs,
        expiresAtMs,
      });
      return { pendingId: candidatePendingId, created: true, record };
    });
    const pendingId = reservation.pendingId;
    const canonical = reservation.record;

    // Stable, idempotent cross-store projection. A retry repairs a prior
    // partial RTDB failure without replacing the original passcode.
    await rtdb().ref(`drivers/pending_secure/${pendingId}`).set({
      displayName: canonical.displayName,
      nameNorm: canonical.nameNorm,
      legalName: canonical.legalName,
      companyName: canonical.companyName,
      companyId: canonical.companyId,
      resolvedCompanyName: canonical.companyName,
      source: canonical.source,
      status: 'pending',
      schemaVersion: 2,
      requestedAt: canonical.requestedAtMs,
      expiresAtMs: canonical.expiresAtMs,
      appId: canonical.appId,
    });

    // Stable mirror key prevents retries from creating duplicate legacy rows.
    await rtdb().ref(`drivers/pending/${pendingId}`).set({
      displayName: canonical.displayName,
      legalName: canonical.legalName,
      companyName: canonical.companyName,
      companyId: canonical.companyId,
      resolvedCompanyName: canonical.companyName,
      source: canonical.source,
      status: 'pending',
      requestedAt: canonical.requestedAtMs,
      expiresAtMs: canonical.expiresAtMs,
      securePendingId: pendingId,
    });

    await writeSecurityAudit({
      action: 'requestDriverRegistration',
      appId: meta.appId,
      appCheckPresent: meta.appCheckPresent,
      ipHash: meta.ipHash,
      detail: { source, companyId: company.companyId, retry: !reservation.created },
    });

    return {
      pendingId,
      legacyPendingKey: pendingId,
      status: 'pending' as const,
    };
  },
);

export const checkDriverRegistrationStatus = httpsV2.onCall(
  { timeoutSeconds: 15, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const pendingId = String((request.data as any)?.pendingId || '').trim();
    if (!pendingId || pendingId.length > 80) {
      throw new httpsV2.HttpsError('invalid-argument', 'pendingId required');
    }
    const snap = await rtdb().ref(`drivers/pending_secure/${pendingId}`).once('value');
    if (!snap.exists()) {
      return { status: 'none' as const };
    }
    const value = snap.val() as Record<string, unknown>;
    const nowMs = Date.now();
    if (isPendingExpired(value, nowMs)) {
      if (await expirePendingRegistration(pendingId, value, nowMs)) {
        return { status: 'rejected' as const, terminalReason: 'expired' as const };
      }
      const credential = await fs().collection('pending_credentials').doc(pendingId).get();
      if (credential.data()?.status === 'approving') {
        return { status: 'pending' as const };
      }
    }
    const status = pollStatusFor(value, nowMs);
    if (status === 'approved') {
      const driverId = value.driverId as string | undefined;
      return { status: 'approved' as const, driverId: driverId || null };
    }
    if (status === 'rejected') {
      const terminalReason = value.status === 'expired' || value.status === 'cancelled'
        ? value.status : undefined;
      return { status: 'rejected' as const, terminalReason };
    }
    return { status: 'pending' as const };
  },
);

// ── Login ─────────────────────────────────────────────────────────────────

export const authenticateDriver = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    // vc51.9K: optional session audience. Read BEFORE any credential
    // work so a hostile request fails without touching the passcode path.
    if (containsClientClaimMaterial(request.data)) {
      throw new httpsV2.HttpsError(
        'invalid-argument',
        'Request may not contain claim material',
      );
    }
    const audience = readSessionAudience(request.data);
    if (audience.kind === 'rejected') {
      throw new httpsV2.HttpsError('invalid-argument', 'Unsupported session audience');
    }

    assertAppCheck(request);
    const meta = clientMeta(request);
    const displayName = String((request.data as any)?.displayName || '').trim();
    const passcode = String((request.data as any)?.passcode || '');
    if (!displayName || !passcode) {
      throw new httpsV2.HttpsError('invalid-argument', 'displayName and passcode required');
    }

    const nameNorm = normalizeDisplayName(displayName);
    const allowed = await checkRateLimit({
      bucket: 'login',
      key: `${nameNorm}:${meta.ipHash}`,
      limit: 10,
      windowMs: 15 * 60 * 1000,
    });
    if (!allowed) {
      throw new httpsV2.HttpsError('resource-exhausted', 'Too many login attempts. Try later.');
    }

    const idx = await fs().collection('driver_name_index').doc(nameNorm).get();
    if (!idx.exists) {
      await writeSecurityAudit({
        action: 'authenticateDriver_fail',
        ipHash: meta.ipHash,
        appCheckPresent: meta.appCheckPresent,
        detail: { reason: 'unknown_name' },
      });
      throw new httpsV2.HttpsError('permission-denied', 'Invalid name or passcode');
    }
    const driverId = idx.data()?.driverId as string;
    const credSnap = await fs().collection('driver_credentials').doc(driverId).get();
    if (!credSnap.exists) {
      throw new httpsV2.HttpsError('permission-denied', 'Invalid name or passcode');
    }
    const cred = credSnap.data()!;
    if (cred.active === false) {
      throw new httpsV2.HttpsError('permission-denied', 'This account has been deactivated');
    }

    const ok = await verifyPasscodeScrypt(passcode, cred.passcode as ScryptRecord);
    if (!ok) {
      await writeSecurityAudit({
        action: 'authenticateDriver_fail',
        driverId,
        ipHash: meta.ipHash,
        appCheckPresent: meta.appCheckPresent,
        detail: { reason: 'bad_passcode' },
      });
      throw new httpsV2.HttpsError('permission-denied', 'Invalid name or passcode');
    }

    const profileSnap = await rtdb().ref(`drivers/profiles/${driverId}`).once('value');
    const profile = profileSnap.val() || {};
    if (profile.active === false) {
      throw new httpsV2.HttpsError('permission-denied', 'This account has been deactivated');
    }

    const mustChangePasscode = cred.mustResetPasscode === true;

    const { ensureDriverAuthUser, mintDriverSessionTokens } = await import('./tokenMint');
    const authUid = await ensureDriverAuthUser(
      driverId,
      profile.displayName || displayName,
    );

    const roles: string[] = Array.isArray(profile.roles) ? profile.roles : ['driver'];

    // GLOBAL: authoritative identity, shared by every app on this UID.
    const globalClaims: GlobalDriverClaims = {
      kind: 'driver',
      driverId,
      companyId: profile.companyId || null,
      roles,
      mustChangePasscode,
    };

    // PER-SESSION: the requested audience, this token only. Absent
    // audience yields {} and therefore exactly the previous behavior.
    const sessionClaims: SessionDriverClaims = sessionClaimsForAudience(audience);

    const minted = await mintDriverSessionTokens(authUid, globalClaims, sessionClaims);

    await rtdb().ref(`drivers/identityProofs/${driverId}`).update({
      secureLoginAt: Date.now(),
      secureLoginDriverId: driverId,
      secureLoginUid: authUid,
    });

    await writeSecurityAudit({
      action: mustChangePasscode ? 'authenticateDriver_must_change' : 'authenticateDriver_ok',
      actorUid: authUid,
      driverId,
      ipHash: meta.ipHash,
      appCheckPresent: meta.appCheckPresent,
      appId: meta.appId,
      detail: { mintMethod: minted.mintMethod },
    });

    return {
      customToken: minted.customToken || null,
      idToken: minted.idToken || null,
      refreshToken: minted.refreshToken || null,
      mintMethod: minted.mintMethod,
      driverId,
      displayName: profile.displayName || displayName,
      legalName: profile.legalName || null,
      companyId: profile.companyId || null,
      companyName: profile.companyName || null,
      isAdmin: profile.isAdmin === true,
      isViewer: profile.isViewer === true,
      assignedRoutes: profile.assignedRoutes || null,
      defaultPackageId: profile.defaultPackageId || null,
      roles,
      mustChangePasscode,
    };
  },
);

/**
 * Driver replaces their own passcode (required after temporary admin assignment).
 * Requires Firebase Auth custom token from authenticateDriver. Never logs passcodes.
 */
export const driverChangeOwnPasscode = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    assertAppCheck(request);
    if (!request.auth?.uid || request.auth.token?.kind !== 'driver') {
      throw new httpsV2.HttpsError('unauthenticated', 'Driver sign-in required');
    }
    const driverId = String(request.auth.token.driverId || '');
    if (!driverId) {
      throw new httpsV2.HttpsError('permission-denied', 'Missing driverId claim');
    }
    const currentPasscode = String((request.data as any)?.currentPasscode || '');
    const newPasscode = String((request.data as any)?.newPasscode || '');
    try {
      validateRegistrationFields({
        displayName: 'validname',
        passcode: newPasscode,
      });
    } catch (e) {
      mapValidationError((e as Error).message);
    }
    if (newPasscode.length < PASSCODE_MIN_LEN) {
      throw new httpsV2.HttpsError('invalid-argument', 'New passcode too short');
    }
    if (currentPasscode === newPasscode) {
      throw new httpsV2.HttpsError('invalid-argument', 'New passcode must differ from current');
    }

    const credRef = fs().collection('driver_credentials').doc(driverId);
    const credSnap = await credRef.get();
    if (!credSnap.exists) {
      throw new httpsV2.HttpsError('not-found', 'Credentials not found');
    }
    const cred = credSnap.data()!;
    const ok = await verifyPasscodeScrypt(currentPasscode, cred.passcode as ScryptRecord);
    if (!ok) {
      throw new httpsV2.HttpsError('permission-denied', 'Current passcode is incorrect');
    }
    const passcodeRecord = await hashPasscodeScrypt(newPasscode);
    await credRef.update({
      passcode: passcodeRecord,
      mustResetPasscode: false,
      updatedAt: FieldValue.serverTimestamp(),
      passcodeChangedAt: FieldValue.serverTimestamp(),
      // Invalidate any pending cleanup ownership. This is a partial update,
      // so without clearing it an admin create/reset whose RTDB write later
      // failed would still match its own opId and delete the passcode the
      // driver just set.
      opId: FieldValue.delete(),
    });
    // Clear mustChangePasscode claim on next token; update claims now
    const authUid = request.auth.uid;
    const existing = (await admin.auth().getUser(authUid)).customClaims || {};
    await admin.auth().setCustomUserClaims(authUid, {
      ...existing,
      mustChangePasscode: false,
    });

    await writeSecurityAudit({
      action: 'driverChangeOwnPasscode',
      actorUid: authUid,
      driverId,
      // never include passcode material
    });
    return { ok: true, mustChangePasscode: false };
  },
);

// ── Admin ─────────────────────────────────────────────────────────────────

export const adminListPendingRegistrations = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB' },
  async (request) => {
    const caller = await requireManageDrivers(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );
    const snap = await rtdb().ref('drivers/pending_secure').once('value');
    const out: any[] = [];
    if (snap.exists()) {
      const val = snap.val();
      for (const [pendingId, raw] of Object.entries(val)) {
        const p = raw as any;
        if (await expirePendingRegistration(pendingId, p, Date.now())) continue;
        if (p.status === 'approved' || p.status === 'rejected') continue;
        if (p.status === 'expired' || p.status === 'cancelled') continue;
        if (caller.companyId && p.companyId !== caller.companyId) continue;
        out.push({
          pendingId,
          displayName: p.displayName,
          legalName: p.legalName,
          companyName: p.resolvedCompanyName || p.companyName,
          companyId: p.companyId || null,
          source: p.source,
          requestedAt: p.requestedAt,
          status: p.status || 'pending',
        });
      }
    }
    // Also surface legacy open pending (evidence / dual-run), read-only
    const legacy = await rtdb().ref('drivers/pending').once('value');
    const legacyPending: any[] = [];
    if (legacy.exists()) {
      for (const [key, raw] of Object.entries(legacy.val())) {
        const p = raw as any;
        if (p.status === 'approved' || p.status === 'rejected' || p.status === 'expired' || p.status === 'cancelled') continue;
        if (pendingExpiresAtMs(p, Date.now()) <= Date.now()) continue;
        if (caller.companyId && p.companyId !== caller.companyId) continue;
        legacyPending.push({
          key,
          displayName: p.displayName,
          legalName: p.legalName,
          companyName: p.resolvedCompanyName || p.companyName,
          companyId: p.companyId || null,
          source: p.source,
          requestedAt: p.requestedAt,
          securePendingId: p.securePendingId || null,
          passcodeHash: p.passcodeHash ? String(p.passcodeHash).slice(0, 8) + '…' : null,
        });
      }
    }
    await writeSecurityAudit({
      action: 'adminListPending',
      actorUid: caller.uid,
    });
    return { pending: out, legacyPending };
  },
);

export const adminApproveDriverRegistration = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB' },
  async (request) => {
    const caller = await requireManageDrivers(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );
    const data = (request.data || {}) as {
      pendingId?: string;
      companyId?: string;
      companyName?: string;
      assignedCustomers?: { name: string; companyId: string }[];
      assignedRoutes?: string[];
      roles?: string[];
    };
    const pendingId = String(data.pendingId || '').trim();
    if (!pendingId) {
      throw new httpsV2.HttpsError('invalid-argument', 'pendingId required');
    }

    const pendingRef = rtdb().ref(`drivers/pending_secure/${pendingId}`);
    const pendingSnap = await pendingRef.once('value');
    if (!pendingSnap.exists()) {
      throw new httpsV2.HttpsError('not-found', 'Pending registration not found');
    }
    const pending = pendingSnap.val();
    if (caller.companyId && pending.companyId !== caller.companyId) {
      throw new httpsV2.HttpsError('permission-denied', 'Employee request belongs to another company');
    }

    /**
     * Read the durable attempt record BEFORE any pending-state guard.
     *
     * Finalization touches three stores in sequence, so a crash can land
     * with the attempt already complete but the RTDB row still `pending`
     * and the pending credential already gone. Checking credentials first
     * (as this did) answered "ask the driver to re-register" for an
     * identity that HAD been provisioned — the non-recoverable case. The
     * journal is the only record that survives every one of those crash
     * points, so it is consulted first and heals whatever is missing.
     */
    const { firestoreProvisioningJournal } = await import('./operational/provisioningJournalStore');
    const { resolveProvisioningUuid, attemptKeyId } = await import('./operational/provisioningJournal');
    const journal = firestoreProvisioningJournal(fs());
    const attemptKey = { kind: 'pending' as const, pendingId };
    const priorAttempt = await journal.read(attemptKeyId(attemptKey));
    if (priorAttempt?.completed) {
      // Same logical success, plus the writes the crash cut short.
      const staleCredRef = fs().collection('pending_credentials').doc(pendingId);
      const staleNameNorm = String((await staleCredRef.get()).data()?.displayNameNorm || '');
      await staleCredRef.delete();
      if (pending.status !== 'approved') {
        await pendingRef.update({
          status: 'approved',
          driverId: priorAttempt.driverId,
          approvedAt: ServerValue.TIMESTAMP,
          approvedBy: caller.uid,
        });
      }
      if (staleNameNorm) await releasePendingReservation(staleNameNorm, pendingId, 'approved');
      return {
        driverId: priorAttempt.driverId,
        displayName: pending.displayName,
        companyId: priorAttempt.companyId,
        companyName: pending.companyName || null,
        alreadyProvisioned: true as const,
      };
    }

    const approvalNowMs = Date.now();
    // The RTDB request timestamp is authoritative. Refuse approval at the
    // boundary even if cleanup has not yet tombstoned the credential copy.
    if (isPendingExpired(pending, approvalNowMs)) {
      await expirePendingRegistration(pendingId, pending, approvalNowMs);
      throw new httpsV2.HttpsError('failed-precondition', 'Registration expired');
    }
    const approvalCredRef = fs().collection('pending_credentials').doc(pendingId);
    const approvalCred = await approvalCredRef.get();
    const approvalNameNorm = String(approvalCred.data()?.displayNameNorm || '');
    const approvalReservationRef = fs().collection('driver_provisioning_attempts').doc(pendingReservationId(approvalNameNorm));
    const approvalClaim = await fs().runTransaction(async tx => {
      const snap = await tx.get(approvalCredRef);
      const value = snap.data();
      if (!snap.exists) return false;
      if (value?.status === 'approving') return true;
      if (value?.status !== 'pending' || Number(value.expiresAtMs) <= approvalNowMs) return false;
      tx.set(approvalCredRef, { ...value, status: 'approving', approvalStartedAt: approvalNowMs, approvalStartedBy: caller.uid });
      return true;
    });
    if (!approvalClaim) {
      if (await expirePendingRegistration(pendingId, pending, approvalNowMs)) {
        throw new httpsV2.HttpsError('failed-precondition', 'Registration expired');
      }
      throw new httpsV2.HttpsError('failed-precondition', `Already ${pending.status || 'closed'}`);
    }
    await approvalReservationRef.update({ status: 'approving', approvalStartedAt: approvalNowMs }).catch(() => undefined);
    await pendingRef.update({ status: 'approving', approvalStartedAt: approvalNowMs, approvalStartedBy: caller.uid });

    if (pending.status && pending.status !== 'pending' && pending.status !== 'approving') {
      throw new httpsV2.HttpsError('failed-precondition', `Already ${pending.status}`);
    }

    let companyId = (pending.companyId || data.companyId || '').trim().toLowerCase() || null;
    let companyName = (pending.resolvedCompanyName || data.companyName || pending.companyName || '').trim() || null;
    if (caller.companyId) {
      companyId = caller.companyId;
    }
    if (!companyId && !caller.isPlatformAdmin) {
      throw new httpsV2.HttpsError('invalid-argument', 'companyId required');
    }

    const credPending = await fs().collection('pending_credentials').doc(pendingId).get();
    if (!credPending.exists) {
      throw new httpsV2.HttpsError('failed-precondition', 'Pending credentials missing — ask driver to re-register via secure app');
    }
    const pendingCred = credPending.data()!;
    const nameNorm = pendingCred.displayNameNorm as string;
    const passcode = pendingCred.passcode as ScryptRecord;

    /**
     * ONE canonical UUID per pending registration, chosen durably.
     *
     * This used to be `randomUUID()` per invocation, which meant a retry
     * after a failed authority write minted a SECOND identity — and because
     * the pending credential was consumed in the identity transaction
     * below, the attempt could not be retried at all. The journal makes the
     * choice survive a crash: the first attempt records it, every retry
     * reads it back, and concurrent retries converge on one entry.
     */
    let authorityOutcomeLabel = 'not_attempted';
    const resolved = await resolveProvisioningUuid(journal, attemptKey, {
      nameNorm,
      companyId,
    });
    if (resolved.decision.action === 'refuse') {
      throw new httpsV2.HttpsError('failed-precondition', `provisioning_refused:${resolved.decision.reason}`);
    }
    if (resolved.decision.action === 'already_completed') {
      // Idempotent: this registration was already provisioned. Return the
      // same logical success rather than demanding re-registration.
      return { driverId: resolved.decision.driverId, status: 'approved' as const, alreadyProvisioned: true };
    }
    const driverId = resolved.driverId!;

    // Name index claim
    const idxRef = fs().collection('driver_name_index').doc(nameNorm);
    await fs().runTransaction(async (tx) => {
      const existing = await tx.get(idxRef);
      if (existing.exists && existing.data()?.driverId !== driverId) {
        const other = existing.data()?.driverId;
        const otherCred = await tx.get(fs().collection('driver_credentials').doc(other));
        if (otherCred.exists && otherCred.data()?.active !== false) {
          throw new httpsV2.HttpsError('already-exists', 'Display name already taken');
        }
      }
      tx.set(idxRef, { driverId });
      tx.set(fs().collection('driver_credentials').doc(driverId), {
        displayNameNorm: nameNorm,
        displayName: pending.displayName,
        passcode,
        active: true,
        mustResetPasscode: false,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        pendingId,
      });
      // NOT deleted here. Consuming the pending credential before the
      // canonical profile and required authority exist made a failure
      // unrecoverable: the identity was written, the pending state was
      // gone, and a retry could only answer "ask the driver to
      // re-register". It is finalized after provisioning succeeds.
    });

    const roles = Array.isArray(data.roles) && data.roles.length ? data.roles : ['driver'];
    const profile: Record<string, unknown> = {
      displayName: pending.displayName,
      legalName: pending.legalName || pending.displayName,
      name: pending.displayName,
      active: true,
      isAdmin: roles.includes('admin'),
      isViewer: roles.includes('viewer'),
      approvedAt: Date.now(),
      approvedBy: caller.uid,
      roles,
      companyId,
      companyName,
      registrationCompany: pending.companyName || null,
      source: pending.source || null,
      schemaVersion: 1,
    };
    if (data.assignedCustomers?.length) profile.assignedCustomers = data.assignedCustomers;
    if (data.assignedRoutes?.length) profile.assignedRoutes = data.assignedRoutes;

    await rtdb().ref(`drivers/profiles/${driverId}`).set(profile);

    // Company-bound drivers need an initialized empty shift pointer so resolve
    // can return `none` and claim can run under explicit_shift. Canonical UUID
    // only — never the legacy approved hash. Fail closed if ensure refuses.
    {
      const {
        ensureInitializedEmptyShiftAuthority,
        assertEnsureAuthorityOk,
      } = await import('./operational/ensureEmptyShiftAuthority');
      const ensure = await ensureInitializedEmptyShiftAuthority(fs(), {
        driverId,
        companyId,
      });
      try {
        assertEnsureAuthorityOk(ensure);
      } catch {
        throw new httpsV2.HttpsError(
          'failed-precondition',
          'shift_authority_ensure_refused',
        );
      }
      // A company-bound approval that SKIPPED authority is a failure, not a
      // success: skip means no company was seen, which contradicts the
      // binding and would leave the driver unable to claim a shift.
      const { decideProvisioningOutcome, authorityAuditLabel } =
        await import('./operational/provisioningJournal');
      const outcome = decideProvisioningOutcome({
        identityWritten: true,
        profileWritten: true,
        authorityAction: ensure.decision.action,
        companyId,
      });
      if (!outcome.ok) {
        throw new httpsV2.HttpsError('failed-precondition', `provisioning_incomplete:${outcome.reason}`);
      }
      authorityOutcomeLabel = authorityAuditLabel(outcome);
    }

    /**
     * FINALIZE — only now that identity, profile and the required authority
     * all exist. Consuming the pending credential is what makes the attempt
     * unrepeatable, so it must be the last step, not the first.
     *
     * The journal is marked FIRST and the credential consumed second: a
     * crash between them leaves an inert leftover that the next call
     * deletes, whereas the reverse order would leave a completed identity
     * with no evidence and no pending credential — unrecoverable again.
     */
    await journal.markCompleted(resolved.attemptId);
    await fs().collection('pending_credentials').doc(pendingId).delete();

    await pendingRef.update({
      status: 'approved',
      driverId,
      approvedAt: ServerValue.TIMESTAMP,
      approvedBy: caller.uid,
    });
    await releasePendingReservation(nameNorm, pendingId, 'approved');

    // Dual-run: also write a non-login legacy approved stub? NO — do not write
    // client-guessable SHA keys. Old clients will break at enforcement by design.

    // Mark any legacy pending rows with this securePendingId
    const legacySnap = await rtdb().ref('drivers/pending').once('value');
    if (legacySnap.exists()) {
      const updates: Record<string, unknown> = {};
      for (const [key, raw] of Object.entries(legacySnap.val())) {
        const p = raw as any;
        if (p.securePendingId === pendingId || (p.displayName === pending.displayName && !p.passcodeHash && p.status !== 'approved')) {
          updates[`${key}/status`] = 'approved';
          updates[`${key}/driverId`] = driverId;
        }
      }
      if (Object.keys(updates).length) {
        await rtdb().ref('drivers/pending').update(updates);
      }
    }

    await writeSecurityAudit({
      action: 'adminApproveDriverRegistration',
      actorUid: caller.uid,
      driverId,
      detail: { companyId, shiftAuthority: authorityOutcomeLabel },
    });

    return { driverId, displayName: pending.displayName, companyId, companyName };
  },
);

export const adminRejectDriverRegistration = httpsV2.onCall(
  { timeoutSeconds: 20, memory: '256MiB' },
  async (request) => {
    const caller = await requireManageDrivers(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );
    const pendingId = String((request.data as any)?.pendingId || '').trim();
    const legacyKey = String((request.data as any)?.legacyKey || '').trim();

    if (pendingId) {
      const ref = rtdb().ref(`drivers/pending_secure/${pendingId}`);
      const snap = await ref.once('value');
      if (snap.exists()) {
        const pending = snap.val();
        if (caller.companyId && pending.companyId !== caller.companyId) {
          throw new httpsV2.HttpsError('permission-denied', 'Employee request belongs to another company');
        }
        const rejectedAt = Date.now();
        const credRef = fs().collection('pending_credentials').doc(pendingId);
        const nameNorm = String((await credRef.get()).data()?.displayNameNorm || '');
        const rejected = await fs().runTransaction(async tx => {
          const credential = await tx.get(credRef);
          const value = credential.data();
          if (!credential.exists) return false;
          if (value?.status === 'rejected') return true;
          if ((value?.status || 'pending') !== 'pending') return false;
          tx.update(credRef, { status: 'rejected', closedAtMs: rejectedAt, passcode: FieldValue.delete() });
          return true;
        });
        if (!rejected) {
          throw new httpsV2.HttpsError('failed-precondition', `Already ${pending.status || 'closed'}`);
        }
        await ref.update({ status: 'rejected', rejectedAt, rejectedBy: caller.uid });
        // Keep pending_credentials tombstone? delete credential material only
        if (nameNorm) await releasePendingReservation(nameNorm, pendingId, 'rejected');
        await rtdb().ref(`drivers/pending/${pendingId}`).update({ status: 'rejected', rejectedAt, rejectedBy: caller.uid }).catch(() => undefined);
      }
    }

    if (legacyKey) {
      // Preserve document; mark rejected only — never delete (forensic)
      await rtdb().ref(`drivers/pending/${legacyKey}`).update({
        status: 'rejected',
        rejectedAt: Date.now(),
        rejectedBy: caller.uid,
      });
    }

    await writeSecurityAudit({
      action: 'adminRejectDriverRegistration',
      actorUid: caller.uid,
      detail: { secureRequest: !!pendingId, legacyRequest: !!legacyKey },
    });

    return { ok: true };
  },
);

/**
 * Create secure credentials for a legacy approved profile shell,
 * or force-reset passcode. Does not accept legacy SHA-256 for login.
 */
/**
 * Assign or reset a driver's secure passcode.
 *
 * IMPORTANT:
 * - `passcode` is a NEW user-chosen or temporary value — NEVER derived from legacyHash.
 * - legacyHash is only used to COPY profile metadata (name, company, routes).
 * - Admin-assigned credentials default to temporary=true → mustResetPasscode so the
 *   driver must call driverChangeOwnPasscode at first secure sign-in.
 * - Passcodes are never written to security_audit.
 */
export const adminSetDriverPasscode = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB' },
  async (request) => {
    const caller = await requireManageDrivers(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );
    const data = (request.data || {}) as {
      driverId?: string;
      displayName?: string;
      passcode?: string;
      /** Profile metadata source only — never used as credential material */
      legacyHash?: string;
      /**
       * Exact drivers/approved/{key} for create-from-legacy. Not a display
       * name and not used as the new canonical id. Required on create so a
       * new UUID cannot be minted unlinked beside an existing approved row.
       */
      approvedKey?: string;
      companyId?: string;
      companyName?: string;
      legalName?: string;
      /**
       * When true (default), driver must change passcode after first secure login.
       * Set false only when the driver themselves chose the passcode via admin UI
       * in their presence (still prefer user-controlled change flow).
       */
      temporary?: boolean;
      /** When true with legacyHash, leave legacy drivers/approved active (dual-run). */
      keepLegacyActive?: boolean;
    };

    let fields: ReturnType<typeof validateRegistrationFields>;
    try {
      fields = validateRegistrationFields({
        displayName: data.displayName,
        passcode: data.passcode,
        legalName: data.legalName,
        companyName: data.companyName,
      });
    } catch (e) {
      mapValidationError((e as Error).message);
    }

    // Reject obviously short PIN-only reuse (still allow 6+ digit if user wants)
    if (/^\d{1,5}$/.test(fields.passcode)) {
      throw new httpsV2.HttpsError(
        'invalid-argument',
        'Passcode must be at least 6 characters; short numeric PINs are not allowed',
      );
    }

    const temporary = data.temporary !== false; // default true
    /**
     * Cleanup-ownership marker for THIS invocation.
     *
     * Random, non-secret, and never consulted when authenticating — its
     * only job is to let compensation prove the credential it is about to
     * delete is still the one this invocation wrote. Any later legitimate
     * write (admin reset, approval, or the driver changing their own
     * passcode) replaces or clears it, so a stale compensation no longer
     * matches and leaves the newer credential alone.
     *
     * Generated once here, outside the transaction, so Firestore retries
     * reuse it exactly as the candidate driverId does.
     */
    const opId = randomUUID();
    const nameNorm = normalizeDisplayName(fields.displayName);
    const passcodeRecord = await hashPasscodeScrypt(fields.passcode);
    let driverId = (data.driverId || '').trim();

    /**
     * Durable UUID selection for THIS provisioning attempt.
     *
     * Both branches below used to call randomUUID() directly, so a retry
     * that omitted driverId minted a SECOND canonical identity after a
     * partial success. The journal keys the attempt by its stable target —
     * the legacy row being migrated, or the normalized name being created —
     * and returns the same UUID on every retry. A name whose index is owned
     * by an ACTIVE unrelated credential is refused, never adopted.
     */
    const { firestoreProvisioningJournal } = await import('./operational/provisioningJournalStore');
    const { resolveProvisioningUuid } = await import('./operational/provisioningJournal');
    const provJournal = firestoreProvisioningJournal(fs());
    const idxNow = await fs().collection('driver_name_index').doc(nameNorm).get();
    const idxOwner = (idxNow.exists ? idxNow.data()?.driverId : null) as string | null;
    let idxOwnerActive = false;
    if (idxOwner) {
      const c = await fs().collection('driver_credentials').doc(idxOwner).get();
      idxOwnerActive = c.exists && c.data()?.active !== false;
    }
    let provAttemptId: string | null = null;
    let setPasscodeAuthorityLabel = 'not_attempted';
    const claimProvisioningUuid = async (key: Parameters<typeof resolveProvisioningUuid>[1]) => {
      const r = await resolveProvisioningUuid(provJournal, key, {
        requestedDriverId: driverId || null,
        nameNorm,
        companyId: (typeof data.companyId === 'string' && data.companyId.trim())
          ? data.companyId.trim().toLowerCase() : null,
        indexOwnerDriverId: idxOwner,
        indexOwnerActive: idxOwnerActive,
        isReset: !!driverId,
      });
      if (r.decision.action === 'refuse') {
        throw new httpsV2.HttpsError(
          'failed-precondition',
          `provisioning_refused:${r.decision.reason}`,
        );
      }
      provAttemptId = r.attemptId;
      return r.driverId!;
    };

    /**
     * RTDB writes deferred until the Firestore ownership claim commits.
     *
     * Firestore transactions cannot span the Realtime Database, so true
     * single-transaction atomicity across both is impossible. Writing the
     * profile FIRST (as this did) meant a refused name claim left an
     * orphaned profile — and, on the migration path, mutated the legacy
     * record — for an identity that was never created. Building the
     * payloads here and applying them only after the claim commits makes a
     * refusal leave nothing behind.
     */
    let pendingProfile: Record<string, unknown> | null = null;
    let pendingLegacyLink: Record<string, unknown> | null = null;

    const { decideCreateSecureLoginLink } = await import('./operational/legacySecureLink');
    const linkDecision = decideCreateSecureLoginLink({
      driverId,
      approvedKey: data.approvedKey,
      legacyHash: data.legacyHash,
    });
    if (linkDecision.action === 'refuse') {
      throw new httpsV2.HttpsError(
        linkDecision.reason === 'approved_key_malformed' ? 'invalid-argument' : 'failed-precondition',
        linkDecision.reason,
      );
    }
    const approvedKey = linkDecision.action === 'create_from_approved' ? linkDecision.approvedKey : '';

    if (linkDecision.action === 'create_from_approved') {
      const { runApprovedRowConversion } = await import('./operational/approvedRowConversion');
      const { productionConversionStore } = await import('./operational/approvedRowConversionStore');
      const converted = await runApprovedRowConversion(
        productionConversionStore(fs(), rtdb()),
        {
          approvedKey,
          displayName: fields.displayName,
          legalName: fields.legalName,
          companyId: data.companyId,
          companyName: data.companyName,
          passcodeRecord,
          temporary,
          callerUid: caller.uid,
          opId,
        },
      );
      const { clientOutcomeFor } = await import('./operational/approvedRowConversion');
      const outcome = clientOutcomeFor(converted);
      await writeSecurityAudit({
        action: outcome.success ? 'approvedRowConversion' : 'approvedRowConversion_fail',
        actorUid: caller.uid,
        driverId: converted.driverId,
        detail: {
          approvedKeyPrefix: approvedKey.slice(0, 8),
          temporary,
          status: converted.status,
          reason: converted.reason,
          terminalProven: converted.terminalProven,
        },
      });
      if (!outcome.success) {
        throw new httpsV2.HttpsError(
          outcome.code === 'ok' ? 'internal' : outcome.code,
          outcome.reason === 'approved_conversion_rolled_back'
            ? 'Could not create the driver profile; no identity was created'
            : outcome.reason,
        );
      }
      return {
        driverId: converted.driverId,
        displayName: fields.displayName,
        mustChangePasscode: temporary,
      };
    }

    if (!driverId && data.legacyHash) {
      // Migrate PROFILE shell only — never use legacy SHA-256 as the new credential
      const legacy = await rtdb().ref(`drivers/approved/${data.legacyHash}`).once('value');
      if (!legacy.exists()) {
        throw new httpsV2.HttpsError('not-found', 'Legacy driver not found');
      }
      const L = legacy.val();
      // Keyed by the legacy row, so a retry migrating the SAME legacy
      // driver reuses its canonical UUID — never the approved hash.
      driverId = await claimProvisioningUuid({ kind: 'legacy', legacyHash: String(data.legacyHash) });
      // DEFERRED: written only after the ownership claim commits.
      pendingProfile = {
        displayName: fields.displayName || L.displayName,
        legalName: fields.legalName || L.legalName || L.displayName,
        name: fields.displayName || L.displayName,
        active: L.active !== false,
        isAdmin: L.isAdmin === true,
        isViewer: L.isViewer === true,
        companyId: data.companyId || L.companyId || null,
        companyName: data.companyName || L.companyName || null,
        assignedCustomers: L.assignedCustomers || null,
        assignedRoutes: L.assignedRoutes || null,
        assignedWells: L.assignedWells || null,
        roles: L.roles || ['driver'],
        approvedAt: L.approvedAt || Date.now(),
        migratedFromLegacyHashPrefix: String(data.legacyHash).slice(0, 8),
        schemaVersion: 1,
        mustUseSecureAuth: true,
      };
      // Dual-run default: keep legacy active so old APKs still work until
      // cutover. DEFERRED with the profile — a refused claim must not
      // rewrite the legacy record for an identity that never existed.
      pendingLegacyLink =
        data.keepLegacyActive === false
          ? {
              active: false,
              migratedToDriverId: driverId,
              legacyLoginDisabled: true,
            }
          : {
              migratedToDriverId: driverId,
              secureProfileLinked: true,
            };
    }

    if (!driverId) {
      // Brand-new admin-provisioned driver. Keyed by normalized name; an
      // active unrelated owner of that name is refused, not adopted.
      driverId = await claimProvisioningUuid({ kind: 'name', nameNorm });
      // DEFERRED: written only after the ownership claim commits.
      pendingProfile = {
        displayName: fields.displayName,
        legalName: fields.legalName || fields.displayName,
        name: fields.displayName,
        active: true,
        isAdmin: false,
        isViewer: false,
        companyId: data.companyId || caller.companyId || null,
        companyName: data.companyName || null,
        roles: ['driver'],
        approvedAt: Date.now(),
        approvedBy: caller.uid,
        schemaVersion: 1,
      };
    }

    // Claim the name index BEFORE writing the credential, and only if this
    // driver may hold it. The previous unconditional `set` let an authorized
    // reset for one name silently repoint another ACTIVE secure driver's
    // index, sending that driver's next authenticateDriver to a different
    // credential record. Same rule adminApproveDriverRegistration already
    // enforces; the transaction makes check-and-claim atomic so two
    // concurrent admins cannot both win.
    const idxRef = fs().collection('driver_name_index').doc(nameNorm);
    await fs().runTransaction(async (tx) => {
      const existing = await tx.get(idxRef);
      const existingDriverId = readIndexOwner(existing.exists, existing.data());

      let incumbentCredential: IncumbentCredentialState = 'absent';
      if (
        existingDriverId
        && existingDriverId !== 'malformed'
        && existingDriverId !== driverId
      ) {
        try {
          const otherCred = await tx.get(
            fs().collection('driver_credentials').doc(existingDriverId),
          );
          incumbentCredential = readIncumbentCredential(
            otherCred.exists,
            otherCred.data(),
          );
        } catch {
          // Status unknown — refuse rather than guess about someone
          // else's login name.
          incumbentCredential = 'unreadable';
        }
      }

      const decision = decideNameIndexClaim({
        existingDriverId,
        targetDriverId: driverId,
        incumbentCredential,
      });
      if (!decision.allow) {
        throw new httpsV2.HttpsError(
          decision.reason === 'name_taken' ? 'already-exists' : 'aborted',
          claimRefusalMessage(decision.reason),
        );
      }

      tx.set(idxRef, { driverId });
      tx.set(
        fs().collection('driver_credentials').doc(driverId),
        {
          displayNameNorm: nameNorm,
          displayName: fields.displayName,
          passcode: passcodeRecord,
          active: true,
          mustResetPasscode: temporary,
          updatedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
          setBy: caller.uid,
          temporaryAssigned: temporary,
          // Cleanup ownership only — see opId above. Not an authenticator.
          opId,
        },
        { merge: true },
      );
    });

    // Ownership is now ours and the credential is committed. Apply the
    // deferred RTDB writes.
    //
    // If any of them fails we COMPENSATE: the Firestore credential and our
    // index claim are removed so the caller is left with no partial
    // identity, matching the all-or-nothing guarantee the transaction gives
    // within Firestore. The index is released only if it is still ours, so
    // a concurrent legitimate owner is never disturbed.
    try {
      if (pendingProfile) {
        await rtdb().ref(`drivers/profiles/${driverId}`).set(pendingProfile);
      }
      if (pendingLegacyLink && data.legacyHash) {
        await rtdb().ref(`drivers/approved/${data.legacyHash}`).update(pendingLegacyLink);
      }
      if (pendingLegacyLink && approvedKey && !data.legacyHash) {
        await rtdb().ref(`drivers/approved/${approvedKey}`).update(pendingLegacyLink);
      }
      // Keep display fields current for pre-existing profiles (reset path).
      await rtdb().ref(`drivers/profiles/${driverId}`).update({
        displayName: fields.displayName,
        legalName: fields.legalName || fields.displayName,
      });
    } catch (profileErr) {
      let compensated = true;
      let superseded = false;
      try {
        // ONE transaction reads both documents and decides, so a
        // concurrent invocation cannot slip between the checks. An
        // unconditional delete here would destroy a newer credential
        // written by a legitimate reset that landed while our RTDB write
        // was failing.
        const credRef = fs().collection('driver_credentials').doc(driverId);
        await fs().runTransaction(async (tx) => {
          const [credSnap, idxSnap] = await Promise.all([
            tx.get(credRef),
            tx.get(idxRef),
          ]);
          const decision = decideCompensation({
            credentialExists: credSnap.exists,
            credentialOpId: credSnap.data()?.opId,
            myOpId: opId,
            indexExists: idxSnap.exists,
            indexDriverId: idxSnap.data()?.driverId,
            myDriverId: driverId,
          });
          superseded = decision.superseded;
          if (decision.deleteCredential) tx.delete(credRef);
          if (decision.releaseIndex) tx.delete(idxRef);
        });
      } catch {
        compensated = false;
      }
      await writeSecurityAudit({
        action: 'adminSetDriverPasscode_fail',
        actorUid: caller.uid,
        driverId,
        detail: { reason: 'profile_write_failed', compensated, superseded },
      });
      throw new httpsV2.HttpsError(
        'internal',
        !compensated
          ? // Say so plainly rather than report a clean failure we did not achieve.
            'Driver profile write failed AND cleanup failed; identity may be partially created'
          : superseded
            ? 'Could not create the driver profile; another change to this driver landed first and was left intact'
            : 'Could not create the driver profile; no identity was created',
      );
    }

    // Resolve company for authority ensure: never invent; prefer request /
    // pending create payload, else profile. Skip when unbound (standalone).
    let authorityCompanyId: string | null =
      (typeof data.companyId === 'string' && data.companyId.trim())
        ? data.companyId.trim().toLowerCase()
        : null;
    if (!authorityCompanyId && pendingProfile && typeof pendingProfile.companyId === 'string') {
      authorityCompanyId = String(pendingProfile.companyId).trim().toLowerCase() || null;
    }
    if (!authorityCompanyId) {
      try {
        const profSnap = await rtdb().ref(`drivers/profiles/${driverId}/companyId`).once('value');
        const cid = profSnap.val();
        if (typeof cid === 'string' && cid.trim()) {
          authorityCompanyId = cid.trim().toLowerCase();
        }
      } catch {
        /* leave null — ensure will skip */
      }
    }
    {
      const {
        ensureInitializedEmptyShiftAuthority,
        assertEnsureAuthorityOk,
      } = await import('./operational/ensureEmptyShiftAuthority');
      const ensure = await ensureInitializedEmptyShiftAuthority(fs(), {
        driverId,
        companyId: authorityCompanyId,
      });
      try {
        assertEnsureAuthorityOk(ensure);
      } catch {
        throw new httpsV2.HttpsError(
          'failed-precondition',
          'shift_authority_ensure_refused',
        );
      }
      // Company-bound and authority skipped is a FAILURE, not a success.
      const { decideProvisioningOutcome, authorityAuditLabel } =
        await import('./operational/provisioningJournal');
      const outcome = decideProvisioningOutcome({
        identityWritten: true,
        profileWritten: true,
        authorityAction: ensure.decision.action,
        companyId: authorityCompanyId,
      });
      if (!outcome.ok) {
        throw new httpsV2.HttpsError('failed-precondition', `provisioning_incomplete:${outcome.reason}`);
      }
      setPasscodeAuthorityLabel = authorityAuditLabel(outcome);
      // Finalize the attempt only now that the required state exists.
      if (provAttemptId) await provJournal.markCompleted(provAttemptId);
    }

    await writeSecurityAudit({
      action: 'adminSetDriverPasscode',
      actorUid: caller.uid,
      driverId,
      detail: {
        legacyHashPrefix: data.legacyHash ? String(data.legacyHash).slice(0, 8) : null,
        temporary,
        shiftAuthority: setPasscodeAuthorityLabel,
        // never log passcode
      },
    });

    return {
      driverId,
      displayName: fields.displayName,
      mustChangePasscode: temporary,
    };
  },
);

/**
 * Admin-only cleanup for disposable test identities (secure plane only).
 * Does not touch legacy drivers/approved production rows unless linked.
 */
export const adminDeleteSecureDriver = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB' },
  async (request) => {
    const caller = await requirePlatformAdmin(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );
    const driverId = String((request.data as any)?.driverId || '').trim();
    const confirm = String((request.data as any)?.confirm || '');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(driverId) || confirm !== 'DELETE_SECURE_DRIVER') {
      throw new httpsV2.HttpsError(
        'invalid-argument',
        'driverId and confirm=DELETE_SECURE_DRIVER required',
      );
    }
    const cred = await fs().collection('driver_credentials').doc(driverId).get();
    const nameNorm = cred.exists ? (cred.data()?.displayNameNorm as string) : null;
    // Disable first; preserve credentials/name for a safe retry if another
    // service fails. Never report success after a swallowed delete failure.
    if (cred.exists) await cred.ref.update({ active: false });
    const { driverAuthUid } = await import('./tokenMint');
    const authUid = driverAuthUid(driverId);
    try {
      await admin.auth().deleteUser(authUid);
    } catch (error) {
      if ((error as { code?: string }).code !== 'auth/user-not-found') throw error;
    }
    await rtdb().ref(`drivers/profiles/${driverId}`).remove();
    await fs().runTransaction(async (tx) => {
      const indexRef = nameNorm ? fs().collection('driver_name_index').doc(nameNorm) : null;
      const index = indexRef ? await tx.get(indexRef) : null;
      // A stale name index must never delete another driver's name reservation.
      if (indexRef && index?.data()?.driverId === driverId) tx.delete(indexRef);
      tx.delete(cred.ref);
    });
    await writeSecurityAudit({
      action: 'adminDeleteSecureDriver',
      actorUid: caller.uid,
      driverId,
    });
    return { ok: true };
  },
);

/**
 * Server-side free-tier registration (replaces JSA client self-approve).
 * Creates approved free profile + credentials. Still rate-limited.
 */
export const registerStandaloneDriver = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    assertAppCheck(request);
    const meta = clientMeta(request);
    const allowed = await checkRateLimit({
      bucket: 'standalone',
      key: meta.ipHash,
      limit: 3,
      windowMs: 60 * 60 * 1000,
    });
    if (!allowed) {
      throw new httpsV2.HttpsError('resource-exhausted', 'Too many attempts');
    }

    let fields: ReturnType<typeof validateRegistrationFields>;
    try {
      fields = validateRegistrationFields(request.data || {});
    } catch (e) {
      mapValidationError((e as Error).message);
    }

    const nameNorm = normalizeDisplayName(fields.displayName);
    const idx = await fs().collection('driver_name_index').doc(nameNorm).get();
    if (idx.exists) {
      throw new httpsV2.HttpsError('already-exists', 'Name already registered');
    }

    const driverId = randomUUID();
    const passcodeRecord = await hashPasscodeScrypt(fields.passcode);

    await fs().collection('driver_name_index').doc(nameNorm).set({ driverId });
    await fs().collection('driver_credentials').doc(driverId).set({
      displayNameNorm: nameNorm,
      displayName: fields.displayName,
      passcode: passcodeRecord,
      active: true,
      mustResetPasscode: false,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      tier: 'free',
      source: 'standalone',
    });

    await rtdb().ref(`drivers/profiles/${driverId}`).set({
      displayName: fields.displayName,
      legalName: fields.legalName || fields.displayName,
      name: fields.displayName,
      active: true,
      tier: 'free',
      source: 'standalone',
      approvedAt: Date.now(),
      roles: ['driver'],
      isAdmin: false,
      isViewer: false,
      schemaVersion: 1,
    });

    await writeSecurityAudit({
      action: 'registerStandaloneDriver',
      driverId,
      ipHash: meta.ipHash,
      appCheckPresent: meta.appCheckPresent,
      appId: meta.appId,
    });

    // Issue token immediately (custom token or password-exchange fallback)
    const { ensureDriverAuthUser, mintDriverSessionTokens } = await import('./tokenMint');
    const authUid = await ensureDriverAuthUser(driverId, fields.displayName);
    const claims: GlobalDriverClaims = {
      kind: 'driver', driverId, companyId: null, roles: ['driver'],
    };
    // No audience on the registration path — it has no requesting app yet.
    const minted = await mintDriverSessionTokens(authUid, claims);

    return {
      customToken: minted.customToken || null,
      idToken: minted.idToken || null,
      refreshToken: minted.refreshToken || null,
      mintMethod: minted.mintMethod,
      driverId,
      displayName: fields.displayName,
    };
  },
);

/** Forensic helper: compute legacy hash (admin only) — does not authenticate. */
export const adminComputeLegacyHash = httpsV2.onCall(
  { timeoutSeconds: 10, memory: '256MiB' },
  async (request) => {
    await requireManageDrivers(request.auth?.uid);
    const displayName = String((request.data as any)?.displayName || '');
    const passcode = String((request.data as any)?.passcode || '');
    if (!displayName || !passcode) {
      throw new httpsV2.HttpsError('invalid-argument', 'displayName and passcode required');
    }
    return { legacySha256: legacySha256NamePasscode(displayName, passcode) };
  },
);
