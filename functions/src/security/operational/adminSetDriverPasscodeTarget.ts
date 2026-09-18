/**
 * Governed tenant authorization and pre-mutation target evaluation
 * for adminSetDriverPasscode.
 *
 * Ensures:
 * - Exact canonical driver UUID format for resets.
 * - Caller is authenticated with manageDrivers and matching companyId.
 * - Platform-admin / IT / broad user-management roles CANNOT bypass tenant matching.
 * - Authoritative credentials & profile verified before mutation.
 * - Inactive, missing, legacy-only shell, email/password account, and cross-company
 *   targets are rejected before hashing passcode or writing any state.
 */
import * as admin from 'firebase-admin';

export const CANONICAL_DRIVER_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CallerContext {
  uid: string;
  roles: string[];
  companyId?: string | null;
  caps: string[];
  isPlatformAdmin?: boolean;
}

export interface TargetCredentialsRecord {
  exists: boolean;
  active?: boolean;
  passcode?: unknown;
  authType?: string;
  authMethod?: string;
  legacyOnly?: boolean;
  isLegacyShell?: boolean;
  companyId?: string | null;
  displayName?: string | null;
}

export interface TargetProfileRecord {
  exists: boolean;
  active?: boolean;
  companyId?: string | null;
  displayName?: string | null;
  authType?: string;
  isEmailAccount?: boolean;
  legacy?: boolean;
  isLegacyOnly?: boolean;
  mustUseSecureAuth?: boolean;
}

export interface TargetEvaluationContext {
  caller: CallerContext;
  requestedDriverId?: unknown;
  requestDisplayName?: unknown;
  requestCompanyId?: unknown;
  approvedKey?: unknown;
  legacyHash?: unknown;
  credentials?: TargetCredentialsRecord | null;
  profile?: TargetProfileRecord | null;
  userRecordExists?: boolean;
  approvedRowExists?: boolean;
  isAuthUserEmail?: boolean;
}

export type TargetEvaluationResult =
  | {
      ok: true;
      driverId: string;
      targetCompanyId: string;
      displayName: string;
    }
  | {
      ok: false;
      code:
        | 'unauthenticated'
        | 'permission-denied'
        | 'invalid-argument'
        | 'not-found'
        | 'failed-precondition';
      reason: string;
    };

/**
 * Pure evaluation of caller authority and target driver eligibility for passcode reset.
 * No I/O, no password hashing, and zero side-effects.
 */
export function evaluateAdminSetDriverPasscodeTarget(
  ctx: TargetEvaluationContext,
): TargetEvaluationResult {
  // 1. Caller Authentication
  if (!ctx.caller || !ctx.caller.uid) {
    return { ok: false, code: 'unauthenticated', reason: 'Must be signed in' };
  }

  // 2. Caller Capability Check
  const caps = Array.isArray(ctx.caller.caps) ? ctx.caller.caps : [];
  if (!caps.includes('manageDrivers')) {
    return {
      ok: false,
      code: 'permission-denied',
      reason: 'Caller lacks manageDrivers capability',
    };
  }

  // 3. Caller Tenant Scope Check (Platform admin / IT cannot bypass tenant matching)
  const callerCo = String(ctx.caller.companyId || '').trim().toLowerCase();
  if (!callerCo) {
    return {
      ok: false,
      code: 'permission-denied',
      reason: 'Cross-company driver access denied: caller lacks matching company authority',
    };
  }

  // 4. Driver UUID / Selector Validation
  const rawId =
    typeof ctx.requestedDriverId === 'string'
      ? ctx.requestedDriverId.trim()
      : '';

  if (!rawId) {
    if (!ctx.approvedKey && !ctx.legacyHash) {
      return {
        ok: false,
        code: 'invalid-argument',
        reason:
          'Canonical driver UUID required for passcode reset; name-only resets are not allowed',
      };
    }
    return {
      ok: false,
      code: 'failed-precondition',
      reason: 'legacy_link_required',
    };
  }

  if (!CANONICAL_DRIVER_ID.test(rawId)) {
    return {
      ok: false,
      code: 'invalid-argument',
      reason: 'driverId must be a valid canonical UUID',
    };
  }

  // 5. Target Existence & Type Resolution
  const cred = ctx.credentials;
  const prof = ctx.profile;
  const credExists = Boolean(cred && cred.exists);
  const profExists = Boolean(prof && prof.exists);
  const userExists = Boolean(ctx.userRecordExists);
  const approvedExists = Boolean(ctx.approvedRowExists);
  const isAuthEmail = Boolean(ctx.isAuthUserEmail);

  // Email/Password Account rejection
  const isEmail =
    userExists ||
    isAuthEmail ||
    cred?.authType === 'email' ||
    cred?.authMethod === 'email' ||
    prof?.authType === 'email' ||
    prof?.isEmailAccount === true;

  if (isEmail) {
    return {
      ok: false,
      code: 'failed-precondition',
      reason:
        'Cannot reset passcode for email/password account; reset is only for passcode-authenticated drivers',
    };
  }

  // Missing target rejection
  if (!credExists && !profExists) {
    if (approvedExists) {
      return {
        ok: false,
        code: 'failed-precondition',
        reason:
          'Legacy driver shell cannot be reset directly; must be migrated to secure auth first',
      };
    }
    return { ok: false, code: 'not-found', reason: 'Driver not found' };
  }

  // Legacy-only shell rejection
  if (!credExists && profExists) {
    return {
      ok: false,
      code: 'failed-precondition',
      reason:
        'Legacy driver shell cannot be reset directly; must be migrated to secure auth first',
    };
  }

  if (cred?.legacyOnly === true || cred?.isLegacyShell === true) {
    return {
      ok: false,
      code: 'failed-precondition',
      reason:
        'Legacy driver shell cannot be reset directly; must be migrated to secure auth first',
    };
  }

  if (
    prof?.legacy === true ||
    prof?.isLegacyOnly === true ||
    prof?.mustUseSecureAuth === false
  ) {
    return {
      ok: false,
      code: 'failed-precondition',
      reason:
        'Legacy driver shell cannot be reset directly; must be migrated to secure auth first',
    };
  }

  // Missing profile / ambiguous state rejection
  if (credExists && !profExists) {
    return {
      ok: false,
      code: 'failed-precondition',
      reason: 'Driver profile is missing or ambiguous',
    };
  }

  // Passcode-authenticated check
  const credPasscode = cred?.passcode;
  const hasValidPasscode =
    Boolean(credPasscode) &&
    typeof credPasscode === 'object' &&
    (typeof (credPasscode as any).hashB64 === 'string' ||
      typeof (credPasscode as any).hash === 'string');

  if (!hasValidPasscode) {
    return {
      ok: false,
      code: 'failed-precondition',
      reason: 'Target driver is not passcode-authenticated',
    };
  }

  // Inactive target rejection
  if (cred?.active === false || prof?.active === false) {
    return {
      ok: false,
      code: 'failed-precondition',
      reason: 'Driver account is inactive',
    };
  }

  // 6. Strict Tenant Matching
  const targetCo = String(prof?.companyId || cred?.companyId || '')
    .trim()
    .toLowerCase();

  if (!targetCo || targetCo !== callerCo) {
    return {
      ok: false,
      code: 'permission-denied',
      reason: 'Cross-company driver access denied',
    };
  }

  if (
    typeof ctx.requestCompanyId === 'string' &&
    ctx.requestCompanyId.trim()
  ) {
    const reqCo = ctx.requestCompanyId.trim().toLowerCase();
    if (reqCo !== callerCo) {
      return {
        ok: false,
        code: 'permission-denied',
        reason: 'Cross-company driver access denied',
      };
    }
  }

  // 7. Display Name Resolution
  const displayName =
    typeof ctx.requestDisplayName === 'string' &&
    ctx.requestDisplayName.trim()
      ? ctx.requestDisplayName.trim()
      : prof?.displayName || cred?.displayName || '';

  if (!displayName) {
    return {
      ok: false,
      code: 'invalid-argument',
      reason: 'Driver display name is missing or empty',
    };
  }

  return {
    ok: true,
    driverId: rawId,
    targetCompanyId: targetCo,
    displayName,
  };
}

/**
 * Authoritative target record loader across Firestore, RTDB, and Auth.
 */
export async function loadTargetState(
  fs: FirebaseFirestore.Firestore,
  rtdb: admin.database.Database,
  driverId: string,
): Promise<{
  credentials: TargetCredentialsRecord;
  profile: TargetProfileRecord;
  userRecordExists: boolean;
  approvedRowExists: boolean;
  isAuthUserEmail: boolean;
}> {
  const [credSnap, profileSnap, userSnap, approvedSnap] = await Promise.all([
    fs.collection('driver_credentials').doc(driverId).get(),
    rtdb.ref(`drivers/profiles/${driverId}`).once('value'),
    rtdb.ref(`users/${driverId}`).once('value'),
    rtdb.ref(`drivers/approved/${driverId}`).once('value'),
  ]);

  let isAuthUserEmail = false;
  try {
    const authUser = await admin.auth().getUser(driverId);
    if (
      authUser &&
      (authUser.email ||
        (Array.isArray(authUser.providerData) &&
          authUser.providerData.some((p) => p.providerId === 'password')))
    ) {
      isAuthUserEmail = true;
    }
  } catch {
    /* expected: driverId is not a Firebase Auth user UID */
  }

  const credData = credSnap.data();
  const profileVal = profileSnap.val() as Record<string, unknown> | null;

  return {
    credentials: {
      exists: credSnap.exists,
      active: credData?.active,
      passcode: credData?.passcode,
      authType: credData?.authType,
      authMethod: credData?.authMethod,
      legacyOnly: credData?.legacyOnly,
      isLegacyShell: credData?.isLegacyShell,
      companyId: credData?.companyId,
      displayName: credData?.displayName,
    },
    profile: {
      exists: profileSnap.exists(),
      active: profileVal?.active as boolean | undefined,
      companyId: (typeof profileVal?.companyId === 'string'
        ? profileVal.companyId
        : null) as string | null,
      displayName: (typeof profileVal?.displayName === 'string'
        ? profileVal.displayName
        : null) as string | null,
      authType: profileVal?.authType as string | undefined,
      isEmailAccount: profileVal?.isEmailAccount as boolean | undefined,
      legacy: profileVal?.legacy as boolean | undefined,
      isLegacyOnly: profileVal?.isLegacyOnly as boolean | undefined,
      mustUseSecureAuth: profileVal?.mustUseSecureAuth as boolean | undefined,
    },
    userRecordExists: userSnap.exists(),
    approvedRowExists: approvedSnap.exists(),
    isAuthUserEmail,
  };
}
