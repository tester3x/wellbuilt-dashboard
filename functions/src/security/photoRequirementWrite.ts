/**
 * Server-owned photo_requirements write path.
 *
 * Documents are keyed by operator slug (customerId) but MUST stamp
 * canonical companyId. Existing scoped docs cannot be restamped by
 * another company. Client direct writes remain denied by rules.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireAdminAuthority } from './adminAuth';
import { authorizeTargetCompany, staffHasCapability } from './canonicalAdminAuthority';

export function decidePhotoRequirementDoc(input: {
  customerId: string;
  companyId: string;
  enabled: boolean;
  version: number;
  requirements: unknown[];
}): { ok: true; doc: Record<string, unknown> } | { ok: false; reason: string } {
  const customerId = (input.customerId || '').trim();
  const companyId = (input.companyId || '').trim();
  if (!customerId) return { ok: false, reason: 'customerId_required' };
  if (!companyId) return { ok: false, reason: 'companyId_required' };
  if (!Array.isArray(input.requirements)) return { ok: false, reason: 'requirements_required' };
  return {
    ok: true,
    doc: {
      customerId,
      companyId,
      enabled: input.enabled !== false,
      version: Number.isFinite(input.version) ? input.version : 1,
      requirements: input.requirements,
      updatedAt: Date.now(),
    },
  };
}

export function planLegacyPhotoRequirementMigration(doc: Record<string, unknown> | null): {
  needsCompanyId: boolean;
  customerId: string | null;
  existingCompanyId: string | null;
} {
  if (!doc) return { needsCompanyId: false, customerId: null, existingCompanyId: null };
  const customerId = typeof doc.customerId === 'string' ? doc.customerId : null;
  const existingCompanyId = typeof doc.companyId === 'string' && doc.companyId.trim()
    ? doc.companyId
    : null;
  return {
    needsCompanyId: !existingCompanyId,
    customerId,
    existingCompanyId,
  };
}

export function decidePhotoRequirementWrite(input: {
  existing: Record<string, unknown> | null;
  callerClass: 'platform' | 'company_staff';
  callerCompanyId: string | null;
  stampCompanyId: string;
  requirementsProvided: boolean;
  explicitRebind?: boolean;
  expectedVersion?: number | null;
}): { ok: true; nextVersion: number; rebind: boolean } | { ok: false; reason: string } {
  if (!input.requirementsProvided) return { ok: false, reason: 'requirements_required' };
  if (!input.stampCompanyId) return { ok: false, reason: 'companyId_required' };

  if (!input.existing) {
    return { ok: true, nextVersion: 1, rebind: false };
  }

  const existingCompany = typeof input.existing.companyId === 'string'
    ? input.existing.companyId.trim()
    : '';
  const curVersion = typeof input.existing.version === 'number' ? input.existing.version : 0;
  if (input.expectedVersion != null && input.expectedVersion !== curVersion) {
    return { ok: false, reason: 'version_conflict' };
  }

  if (!existingCompany) {
    if (input.callerClass !== 'platform' || input.explicitRebind !== true) {
      return { ok: false, reason: 'legacy_unscoped_requires_platform_migration' };
    }
    return { ok: true, nextVersion: curVersion + 1, rebind: true };
  }

  if (existingCompany !== input.stampCompanyId) {
    if (input.callerClass !== 'platform' || input.explicitRebind !== true) {
      return { ok: false, reason: 'foreign_photo_requirement' };
    }
    return { ok: true, nextVersion: curVersion + 1, rebind: true };
  }

  if (input.callerClass === 'company_staff' && input.callerCompanyId !== existingCompany) {
    return { ok: false, reason: 'foreign_photo_requirement' };
  }
  return { ok: true, nextVersion: curVersion + 1, rebind: false };
}

export const upsertPhotoRequirementSpec = httpsV2.onCall(
  { timeoutSeconds: 20, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const authority = await requireAdminAuthority(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );
    if (authority.class !== 'platform' && !staffHasCapability(authority, 'manageCompany')) {
      throw new httpsV2.HttpsError('permission-denied', 'missing_manageCompany');
    }
    const data = (request.data || {}) as {
      customerId?: string;
      companyId?: string;
      enabled?: boolean;
      requirements?: unknown[];
      explicitRebind?: boolean;
      expectedVersion?: number;
    };
    if (!Object.prototype.hasOwnProperty.call(data, 'requirements')) {
      throw new httpsV2.HttpsError('invalid-argument', 'requirements_required');
    }
    if (data.requirements != null && !Array.isArray(data.requirements)) {
      throw new httpsV2.HttpsError('invalid-argument', 'requirements_required');
    }
    const companyId =
      (typeof data.companyId === 'string' && data.companyId.trim())
      || authority.companyId
      || '';
    const scoped = authorizeTargetCompany({
      authority,
      targetCompanyId: companyId,
      userSuppliedCompanyId: data.companyId || null,
    });
    if (!scoped.ok) throw new httpsV2.HttpsError('permission-denied', scoped.reason);

    const customerId = String(data.customerId || '').trim();
    if (!customerId) throw new httpsV2.HttpsError('invalid-argument', 'customerId_required');
    const ref = admin.firestore().collection('photo_requirements').doc(customerId);

    const written = await admin.firestore().runTransaction(async (tx) => {
      const cur = await tx.get(ref);
      const existing = cur.exists ? (cur.data() as Record<string, unknown>) : null;
      const plan = decidePhotoRequirementWrite({
        existing,
        callerClass: authority.class,
        callerCompanyId: authority.companyId,
        stampCompanyId: companyId,
        requirementsProvided: Array.isArray(data.requirements),
        explicitRebind: data.explicitRebind === true,
        expectedVersion: typeof data.expectedVersion === 'number' ? data.expectedVersion : null,
      });
      if (!plan.ok) {
        throw new httpsV2.HttpsError(
          plan.reason === 'version_conflict' ? 'aborted'
            : plan.reason === 'requirements_required' ? 'invalid-argument'
              : 'permission-denied',
          plan.reason,
        );
      }
      const decided = decidePhotoRequirementDoc({
        customerId,
        companyId,
        enabled: data.enabled !== false,
        version: plan.nextVersion,
        requirements: data.requirements as unknown[],
      });
      if (!decided.ok) throw new httpsV2.HttpsError('invalid-argument', decided.reason);
      tx.set(ref, decided.doc, { merge: true });
      if (plan.rebind) {
        tx.set(admin.firestore().collection('security_audit').doc(), {
          action: 'upsertPhotoRequirementSpec.rebind',
          actorUid: authority.uid,
          customerId,
          companyId,
          ts: Date.now(),
        });
      }
      return { version: decided.doc.version as number, rebind: plan.rebind };
    });
    return { ok: true, customerId, companyId, version: written.version, rebind: written.rebind };
  },
);
