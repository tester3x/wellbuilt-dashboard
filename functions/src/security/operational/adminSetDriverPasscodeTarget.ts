/**
 * Governed tenant authorization and pre-mutation target evaluation
 * for adminSetDriverPasscode across all routes:
 * - Existing canonical driver reset
 * - Approved-row conversion (approvedKey)
 * - Legacy conversion (legacyHash)
 * - New-driver provisioning
 *
 * Enforces:
 * - Exact canonical driver UUID format for resets.
 * - Caller is authenticated with manageDrivers and matching companyId.
 * - Unscoped IT/platform-admin callers are denied on every route.
 * - Source approved/legacy rows must match caller's company.
 * - Auth lookup queries exact driverAuthUid(driverId).
 * - Password-provider accounts are rejected; synthetic no-password identities accepted.
 * - Auth service errors fail closed with unavailable before mutation.
 * - Empty or malformed hashes are rejected.
 * - Active state must be explicitly true; missing active state fails closed.
 * - Conflicting company IDs fail closed.
 */
import * as admin from 'firebase-admin';
import * as httpsV2 from 'firebase-functions/v2/https';
import { driverAuthUid } from '../tokenMint';

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
  displayNameNorm?: string | null;
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
  route?: 'reset' | 'approvedKey' | 'legacyHash' | 'new_driver';
  caller: CallerContext;
  requestedDriverId?: unknown;
  requestDisplayName?: unknown;
  requestCompanyId?: unknown;
  approvedKey?: unknown;
  legacyHash?: unknown;
  approvedRow?: Record<string, unknown> | null;
  legacyRow?: Record<string, unknown> | null;
  credentials?: TargetCredentialsRecord | null;
  profile?: TargetProfileRecord | null;
  userRecordExists?: boolean;
  approvedRowExists?: boolean;
  isAuthUserEmail?: boolean;
  authUser?: admin.auth.UserRecord | null;
  authLookupStatus?: 'ok' | 'not_found' | 'service_error';
}

export type TargetEvaluationResult =
  | {
      ok: true;
      route: 'reset' | 'approvedKey' | 'legacyHash' | 'new_driver';
      driverId?: string;
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
        | 'failed-precondition'
        | 'unavailable';
      reason: string;
    };

/**
 * Pure evaluation of caller authority and target driver eligibility.
 * No I/O, no password hashing, zero side-effects.
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

  // 3. Caller Tenant Scope Check (Unscoped IT/platform caller denied on every route)
  const callerCo = String(ctx.caller.companyId || '').trim().toLowerCase();
  if (!callerCo) {
    return {
      ok: false,
      code: 'permission-denied',
      reason:
        'Cross-company driver access denied: caller lacks matching company authority',
    };
  }

  const rawId =
    typeof ctx.requestedDriverId === 'string'
      ? ctx.requestedDriverId.trim()
      : '';
  const rawApprovedKey =
    typeof ctx.approvedKey === 'string' ? ctx.approvedKey.trim() : '';
  const rawLegacyHash =
    typeof ctx.legacyHash === 'string' ? ctx.legacyHash.trim() : '';

  let route = ctx.route;
  if (!route) {
    if (rawId) {
      route = 'reset';
    } else if (rawApprovedKey) {
      route = 'approvedKey';
    } else if (rawLegacyHash) {
      route = 'legacyHash';
    } else {
      return {
        ok: false,
        code: 'invalid-argument',
        reason:
          'Canonical driver UUID required for passcode reset; name-only resets are not allowed',
      };
    }
  }

  // ROUTE 1: APPROVED KEY CONVERSION
  if (route === 'approvedKey') {
    if (!rawApprovedKey || !/^[A-Za-z0-9_-]{16,}$/.test(rawApprovedKey)) {
      return {
        ok: false,
        code: 'invalid-argument',
        reason: 'approved_key_malformed',
      };
    }
    const row = ctx.approvedRow;
    if (!row) {
      return {
        ok: false,
        code: 'not-found',
        reason: 'Approved driver row not found',
      };
    }
    if (row.active !== true) {
      return {
        ok: false,
        code: 'failed-precondition',
        reason: 'Approved driver row is inactive or malformed',
      };
    }
    if (
      typeof row.migratedToDriverId === 'string' &&
      row.migratedToDriverId.trim()
    ) {
      return {
        ok: false,
        code: 'failed-precondition',
        reason: 'Approved driver row already linked',
      };
    }
    const rowCompany = String(row.companyId || '').trim().toLowerCase();
    if (!rowCompany || rowCompany !== callerCo) {
      return {
        ok: false,
        code: 'permission-denied',
        reason:
          'Cross-company driver access denied: approved row belongs to another company',
      };
    }
    if (
      typeof ctx.requestCompanyId === 'string' &&
      ctx.requestCompanyId.trim()
    ) {
      if (ctx.requestCompanyId.trim().toLowerCase() !== callerCo) {
        return {
          ok: false,
          code: 'permission-denied',
          reason: 'Cross-company driver access denied',
        };
      }
    }
    const displayName = String(
      ctx.requestDisplayName || row.displayName || '',
    ).trim();
    if (!displayName) {
      return {
        ok: false,
        code: 'invalid-argument',
        reason: 'Driver display name is missing or empty',
      };
    }
    return {
      ok: true,
      route: 'approvedKey',
      targetCompanyId: callerCo,
      displayName,
    };
  }

  // ROUTE 2: LEGACY HASH CONVERSION
  if (route === 'legacyHash') {
    if (!rawLegacyHash) {
      return {
        ok: false,
        code: 'invalid-argument',
        reason: 'Legacy hash required',
      };
    }
    const row = ctx.legacyRow;
    if (!row) {
      return {
        ok: false,
        code: 'not-found',
        reason: 'Legacy driver not found',
      };
    }
    if (row.active === false) {
      return {
        ok: false,
        code: 'failed-precondition',
        reason: 'Legacy driver is inactive',
      };
    }
    const rowCompany = String(row.companyId || '').trim().toLowerCase();
    if (!rowCompany || rowCompany !== callerCo) {
      return {
        ok: false,
        code: 'permission-denied',
        reason:
          'Cross-company driver access denied: legacy row belongs to another company',
      };
    }
    if (
      typeof ctx.requestCompanyId === 'string' &&
      ctx.requestCompanyId.trim()
    ) {
      if (ctx.requestCompanyId.trim().toLowerCase() !== callerCo) {
        return {
          ok: false,
          code: 'permission-denied',
          reason: 'Cross-company driver access denied',
        };
      }
    }
    const displayName = String(
      ctx.requestDisplayName || row.displayName || '',
    ).trim();
    if (!displayName) {
      return {
        ok: false,
        code: 'invalid-argument',
        reason: 'Driver display name is missing or empty',
      };
    }
    return {
      ok: true,
      route: 'legacyHash',
      targetCompanyId: callerCo,
      displayName,
    };
  }

  // ROUTE 3: CANONICAL DRIVER RESET
  if (!rawId) {
    return {
      ok: false,
      code: 'invalid-argument',
      reason:
        'Canonical driver UUID required for passcode reset; name-only resets are not allowed',
    };
  }
  if (!CANONICAL_DRIVER_ID.test(rawId)) {
    return {
      ok: false,
      code: 'invalid-argument',
      reason: 'driverId must be a valid canonical UUID',
    };
  }

  // Auth service failure check
  if (ctx.authLookupStatus === 'service_error') {
    return {
      ok: false,
      code: 'unavailable',
      reason: 'Auth service lookup failed; target verification aborted',
    };
  }

  const cred = ctx.credentials;
  const prof = ctx.profile;
  const credExists = Boolean(cred && cred.exists);
  const profExists = Boolean(prof && prof.exists);
  const userExists = Boolean(ctx.userRecordExists);
  const approvedExists = Boolean(ctx.approvedRowExists);

  // Email/Password Account rejection
  let isEmail =
    userExists ||
    ctx.isAuthUserEmail ||
    cred?.authType === 'email' ||
    cred?.authMethod === 'email' ||
    prof?.authType === 'email' ||
    prof?.isEmailAccount === true;

  if (ctx.authUser) {
    const hasPasswordProvider =
      Array.isArray(ctx.authUser.providerData) &&
      ctx.authUser.providerData.some((p) => p.providerId === 'password');
    const hasRealEmail =
      typeof ctx.authUser.email === 'string' &&
      ctx.authUser.email.trim() !== '' &&
      !ctx.authUser.email.endsWith('@drivers.wellbuilt-sync.local');

    if (hasPasswordProvider || hasRealEmail) {
      isEmail = true;
    }
  }

  if (isEmail) {
    return {
      ok: false,
      code: 'failed-precondition',
      reason:
        'Cannot reset passcode for email/password account; reset is only for passcode-authenticated drivers',
    };
  }

  // Missing target check
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

  // Legacy shell checks
  if (!credExists && profExists) {
    return {
      ok: false,
      code: 'failed-precondition',
      reason:
        'Legacy driver shell cannot be reset directly; must be migrated to secure auth first',
    };
  }
  if (
    cred?.legacyOnly === true ||
    cred?.isLegacyShell === true ||
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

  if (credExists && !profExists) {
    return {
      ok: false,
      code: 'failed-precondition',
      reason: 'Driver profile is missing or ambiguous',
    };
  }

  // Passcode-authenticated check (empty or malformed hashes do not qualify)
  const credPasscode = cred?.passcode as any;
  const hasValidPasscode =
    Boolean(credPasscode) &&
    typeof credPasscode === 'object' &&
    typeof credPasscode.hashB64 === 'string' &&
    credPasscode.hashB64.trim().length > 0 &&
    typeof credPasscode.saltB64 === 'string' &&
    credPasscode.saltB64.trim().length > 0;

  if (!hasValidPasscode) {
    return {
      ok: false,
      code: 'failed-precondition',
      reason: 'Target driver is not passcode-authenticated',
    };
  }

  // Active state check (missing active state cannot silently pass)
  if (cred?.active !== true || prof?.active !== true) {
    return {
      ok: false,
      code: 'failed-precondition',
      reason: 'Driver account is inactive',
    };
  }

  // Conflicting company IDs fail closed (never silently prefer one store)
  const credCo = String(cred?.companyId || '').trim().toLowerCase();
  const profCo = String(prof?.companyId || '').trim().toLowerCase();

  if (!credCo || !profCo) {
    return {
      ok: false,
      code: 'failed-precondition',
      reason: 'Target driver is missing company binding',
    };
  }

  if (credCo !== profCo) {
    return {
      ok: false,
      code: 'failed-precondition',
      reason:
        'Conflicting target company identity between credential and profile',
    };
  }

  if (credCo !== callerCo) {
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
    if (ctx.requestCompanyId.trim().toLowerCase() !== callerCo) {
      return {
        ok: false,
        code: 'permission-denied',
        reason: 'Cross-company driver access denied',
      };
    }
  }

  if (ctx.authUser?.customClaims?.companyId) {
    const authCo = String(ctx.authUser.customClaims.companyId)
      .trim()
      .toLowerCase();
    if (authCo && authCo !== callerCo) {
      return {
        ok: false,
        code: 'permission-denied',
        reason:
          'Cross-company driver access denied: Auth identity company mismatch',
      };
    }
  }

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
    route: 'reset',
    driverId: rawId,
    targetCompanyId: callerCo,
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
  authUser: admin.auth.UserRecord | null;
  authLookupStatus: 'ok' | 'not_found' | 'service_error';
  credentialsRaw: Record<string, unknown> | null;
}> {
  const authUid = driverAuthUid(driverId);
  const [credSnap, profileSnap, userSnap, approvedSnap] = await Promise.all([
    fs.collection('driver_credentials').doc(driverId).get(),
    rtdb.ref(`drivers/profiles/${driverId}`).once('value'),
    rtdb.ref(`users/${driverId}`).once('value'),
    rtdb.ref(`drivers/approved/${driverId}`).once('value'),
  ]);

  let authUser: admin.auth.UserRecord | null = null;
  let authLookupStatus: 'ok' | 'not_found' | 'service_error' = 'ok';
  let isAuthUserEmail = false;

  try {
    authUser = await admin.auth().getUser(authUid);
    if (authUser.uid !== authUid) {
      throw new httpsV2.HttpsError('internal', 'Auth identity mismatch');
    }
    const hasPassword =
      Array.isArray(authUser.providerData) &&
      authUser.providerData.some((p) => p.providerId === 'password');
    const hasRealEmail =
      typeof authUser.email === 'string' &&
      authUser.email.trim() !== '' &&
      !authUser.email.endsWith('@drivers.wellbuilt-sync.local');
    if (hasPassword || hasRealEmail) {
      isAuthUserEmail = true;
    }
  } catch (err: any) {
    if (err?.code === 'auth/user-not-found') {
      authLookupStatus = 'not_found';
    } else {
      throw new httpsV2.HttpsError(
        'unavailable',
        `Auth lookup service failure: ${err?.message || 'unexpected error'}`,
      );
    }
  }

  // Also check if an account exists under the raw driverId UUID directly
  try {
    const directUser = await admin.auth().getUser(driverId);
    if (
      directUser &&
      (directUser.providerData.some((p) => p.providerId === 'password') ||
        (directUser.email &&
          !directUser.email.endsWith('@drivers.wellbuilt-sync.local')))
    ) {
      isAuthUserEmail = true;
    }
  } catch (err: any) {
    if (err?.code !== 'auth/user-not-found') {
      throw new httpsV2.HttpsError(
        'unavailable',
        `Auth lookup service failure: ${err?.message || 'unexpected error'}`,
      );
    }
  }

  const credData = credSnap.data() as Record<string, unknown> | undefined;
  const profileVal = profileSnap.val() as Record<string, unknown> | null;

  return {
    credentials: {
      exists: credSnap.exists,
      active: credData?.active as boolean | undefined,
      passcode: credData?.passcode,
      authType: credData?.authType as string | undefined,
      authMethod: credData?.authMethod as string | undefined,
      legacyOnly: credData?.legacyOnly as boolean | undefined,
      isLegacyShell: credData?.isLegacyShell as boolean | undefined,
      companyId: credData?.companyId as string | null | undefined,
      displayName: credData?.displayName as string | null | undefined,
      displayNameNorm: credData?.displayNameNorm as string | null | undefined,
    },
    profile: {
      exists: profileSnap.exists(),
      active: profileVal?.active as boolean | undefined,
      companyId:
        typeof profileVal?.companyId === 'string'
          ? profileVal.companyId
          : null,
      displayName:
        typeof profileVal?.displayName === 'string'
          ? profileVal.displayName
          : null,
      authType: profileVal?.authType as string | undefined,
      isEmailAccount: profileVal?.isEmailAccount as boolean | undefined,
      legacy: profileVal?.legacy as boolean | undefined,
      isLegacyOnly: profileVal?.isLegacyOnly as boolean | undefined,
      mustUseSecureAuth: profileVal?.mustUseSecureAuth as
        | boolean
        | undefined,
    },
    userRecordExists: userSnap.exists(),
    approvedRowExists: approvedSnap.exists(),
    isAuthUserEmail,
    authUser,
    authLookupStatus,
    credentialsRaw: credData || null,
  };
}
