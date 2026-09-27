import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import {
  requireTrustedCompanyCapability,
  TRUSTED_CAPABILITY_MANAGE_DRIVERS,
} from './trustedStaffAuthority';
import {
  CLAIM_COLLECTION,
  INDEX_COLLECTION,
  REVISION_COLLECTION,
} from './operational/jobPacketRevisionStore';
import {
  RECEIPT_COLLECTION,
  runPublishJobPacketRevision,
  type PublishStoreTx,
} from './operational/jobPacketPublish';

function throwFail(result: { ok: false; reason: string; field?: string }): never {
  const msg = result.field ? `${result.reason}:${result.field}` : result.reason;
  if (result.reason === 'unauthenticated') {
    throw new httpsV2.HttpsError('unauthenticated', msg);
  }
  if (
    result.reason === 'driver_forbidden'
    || result.reason === 'unprivileged_staff'
    || result.reason === 'cross_tenant_forbidden'
    || result.reason === 'missing_company'
  ) {
    throw new httpsV2.HttpsError('permission-denied', msg);
  }
  if (
    result.reason === 'conflict'
    || result.reason === 'stale_expected_revision'
    || result.reason === 'revision_collision'
    || result.reason === 'immutable_packet_revision'
    || result.reason === 'duplicate_content_revision'
    || result.reason === 'store_integrity'
    || result.reason === 'malformed_head'
    || result.reason === 'malformed_receipt'
    || result.reason === 'head_revision_missing'
    || result.reason === 'receipt_revision_missing'
    || result.reason === 'head_hash_mismatch'
    || result.reason === 'receipt_hash_mismatch'
  ) {
    throw new httpsV2.HttpsError('failed-precondition', msg);
  }
  throw new httpsV2.HttpsError('invalid-argument', msg);
}

export const publishJobPacketRevision = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const caller = await requireTrustedCompanyCapability(
      request.auth?.uid,
      TRUSTED_CAPABILITY_MANAGE_DRIVERS,
    );
    const fs = admin.firestore();
    // Canonical revisions are plain JSON. Capture the server clock once per
    // invocation so transaction retries reuse one revision/receipt/head time.
    const publishedAt = new Date().toISOString();
    const outcome = await fs.runTransaction(async (tx) => {
      const store: PublishStoreTx = {
        async getRevision(docId: string) {
          const snap = await tx.get(fs.collection(REVISION_COLLECTION).doc(docId));
          return snap.exists ? (snap.data() as Record<string, unknown>) : null;
        },
        async getClaim(docId: string) {
          const snap = await tx.get(fs.collection(CLAIM_COLLECTION).doc(docId));
          return snap.exists ? (snap.data() as Record<string, unknown>) : null;
        },
        createRevision(docId: string, data: Record<string, unknown>) {
          tx.create(fs.collection(REVISION_COLLECTION).doc(docId), data);
        },
        createClaim(docId: string, data: Record<string, unknown>) {
          tx.create(fs.collection(CLAIM_COLLECTION).doc(docId), data);
        },
        async getHead(docId: string) {
          const snap = await tx.get(fs.collection(INDEX_COLLECTION).doc(docId));
          return snap.exists ? (snap.data() as Record<string, unknown>) : null;
        },
        createHead(docId: string, data: Record<string, unknown>) {
          tx.create(fs.collection(INDEX_COLLECTION).doc(docId), data);
        },
        updateHead(docId: string, data: Record<string, unknown>) {
          tx.update(fs.collection(INDEX_COLLECTION).doc(docId), data);
        },
        async getReceipt(docId: string) {
          const snap = await tx.get(fs.collection(RECEIPT_COLLECTION).doc(docId));
          return snap.exists ? (snap.data() as Record<string, unknown>) : null;
        },
        createReceipt(docId: string, data: Record<string, unknown>) {
          tx.create(fs.collection(RECEIPT_COLLECTION).doc(docId), data);
        },
      };
      return runPublishJobPacketRevision({
        caller,
        request: request.data,
        store,
        publishedAt,
      });
    });
    if (!outcome.ok) throwFail(outcome);
    return {
      ok: true as const,
      result: outcome.result,
      packageId: outcome.packageId,
      revision: outcome.revision,
      packetRevision: outcome.packetRevision,
      contentHash: outcome.contentHash,
      policyHash: outcome.policyHash,
    };
  },
);
