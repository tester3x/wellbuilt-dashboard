/**
 * Platform-admin governed bind + profile hydration for an already-canonical
 * UUID. No password is accepted. Used to attach the exact legacy approved
 * key and copy remaining operational fields onto the canonical profile.
 *
 * Clients cannot use this to request history by an arbitrary key.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { randomUUID } from 'crypto';
import { requirePlatformAdmin } from './adminAuth';
import { writeSecurityAudit } from './audit';
import { APPROVED_KEY_RE, DRIVER_UUID_RE } from './operational/identityBinding';
import { runCustomerOwnedUpgrade } from './operational/customerOwnedUpgrade';
import { productionUpgradeStore } from './operational/customerOwnedUpgradeStore';
import { previewCanonicalHydration } from './operational/canonicalProfileHydration';

const ALLOWED = new Set(['driverId', 'approvedKey', 'mode', 'expectedPreviewDigest']);

export const staffHydrateCanonicalIdentity = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const caller = await requirePlatformAdmin(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );
    const raw = (request.data || {}) as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (!ALLOWED.has(key)) {
        throw new httpsV2.HttpsError('invalid-argument', `Unexpected field: ${key}`);
      }
    }
    const driverId = typeof raw.driverId === 'string' ? raw.driverId.trim() : '';
    const approvedKey = typeof raw.approvedKey === 'string' ? raw.approvedKey.trim() : '';
    const mode = raw.mode === 'apply' ? 'apply' : 'dry-run';
    if (!DRIVER_UUID_RE.test(driverId)) {
      throw new httpsV2.HttpsError('invalid-argument', 'driver_id_malformed');
    }
    if (!APPROVED_KEY_RE.test(approvedKey)) {
      throw new httpsV2.HttpsError('invalid-argument', 'approved_key_malformed');
    }

    const store = productionUpgradeStore(admin.firestore(), admin.database());
    const row = await store.readApproved(approvedKey);
    if (!row) throw new httpsV2.HttpsError('not-found', 'approved_row_missing');
    const profile = await store.readProfile(driverId);
    if (!profile) throw new httpsV2.HttpsError('not-found', 'profile_missing');
    const preview = previewCanonicalHydration(profile, row, { driverId, approvedKey });

    if (mode === 'dry-run') {
      await writeSecurityAudit({
        action: 'staffHydrateCanonicalIdentity_preview',
        actorUid: caller.uid,
        driverId,
        detail: { conflictCount: preview.conflicts.length, digest: preview.digest },
      });
      return {
        ok: true,
        mode: 'dry-run' as const,
        driverId,
        previewDigest: preview.digest,
        copiedFields: Object.keys(preview.copy),
        preserved: preview.preserved,
        conflicts: preview.conflicts,
      };
    }

    const expected = typeof raw.expectedPreviewDigest === 'string' ? raw.expectedPreviewDigest : '';
    if (!expected || expected !== preview.digest) {
      throw new httpsV2.HttpsError('failed-precondition', 'stale_preview');
    }

    const displayName = typeof profile.displayName === 'string'
      ? profile.displayName
      : typeof row.displayName === 'string' ? row.displayName : '';

    const result = await runCustomerOwnedUpgrade(store, {
      provenApprovedKey: approvedKey,
      displayName,
      callerUid: caller.uid,
      opId: randomUUID(),
      existingDriverId: driverId,
      skipCredentialWrite: true,
      expectedPreviewDigest: expected,
    });

    await writeSecurityAudit({
      action: result.status === 'ok'
        ? 'staffHydrateCanonicalIdentity'
        : 'staffHydrateCanonicalIdentity_fail',
      actorUid: caller.uid,
      driverId: result.driverId,
      detail: { status: result.status, reason: result.reason },
    });

    if (result.status !== 'ok' || !result.terminalProven) {
      throw new httpsV2.HttpsError('failed-precondition', result.reason);
    }

    return {
      ok: true,
      mode: 'apply' as const,
      driverId: result.driverId,
      previewDigest: preview.digest,
      copiedFields: Object.keys(preview.copy),
      preserved: preview.preserved,
      conflicts: preview.conflicts,
    };
  },
);
