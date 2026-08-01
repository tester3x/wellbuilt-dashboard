/**
 * WellBuilt driver identity — server-enforced registration, login, approval.
 * Clients must not write drivers/approved or credential documents.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { randomUUID } from 'crypto';
import {
  hashPasscodeScrypt,
  verifyPasscodeScrypt,
  normalizeDisplayName,
  validateRegistrationFields,
  ScryptRecord,
  legacySha256NamePasscode,
} from './passcode';
import { checkRateLimit, hashIp } from './rateLimit';
import { writeSecurityAudit } from './audit';
import { requireManageDrivers } from './adminAuth';

const rtdb = () => admin.database();
const fs = () => admin.firestore();

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

    const pendingId = randomUUID();
    const passcodeRecord = await hashPasscodeScrypt(fields.passcode);
    const now = admin.firestore.FieldValue.serverTimestamp();

    await fs().collection('pending_credentials').doc(pendingId).set({
      passcode: passcodeRecord,
      displayNameNorm: nameNorm,
      createdAt: now,
    });

    await rtdb().ref(`drivers/pending_secure/${pendingId}`).set({
      displayName: fields.displayName,
      legalName: fields.legalName || null,
      companyName: fields.companyName || null,
      source,
      status: 'pending',
      schemaVersion: 1,
      requestedAt: admin.database.ServerValue.TIMESTAMP,
      appId: meta.appId,
    });

    // Dual-run mirror into legacy pending shape for existing Admin UI (no passcode hash as key)
    const legacyPush = await rtdb().ref('drivers/pending').push({
      displayName: fields.displayName,
      legalName: fields.legalName || null,
      companyName: fields.companyName || null,
      source,
      status: 'pending',
      requestedAt: new Date().toISOString(),
      securePendingId: pendingId,
      // intentional: no passcodeHash field — blocks legacy approve-by-hash path for new regs
    });

    await writeSecurityAudit({
      action: 'requestDriverRegistration',
      pendingId,
      appId: meta.appId,
      appCheckPresent: meta.appCheckPresent,
      ipHash: meta.ipHash,
      detail: { source, legacyKey: legacyPush.key },
    });

    return {
      pendingId,
      legacyPendingKey: legacyPush.key,
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
    const status = (snap.val()?.status as string) || 'pending';
    if (status === 'approved') {
      const driverId = snap.val()?.driverId as string | undefined;
      return { status: 'approved' as const, driverId: driverId || null };
    }
    if (status === 'rejected') {
      return { status: 'rejected' as const };
    }
    return { status: 'pending' as const };
  },
);

// ── Login ─────────────────────────────────────────────────────────────────

export const authenticateDriver = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
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
    if (cred.mustResetPasscode === true) {
      throw new httpsV2.HttpsError(
        'failed-precondition',
        'Passcode reset required. Contact your admin or re-register.',
      );
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

    // Ensure Auth user exists for custom token
    const authUid = `driver_${driverId.replace(/-/g, '').slice(0, 28)}`;
    try {
      await admin.auth().getUser(authUid);
    } catch {
      await admin.auth().createUser({
        uid: authUid,
        displayName: profile.displayName || displayName,
        disabled: false,
      });
    }

    const roles = Array.isArray(profile.roles) ? profile.roles : ['driver'];
    const claims = {
      kind: 'driver',
      driverId,
      companyId: profile.companyId || null,
      roles,
    };
    await admin.auth().setCustomUserClaims(authUid, claims);
    const token = await admin.auth().createCustomToken(authUid, claims);

    await writeSecurityAudit({
      action: 'authenticateDriver_ok',
      actorUid: authUid,
      driverId,
      ipHash: meta.ipHash,
      appCheckPresent: meta.appCheckPresent,
      appId: meta.appId,
    });

    return {
      customToken: token,
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
    };
  },
);

// ── Admin ─────────────────────────────────────────────────────────────────

export const adminListPendingRegistrations = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB' },
  async (request) => {
    const caller = await requireManageDrivers(request.auth?.uid);
    const snap = await rtdb().ref('drivers/pending_secure').once('value');
    const out: any[] = [];
    if (snap.exists()) {
      const val = snap.val();
      for (const [pendingId, raw] of Object.entries(val)) {
        const p = raw as any;
        if (p.status === 'approved' || p.status === 'rejected') continue;
        out.push({
          pendingId,
          displayName: p.displayName,
          legalName: p.legalName,
          companyName: p.companyName,
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
        if (p.status === 'approved' || p.status === 'rejected') continue;
        legacyPending.push({
          key,
          displayName: p.displayName,
          legalName: p.legalName,
          companyName: p.companyName,
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
    const caller = await requireManageDrivers(request.auth?.uid);
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
    if (pending.status && pending.status !== 'pending') {
      throw new httpsV2.HttpsError('failed-precondition', `Already ${pending.status}`);
    }

    let companyId = (data.companyId || '').trim().toLowerCase() || null;
    let companyName = (data.companyName || '').trim() || pending.companyName || null;
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
    const driverId = randomUUID();
    const nameNorm = pendingCred.displayNameNorm as string;
    const passcode = pendingCred.passcode as ScryptRecord;

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
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        pendingId,
      });
      tx.delete(fs().collection('pending_credentials').doc(pendingId));
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
    await pendingRef.update({
      status: 'approved',
      driverId,
      approvedAt: admin.database.ServerValue.TIMESTAMP,
      approvedBy: caller.uid,
    });

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
      pendingId,
      detail: { companyId },
    });

    return { driverId, displayName: pending.displayName, companyId, companyName };
  },
);

export const adminRejectDriverRegistration = httpsV2.onCall(
  { timeoutSeconds: 20, memory: '256MiB' },
  async (request) => {
    const caller = await requireManageDrivers(request.auth?.uid);
    const pendingId = String((request.data as any)?.pendingId || '').trim();
    const legacyKey = String((request.data as any)?.legacyKey || '').trim();

    if (pendingId) {
      const ref = rtdb().ref(`drivers/pending_secure/${pendingId}`);
      const snap = await ref.once('value');
      if (snap.exists()) {
        await ref.update({
          status: 'rejected',
          rejectedAt: admin.database.ServerValue.TIMESTAMP,
          rejectedBy: caller.uid,
        });
        // Keep pending_credentials tombstone? delete credential material only
        await fs().collection('pending_credentials').doc(pendingId).delete().catch(() => undefined);
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
      pendingId: pendingId || null,
      detail: { legacyKey: legacyKey || null },
    });

    return { ok: true };
  },
);

/**
 * Create secure credentials for a legacy approved profile shell,
 * or force-reset passcode. Does not accept legacy SHA-256 for login.
 */
export const adminSetDriverPasscode = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB' },
  async (request) => {
    const caller = await requireManageDrivers(request.auth?.uid);
    const data = (request.data || {}) as {
      driverId?: string;
      displayName?: string;
      passcode?: string;
      /** When migrating: create profile from legacy approved hash metadata */
      legacyHash?: string;
      companyId?: string;
      companyName?: string;
      legalName?: string;
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

    const nameNorm = normalizeDisplayName(fields.displayName);
    const passcodeRecord = await hashPasscodeScrypt(fields.passcode);
    let driverId = (data.driverId || '').trim();

    if (!driverId && data.legacyHash) {
      // Migrate shell from legacy approved node
      const legacy = await rtdb().ref(`drivers/approved/${data.legacyHash}`).once('value');
      if (!legacy.exists()) {
        throw new httpsV2.HttpsError('not-found', 'Legacy driver not found');
      }
      const L = legacy.val();
      driverId = randomUUID();
      await rtdb().ref(`drivers/profiles/${driverId}`).set({
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
        roles: L.roles || ['driver'],
        approvedAt: L.approvedAt || Date.now(),
        migratedFromLegacyHashPrefix: String(data.legacyHash).slice(0, 8),
        schemaVersion: 1,
        mustUseSecureAuth: true,
      });
      // Deactivate legacy login path immediately for this hash
      await rtdb().ref(`drivers/approved/${data.legacyHash}`).update({
        active: false,
        migratedToDriverId: driverId,
        legacyLoginDisabled: true,
      });
    }

    if (!driverId) {
      // Brand-new admin-provisioned driver
      driverId = randomUUID();
      await rtdb().ref(`drivers/profiles/${driverId}`).set({
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
      });
    }

    await fs().collection('driver_credentials').doc(driverId).set(
      {
        displayNameNorm: nameNorm,
        displayName: fields.displayName,
        passcode: passcodeRecord,
        active: true,
        mustResetPasscode: false,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        setBy: caller.uid,
      },
      { merge: true },
    );
    await fs().collection('driver_name_index').doc(nameNorm).set({ driverId });

    // Update profile display if needed
    await rtdb().ref(`drivers/profiles/${driverId}`).update({
      displayName: fields.displayName,
      legalName: fields.legalName || fields.displayName,
    });

    await writeSecurityAudit({
      action: 'adminSetDriverPasscode',
      actorUid: caller.uid,
      driverId,
      detail: {
        legacyHashPrefix: data.legacyHash ? String(data.legacyHash).slice(0, 8) : null,
      },
    });

    return { driverId, displayName: fields.displayName };
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
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
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

    // Issue token immediately
    const authUid = `driver_${driverId.replace(/-/g, '').slice(0, 28)}`;
    try {
      await admin.auth().getUser(authUid);
    } catch {
      await admin.auth().createUser({ uid: authUid, displayName: fields.displayName });
    }
    const claims = { kind: 'driver', driverId, companyId: null, roles: ['driver'] };
    await admin.auth().setCustomUserClaims(authUid, claims);
    const token = await admin.auth().createCustomToken(authUid, claims);

    return {
      customToken: token,
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
