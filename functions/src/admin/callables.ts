/**
 * vc51.9A6-B protected admin callables — thin onCall adapters over the
 * pure handlers in adminHandlers.ts.
 *
 * APP CHECK PREPARATION (Part 15): `enforceAppCheck` is centralized in
 * ADMIN_CALLABLE_OPTIONS below and currently FALSE — App Check
 * enforcement is off suite-wide. When the App Check rollout is
 * approved, flipping that single flag enforces client authenticity on
 * every admin callable at once. App Check is an abuse/authenticity
 * control and does NOT replace the admin authority gate (verified
 * wellbuiltAdmin claim + enabled platform_admins record); nor does the
 * authority gate replace App Check.
 */

import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { randomBytes } from 'crypto';
import { AdminCallError, type AdminDeps, type AdminTransaction } from './adminDeps';
import {
  addEntitlementOverrideHandler,
  archiveCompanyHandler,
  assignCompanyPlanHandler,
  createPlanHandler,
  deprecatePlanHandler,
  getCompanyContractConfigurationHandler,
  getPlanHandler,
  listAdminAuditHandler,
  listPlansHandler,
  previewCompanyEffectiveCapabilitiesHandler,
  removeEntitlementOverrideHandler,
  setCompanyContractEnforcementHandler,
  setCompanyWorkPeriodConfigurationHandler,
  updateCompanySafeHandler,
  updatePlanHandler,
} from './adminHandlers';

export const ADMIN_CALLABLE_OPTIONS = {
  // Part 15: flip to true when App Check enforcement is approved live.
  enforceAppCheck: false,
} as const;

/** Production AdminDeps over the real Admin SDK. */
export function buildFirestoreAdminDeps(): AdminDeps {
  const db = admin.firestore();
  return {
    async getDoc(path) {
      const snap = await db.doc(path).get();
      return { exists: snap.exists, data: snap.data() as Record<string, unknown> | undefined };
    },
    runTransaction(fn) {
      return db.runTransaction(async (tx) => {
        const adapter: AdminTransaction = {
          async get(path) {
            const snap = await tx.get(db.doc(path));
            return { exists: snap.exists, data: snap.data() as Record<string, unknown> | undefined };
          },
          update(path, fields) { tx.update(db.doc(path), fields); },
          create(path, data) { tx.create(db.doc(path), data); },
        };
        return fn(adapter);
      });
    },
    async listDocsById(collection, opts) {
      let q = db.collection(collection)
        .orderBy(admin.firestore.FieldPath.documentId(), opts.direction)
        .limit(opts.limit);
      if (opts.startAfterId) q = q.startAfter(opts.startAfterId);
      const snap = await q.get();
      return snap.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> }));
    },
    newAuditId() {
      return `${String(Date.now()).padStart(15, '0')}_${randomBytes(4).toString('hex')}`;
    },
    serverTimestamp() { return FieldValue.serverTimestamp(); },
    nowMs() { return Date.now(); },
  };
}

type Handler<R> = (deps: AdminDeps, auth: { uid?: string | null; token?: Record<string, unknown> | null } | null, data: unknown) => Promise<R>;

function wrap<R>(handler: Handler<R>) {
  return httpsV2.onCall(ADMIN_CALLABLE_OPTIONS, async (request): Promise<R> => {
    try {
      return await handler(
        buildFirestoreAdminDeps(),
        request.auth ? { uid: request.auth.uid, token: request.auth.token as unknown as Record<string, unknown> } : null,
        request.data,
      );
    } catch (err) {
      if (err instanceof AdminCallError) {
        // Machine-readable adminCode travels in details; message stays terse.
        throw new httpsV2.HttpsError(err.code, err.adminCode, { adminCode: err.adminCode });
      }
      console.error('[adminCallables] unexpected failure:', (err as Error)?.message);
      throw new httpsV2.HttpsError('internal', 'internal', { adminCode: 'internal' });
    }
  });
}

// Part 5 — plan mutations
export const adminCreatePlan = wrap(createPlanHandler);
export const adminUpdatePlan = wrap(updatePlanHandler);
export const adminDeprecatePlan = wrap(deprecatePlanHandler);

// Part 6 — company contract mutations
export const adminAssignCompanyPlan = wrap(assignCompanyPlanHandler);
export const adminAddEntitlementOverride = wrap(addEntitlementOverrideHandler);
export const adminRemoveEntitlementOverride = wrap(removeEntitlementOverrideHandler);
export const adminSetCompanyWorkPeriodConfiguration = wrap(setCompanyWorkPeriodConfigurationHandler);
export const adminSetCompanyContractEnforcement = wrap(setCompanyContractEnforcementHandler);

// Part 7 — safe replacement / archive
export const adminUpdateCompanySafe = wrap(updateCompanySafeHandler);
export const adminArchiveCompany = wrap(archiveCompanyHandler);

// Part 8 — bounded reads
export const adminListPlans = wrap(listPlansHandler);
export const adminGetPlan = wrap(getPlanHandler);
export const adminGetCompanyContractConfiguration = wrap(getCompanyContractConfigurationHandler);
export const adminPreviewCompanyEffectiveCapabilities = wrap(previewCompanyEffectiveCapabilitiesHandler);
export const adminListAdminAudit = wrap(listAdminAuditHandler);
