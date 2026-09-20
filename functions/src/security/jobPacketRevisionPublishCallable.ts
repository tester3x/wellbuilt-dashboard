import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { authorizeAdminCall } from '../admin/authority';
import {
  CLAIM_COLLECTION,
  REVISION_COLLECTION,
  decidePublishAccess,
  persistJobPacketRevision,
  tenantPublishCapsFromRoles,
  validatePublishInput,
  type RevisionStoreTx,
  type StoreFailure,
} from './operational/jobPacketRevisionStore';

function throwStoreFailure(result: StoreFailure): never {
  const msg = result.field ? `${result.reason}:${result.field}` : result.reason;
  if (result.reason === 'unauthenticated') {
    throw new httpsV2.HttpsError('unauthenticated', msg);
  }
  if (
    result.reason === 'platform_admin_required'
    || result.reason === 'missing_admin_claim'
    || result.reason === 'claim_not_true'
    || result.reason === 'no_admin_record'
    || result.reason === 'admin_record_disabled'
    || result.reason === 'admin_record_malformed'
    || result.reason === 'unsupported_policy_version'
  ) {
    throw new httpsV2.HttpsError('permission-denied', msg);
  }
  if (
    result.reason === 'immutable_packet_revision'
    || result.reason === 'duplicate_content_revision'
    || result.reason === 'store_integrity'
    || result.reason.startsWith('supersedes_')
  ) {
    throw new httpsV2.HttpsError('failed-precondition', msg);
  }
  throw new httpsV2.HttpsError('invalid-argument', msg);
}

function resolveRoles(userData: Record<string, unknown>): string[] {
  if (Array.isArray(userData.roles) && userData.roles.length > 0) {
    return userData.roles.filter((r): r is string => typeof r === 'string');
  }
  return typeof userData.role === 'string' ? [userData.role] : [];
}

async function loadTenantCaller(uid: string): Promise<{ companyId?: string; caps: string[] } | null> {
  const snap = await admin.database().ref(`users/${uid}`).once('value');
  if (!snap.exists()) return null;
  const userData = (snap.val() || {}) as Record<string, unknown>;
  const roles = resolveRoles(userData);
  const companyId = typeof userData.companyId === 'string' ? userData.companyId.trim() : undefined;
  let overrides: Record<string, string[]> = {};
  if (companyId) {
    const company = await admin.firestore().collection('companies').doc(companyId).get();
    overrides = (company.data()?.roleCapabilities || {}) as Record<string, string[]>;
  }
  return { companyId, caps: tenantPublishCapsFromRoles(roles, overrides) };
}

function readTargetCompanyId(data: unknown): string | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const desc = Object.getOwnPropertyDescriptor(data, 'targetCompanyId');
  if (!desc) return undefined;
  if (desc.get !== undefined || desc.set !== undefined) return undefined;
  return typeof desc.value === 'string' ? desc.value : undefined;
}

export const publishJobPacketRevision = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new httpsV2.HttpsError('unauthenticated', 'Must be signed in');
    const token = request.auth?.token as Record<string, unknown> | undefined;

    const adminDoc = await admin.firestore().collection('platform_admins').doc(uid).get();
    const platformAdminDecision = authorizeAdminCall(
      { uid, token: token || null },
      adminDoc.exists ? (adminDoc.data() as Record<string, unknown>) : null,
    );

    const tenantCaller = await loadTenantCaller(uid);
    const access = decidePublishAccess({
      authUid: uid,
      tenantCaller,
      platformAdminDecision,
      requestedTargetCompanyId: readTargetCompanyId(request.data),
    });
    if (!access.ok) throwStoreFailure(access);

    const validated = validatePublishInput(request.data, {
      companyId: access.companyId,
      publishedByUid: uid,
    });
    if (!validated.ok) throwStoreFailure(validated);

    const fs = admin.firestore();
    const outcome = await fs.runTransaction(async (t) => {
      const adapter: RevisionStoreTx = {
        async getRevision(docId: string) {
          const snap = await t.get(fs.collection(REVISION_COLLECTION).doc(docId));
          return snap.exists ? (snap.data() as Record<string, unknown>) : null;
        },
        async getClaim(docId: string) {
          const snap = await t.get(fs.collection(CLAIM_COLLECTION).doc(docId));
          return snap.exists ? (snap.data() as Record<string, unknown>) : null;
        },
        createRevision(docId: string, data: Record<string, unknown>) {
          t.create(fs.collection(REVISION_COLLECTION).doc(docId), data);
        },
        createClaim(docId: string, data: Record<string, unknown>) {
          t.create(fs.collection(CLAIM_COLLECTION).doc(docId), data);
        },
      };
      return persistJobPacketRevision(
        adapter,
        { envelope: validated.envelope, contentHash: validated.contentHash },
        FieldValue.serverTimestamp(),
      );
    });
    if (!outcome.ok) throwStoreFailure(outcome);
    return {
      ok: true as const,
      publication: outcome.publication,
      companyId: outcome.revision.companyId,
      packageId: outcome.revision.packageId,
      revision: outcome.revision.revision,
      contentHash: outcome.revision.contentHash,
    };
  },
);
