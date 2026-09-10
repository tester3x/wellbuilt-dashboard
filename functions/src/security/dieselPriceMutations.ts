/**
 * Governed Fuel Prices mutations: server-side Save Price.
 *
 * Implements manager / billing-capability authorization, company-scoped;
 * platform admin allowed across any company.
 * Atomic Admin SDK transaction preserves existing diesel_prices schema
 * and updates companies.currentDieselPrice atomically and idempotently.
 */

import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import {
  pickCompanyFscConfig,
  validateManualPrice,
  authorizeDieselSaveCaller,
  planSinglePriceWrite,
  type CallerAuthorizationProfile,
  type FscConfig,
} from '../dieselMutationCore';
import { writeSecurityAudit } from './audit';

const OPTS = { timeoutSeconds: 60, memory: '256MiB' as const, enforceAppCheck: false };
const TARGET_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const DEFAULT_ROLE_CAPABILITIES: Record<string, string[]> = {
  it: [
    'viewHome', 'viewMobile', 'viewTickets', 'viewDispatch', 'viewBilling',
    'viewPayroll', 'viewDriverLogs', 'viewSafety', 'viewSettings', 'viewAdmin', 'viewChat',
    'createDispatch', 'manageDrivers', 'manageCompany', 'editBilling',
    'approvePayroll', 'manageWells', 'manageRoutes',
    'viewEQuipment', 'manageEquipment', 'manageEquipmentAssignments',
    'sendChat', 'manageSafety', 'manageRolesAndCapabilities', 'viewAllCompanies', 'viewTruthDebug',
  ],
  admin: [
    'viewHome', 'viewMobile', 'viewTickets', 'viewDispatch', 'viewBilling',
    'viewPayroll', 'viewDriverLogs', 'viewSafety', 'viewSettings', 'viewAdmin', 'viewChat',
    'createDispatch', 'manageDrivers', 'manageCompany', 'editBilling',
    'approvePayroll', 'manageWells', 'manageRoutes',
    'viewEQuipment', 'manageEquipment', 'manageEquipmentAssignments',
    'sendChat', 'manageSafety',
  ],
  manager: [
    'viewHome', 'viewMobile', 'viewTickets', 'viewDispatch', 'viewPayroll',
    'viewDriverLogs', 'viewSafety', 'viewChat',
    'createDispatch', 'sendChat', 'manageDrivers', 'manageEquipmentAssignments',
    'viewEQuipment', 'manageSafety',
  ],
  dispatch: [
    'viewHome', 'viewMobile', 'viewTickets', 'viewDispatch', 'viewSafety', 'viewChat',
    'createDispatch', 'sendChat', 'manageEquipmentAssignments',
    'viewEQuipment',
  ],
  payroll: [
    'viewHome', 'viewBilling', 'viewPayroll', 'viewChat',
    'editBilling', 'approvePayroll', 'sendChat',
  ],
  viewer: [
    'viewHome', 'viewMobile', 'viewTickets', 'viewDispatch', 'viewBilling',
    'viewPayroll', 'viewDriverLogs',
  ],
  driver: [],
};

function resolveRoles(userData: Record<string, unknown>): string[] {
  if (Array.isArray(userData.roles) && userData.roles.length > 0) {
    return userData.roles.filter((r): r is string => typeof r === 'string');
  }
  return typeof userData.role === 'string' ? [userData.role] : [];
}

function resolveCaps(roles: string[], overrides: Record<string, string[]>): string[] {
  const caps = new Set<string>();
  for (const role of roles) {
    const list = overrides[role] ?? DEFAULT_ROLE_CAPABILITIES[role] ?? [];
    list.forEach((c) => caps.add(c));
  }
  return [...caps];
}

export interface ResolvedDashboardCaller extends CallerAuthorizationProfile {
  displayName?: string;
  email?: string;
}

/**
 * Resolve caller profile from RTDB users/{uid} with custom claims fallback.
 */
export async function loadCallerProfile(
  authUid: string | undefined,
  authToken?: Record<string, unknown> | null
): Promise<ResolvedDashboardCaller> {
  if (!authUid) {
    throw new httpsV2.HttpsError('unauthenticated', 'Must be signed in');
  }

  // 1. RTDB profile (canonical source of truth for dashboard users)
  try {
    const snap = await admin.database().ref(`users/${authUid}`).once('value');
    if (snap.exists()) {
      const userData = (snap.val() || {}) as Record<string, unknown>;
      const roles = resolveRoles(userData);
      const companyId = typeof userData.companyId === 'string' ? userData.companyId : undefined;
      const displayName = typeof userData.displayName === 'string' ? userData.displayName : undefined;
      const email = typeof userData.email === 'string' ? userData.email : undefined;

      let overrides: Record<string, string[]> = {};
      if (companyId) {
        try {
          const cSnap = await admin.firestore().collection('companies').doc(companyId).get();
          overrides = (cSnap.data()?.roleCapabilities || {}) as Record<string, string[]>;
        } catch {
          /* best-effort */
        }
      }

      const caps = resolveCaps(roles, overrides);
      const isPlatformAdmin =
        (!companyId && roles.some((r) => r === 'admin' || r === 'it')) ||
        authToken?.wellbuiltAdmin === true ||
        authToken?.isPlatformAdmin === true;

      return {
        uid: authUid,
        roles,
        companyId,
        caps,
        isPlatformAdmin: Boolean(isPlatformAdmin),
        displayName,
        email,
      };
    }
  } catch (err) {
    console.warn('[dieselPriceMutations] RTDB lookup failed:', err);
  }

  // 2. Fallback to Auth token claims (emulator & test support)
  if (authToken && typeof authToken === 'object') {
    const claimRoles: string[] = [];
    if (typeof authToken.role === 'string') claimRoles.push(authToken.role);
    if (Array.isArray(authToken.roles)) {
      for (const r of authToken.roles) {
        if (typeof r === 'string') claimRoles.push(r);
      }
    }
    const companyId = typeof authToken.companyId === 'string' ? authToken.companyId : undefined;
    const caps = resolveCaps(claimRoles, {});
    if (authToken.editBilling === true && !caps.includes('editBilling')) {
      caps.push('editBilling');
    }
    const isPlatformAdmin =
      (!companyId && claimRoles.some((r) => r === 'admin' || r === 'it')) ||
      authToken.wellbuiltAdmin === true ||
      authToken.isPlatformAdmin === true;

    return {
      uid: authUid,
      roles: claimRoles.length ? claimRoles : ['viewer'],
      companyId,
      caps,
      isPlatformAdmin: Boolean(isPlatformAdmin),
      displayName: typeof authToken.name === 'string' ? authToken.name : undefined,
      email: typeof authToken.email === 'string' ? authToken.email : undefined,
    };
  }

  throw new httpsV2.HttpsError('permission-denied', 'Caller profile not found');
}

/**
 * Execute atomic Firestore transaction for saving a diesel price.
 * Upserts diesel_prices doc (deterministic or existing) and updates companies.currentDieselPrice
 * idempotently without regressing older dates.
 */
export async function applySinglePriceWrite(
  db: admin.firestore.Firestore,
  args: {
    targetCompanyId: string;
    date: string;
    price: number;
    source: string;
    actorIdentity: string;
    fscConfig?: FscConfig;
  }
): Promise<{ isCurrent: boolean; docId: string; fsc: { rate: number; unit: string } | null }> {
  const companyRef = db.collection('companies').doc(args.targetCompanyId);

  let resultIsCurrent = false;
  let resultDocId = '';
  let resultFsc: { rate: number; unit: string } | null = null;

  await db.runTransaction(async (tx) => {
    const companySnap = await tx.get(companyRef);
    if (!companySnap.exists) {
      throw new httpsV2.HttpsError('not-found', 'company_not_found:Target company does not exist');
    }
    const companyData = companySnap.data() || {};
    const effectiveFscConfig = args.fscConfig !== undefined ? args.fscConfig : pickCompanyFscConfig(companyData);
    const currentPriceDate =
      typeof companyData.currentPriceDate === 'string' ? companyData.currentPriceDate : null;

    const plan = planSinglePriceWrite({
      targetCompanyId: args.targetCompanyId,
      date: args.date,
      price: args.price,
      currentPriceDate,
      fscConfig: effectiveFscConfig,
    });

    resultIsCurrent = plan.isCurrent;
    resultFsc = plan.fsc;

    // Check if a price document already exists for this company and date
    const q = db
      .collection('diesel_prices')
      .where('companyId', '==', args.targetCompanyId)
      .where('date', '==', args.date)
      .limit(1);

    const existingSnap = await tx.get(q);

    let targetDocRef: admin.firestore.DocumentReference;
    let createdAt: admin.firestore.FieldValue | admin.firestore.Timestamp =
      admin.firestore.FieldValue.serverTimestamp();

    if (!existingSnap.empty) {
      targetDocRef = existingSnap.docs[0].ref;
      resultDocId = targetDocRef.id;
      const existingData = existingSnap.docs[0].data();
      if (existingData.createdAt) {
        createdAt = existingData.createdAt;
      }
    } else {
      targetDocRef = db.collection('diesel_prices').doc(plan.deterministicDocId);
      resultDocId = targetDocRef.id;
    }

    // Write diesel_prices history record
    tx.set(
      targetDocRef,
      {
        companyId: args.targetCompanyId,
        price: args.price,
        date: args.date,
        source: args.source,
        updatedBy: args.actorIdentity,
        createdAt,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        fscRate: plan.fsc?.rate ?? null,
        fscUnit: plan.fsc?.unit ?? null,
      },
      { merge: true }
    );

    // Atomically update company current price if this date is >= currentPriceDate
    if (plan.isCurrent) {
      const companyUpdates: Record<string, unknown> = {
        currentDieselPrice: args.price,
        currentPriceDate: args.date,
        currentFscRate: plan.fsc?.rate ?? null,
        currentFscUnit: plan.fsc?.unit ?? null,
      };
      tx.update(companyRef, companyUpdates);
    }
  });

  return { isCurrent: resultIsCurrent, docId: resultDocId, fsc: resultFsc };
}

/**
 * Callable: dashboard:staffSaveDieselPrice
 *
 * Saves a diesel price entry for a company. Validates bounds, enforces manager/billing
 * authorization, derives actor identity server-side, and commits atomically.
 */
export const staffSaveDieselPrice = httpsV2.onCall(OPTS, async (request) => {
  const db = admin.firestore();

  const caller = await loadCallerProfile(
    request.auth?.uid,
    request.auth?.token as Record<string, unknown> | undefined
  );

  const data = (request.data || {}) as Record<string, unknown>;
  const targetCompanyId = typeof data.targetCompanyId === 'string' ? data.targetCompanyId.trim() : '';

  if (!targetCompanyId || !TARGET_ID_RE.test(targetCompanyId)) {
    throw new httpsV2.HttpsError('invalid-argument', 'target_company_invalid:Invalid target company ID');
  }

  // Authorize caller against target company
  const authz = authorizeDieselSaveCaller(caller, targetCompanyId);
  if (!authz.ok) {
    throw new httpsV2.HttpsError(authz.code, authz.reason);
  }

  // Validate price, date, source
  const val = validateManualPrice({
    price: data.price,
    date: data.date,
    source: data.source,
  });
  if (!val.ok) {
    throw new httpsV2.HttpsError('invalid-argument', `${val.reason}:Invalid price or date`);
  }

  // Server-derive actor identity
  const actorIdentity = caller.displayName || caller.email || `staff:${caller.uid}`;

  // Execute atomic, idempotent transaction
  const result = await applySinglePriceWrite(db, {
    targetCompanyId,
    date: val.date,
    price: val.price,
    source: val.source,
    actorIdentity,
  });

  await writeSecurityAudit({
    action: 'staffSaveDieselPrice',
    actorUid: caller.uid,
    detail: {
      targetCompanyId,
      price: val.price,
      date: val.date,
      source: val.source,
      actorIdentity,
      isCurrent: result.isCurrent,
      fscRate: result.fsc?.rate ?? null,
      result: 'ok',
      at: new Date().toISOString(),
    },
  });

  return {
    ok: true as const,
    targetCompanyId,
    price: val.price,
    date: val.date,
    source: val.source,
    isCurrent: result.isCurrent,
    fscRate: result.fsc?.rate ?? null,
    fscUnit: result.fsc?.unit ?? null,
    docId: result.docId,
  };
});
