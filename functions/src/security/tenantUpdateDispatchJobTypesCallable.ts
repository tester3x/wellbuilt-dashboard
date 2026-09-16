import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { writeSecurityAudit } from './audit';
import { ADMIN_AUDIT_COLLECTION, buildAuditRecord } from '../admin/adminAudit';
import { authorizeAdminCall, PLATFORM_ADMINS_COLLECTION } from '../admin/authority';
import {
  evaluateTenantCallerAccess,
  validateDispatchJobTypesPayload,
  type TenantCaller,
} from './operational/tenantDispatchJobTypes';

const DEFAULT_ROLE_CAPABILITIES: Record<string, string[]> = {
  it: ['manageCompany', 'manageDrivers', 'manageEquipment', 'viewAllCompanies'],
  admin: ['manageCompany', 'manageDrivers', 'manageEquipment'],
  manager: ['manageDrivers'],
  dispatch: [],
  payroll: [],
  viewer: [],
  driver: [],
  safety: [],
  lead: [],
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

/**
 * Authoritatively resolve caller identity, roles, tenant binding,
 * and effective capabilities from server-side RTDB and Firestore records.
 */
export async function resolveTenantCaller(
  authUid: string | undefined,
  authToken?: Record<string, unknown> | null,
): Promise<TenantCaller> {
  if (!authUid) {
    throw new httpsV2.HttpsError('unauthenticated', 'Must be signed in');
  }

  const token = authToken || {};
  const fs = admin.firestore();
  const rtdb = admin.database();

  // Check cryptographic platform-admin authority first (custom claim + enabled server record)
  let isPlatformAdmin = false;
  if (token.wellbuiltAdmin === true) {
    try {
      const adminDoc = await fs.collection(PLATFORM_ADMINS_COLLECTION).doc(authUid).get();
      const adminAuth = authorizeAdminCall(
        { uid: authUid, token },
        adminDoc.exists ? (adminDoc.data() as Record<string, unknown>) : null,
      );
      if (adminAuth.ok) {
        isPlatformAdmin = true;
      }
    } catch {
      // best-effort check
    }
  }

  // 1. Authoritative RTDB profile
  try {
    const snap = await rtdb.ref(`users/${authUid}`).once('value');
    if (snap.exists()) {
      const userData = (snap.val() || {}) as Record<string, unknown>;
      const roles = resolveRoles(userData);
      const companyId = typeof userData.companyId === 'string' ? userData.companyId.trim() : null;

      // Legacy unscoped IT/Admin fallback
      if (!companyId && !isPlatformAdmin && roles.some((r) => r === 'admin' || r === 'it')) {
        isPlatformAdmin = true;
      }

      let overrides: Record<string, string[]> = {};
      if (companyId) {
        try {
          const compSnap = await fs.collection('companies').doc(companyId).get();
          overrides = (compSnap.data()?.roleCapabilities || {}) as Record<string, string[]>;
        } catch {
          // best-effort
        }
      }

      const caps = resolveCaps(roles, overrides);
      if (token.manageCompany === true || token.manageCompany === 'true') {
        if (!caps.includes('manageCompany')) caps.push('manageCompany');
      }

      const emailRaw = token.email || userData.email;
      const actorEmail = typeof emailRaw === 'string' ? emailRaw : null;

      return {
        uid: authUid,
        roles,
        companyId,
        caps,
        isPlatformAdmin,
        actorEmail,
      };
    }
  } catch (err) {
    // continue to claims fallback
  }

  // 2. Auth custom claims fallback (emulator and token-driven test environments)
  const claimRoles: string[] = [];
  if (typeof token.role === 'string') claimRoles.push(token.role);
  if (Array.isArray(token.roles)) {
    for (const r of token.roles) {
      if (typeof r === 'string') claimRoles.push(r);
    }
  }
  const claimCompany = typeof token.companyId === 'string' ? token.companyId.trim() : null;
  if (!claimCompany && !isPlatformAdmin && claimRoles.some((r) => r === 'admin' || r === 'it')) {
    isPlatformAdmin = true;
  }

  let overrides: Record<string, string[]> = {};
  if (claimCompany) {
    try {
      const compSnap = await fs.collection('companies').doc(claimCompany).get();
      overrides = (compSnap.data()?.roleCapabilities || {}) as Record<string, string[]>;
    } catch {
      // best-effort
    }
  }

  const caps = resolveCaps(claimRoles, overrides);
  if (token.manageCompany === true || token.manageCompany === 'true') {
    if (!caps.includes('manageCompany')) caps.push('manageCompany');
  }

  const emailRaw = token.email;
  const actorEmail = typeof emailRaw === 'string' ? emailRaw : null;

  return {
    uid: authUid,
    roles: claimRoles.length ? claimRoles : ['viewer'],
    companyId: claimCompany,
    caps,
    isPlatformAdmin,
    actorEmail,
  };
}

export const tenantUpdateDispatchJobTypes = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const caller = await resolveTenantCaller(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );

    const raw = (request.data || {}) as Record<string, unknown>;
    const targetCompanyId = typeof raw.companyId === 'string' ? raw.companyId.trim() : '';
    if (!targetCompanyId) {
      throw new httpsV2.HttpsError('invalid-argument', 'companyId is required');
    }

    // Access evaluation (tenant scoping, manageCompany capability, explicit platform admin)
    const access = evaluateTenantCallerAccess(caller, targetCompanyId);
    if (!access.ok) {
      const code = access.reason === 'unauthenticated'
        ? 'unauthenticated'
        : 'permission-denied';
      throw new httpsV2.HttpsError(code, access.reason);
    }

    // Payload validation
    const rawConfig = raw.dispatchJobTypes !== undefined ? raw.dispatchJobTypes : raw;
    const validated = validateDispatchJobTypesPayload(rawConfig);
    if (!validated.ok) {
      const msg = validated.field ? `${validated.reason}:${validated.field}` : validated.reason;
      throw new httpsV2.HttpsError('invalid-argument', msg);
    }

    // Stamp updated metadata
    const payloadToSave = {
      ...validated.payload,
      updatedAtIso: new Date().toISOString(),
      updatedByUid: caller.uid,
    };

    const fs = admin.firestore();
    const companyRef = fs.collection('companies').doc(targetCompanyId);

    // Verify company document exists
    const companySnap = await companyRef.get();
    if (!companySnap.exists) {
      throw new httpsV2.HttpsError('not-found', `Company ${targetCompanyId} not found`);
    }

    // Write ONLY dispatchJobTypes on the company document
    await companyRef.update({
      dispatchJobTypes: payloadToSave,
    });

    // Audit logging:
    // 1. Existing security_audit mechanism for all operational updates
    await writeSecurityAudit({
      action: 'tenantUpdateDispatchJobTypes',
      actorUid: caller.uid,
      detail: {
        companyId: targetCompanyId,
        itemCount: payloadToSave.items.length,
        isPlatformAdmin: caller.isPlatformAdmin,
      },
    });

    // 2. Existing platform_admin_audit mechanism if performed by a platform admin
    if (caller.isPlatformAdmin) {
      try {
        const auditRecord = buildAuditRecord(
          {
            operation: 'tenant_update_dispatch_job_types',
            targetType: 'company',
            targetId: targetCompanyId,
            actorUid: caller.uid,
            actorEmail: caller.actorEmail || null,
            reason: 'Platform admin configured tenant dispatch job types',
            changedFields: ['dispatchJobTypes'],
          },
          FieldValue.serverTimestamp(),
        );
        await fs.collection(ADMIN_AUDIT_COLLECTION).add(auditRecord);
      } catch (err) {
        console.warn('[tenantUpdateDispatchJobTypes] platform_admin_audit log failed:', (err as Error)?.message);
      }
    }

    return {
      ok: true as const,
      companyId: targetCompanyId,
      itemCount: payloadToSave.items.length,
      updatedAtIso: payloadToSave.updatedAtIso,
    };
  },
);
