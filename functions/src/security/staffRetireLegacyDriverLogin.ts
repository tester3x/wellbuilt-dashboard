/**
 * Separate audited retirement of the legacy approved-row login.
 *
 * Preview/Apply with a digest bound to driverId, complete binding, and both
 * proofs. Partial retirement is repaired. History and the binding used for
 * trusted aliases are never deleted.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requirePlatformAdmin } from './adminAuth';
import { writeSecurityAudit } from './audit';
import {
  BINDING_BY_APPROVED,
  BINDING_BY_DRIVER,
  BINDING_ROOT,
  DRIVER_UUID_RE,
  IDENTITY_PROOF,
  decideRetireLegacyLogin,
  parseBinding,
  parseIdentityProof,
  retirePreviewDigest,
} from './operational/identityBinding';
import { commitIdentityBindingWrite } from './operational/bindingApplyTransaction';

const ALLOWED = new Set(['driverId', 'mode', 'expectedPreviewDigest']);

export const staffRetireLegacyDriverLogin = httpsV2.onCall(
  { timeoutSeconds: 20, memory: '256MiB', enforceAppCheck: false },
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
    const mode = raw.mode === 'apply' ? 'apply' : 'dry-run';
    if (!DRIVER_UUID_RE.test(driverId)) {
      throw new httpsV2.HttpsError('invalid-argument', 'driver_id_malformed');
    }

    const rtdb = admin.database();
    const byDriver = parseBinding((await rtdb.ref(BINDING_BY_DRIVER(driverId)).once('value')).val());
    const approvedKey = byDriver?.approvedKey;
    const byApproved = approvedKey
      ? parseBinding((await rtdb.ref(BINDING_BY_APPROVED(approvedKey)).once('value')).val())
      : null;
    const proof = parseIdentityProof((await rtdb.ref(IDENTITY_PROOF(driverId)).once('value')).val());
    const approvedRow = approvedKey
      ? ((await rtdb.ref(`drivers/approved/${approvedKey}`).once('value')).val() as Record<string, unknown> | null)
      : null;

    const decision = decideRetireLegacyLogin({
      byDriver,
      byApproved,
      proof,
      approvedLegacyLoginRetired: approvedRow?.legacyLoginRetired === true,
    });

    if (decision.action === 'refuse') {
      await writeSecurityAudit({
        action: 'staffRetireLegacyDriverLogin_fail',
        actorUid: caller.uid,
        driverId,
        detail: { reason: decision.reason },
      });
      throw new httpsV2.HttpsError('failed-precondition', decision.reason);
    }

    const binding = byDriver && byApproved ? byDriver : byDriver || byApproved;
    if (!binding) {
      throw new httpsV2.HttpsError('failed-precondition', 'binding_missing');
    }
    const digest = retirePreviewDigest({ driverId, binding, proof });

    if (mode === 'dry-run') {
      return {
        ok: true,
        mode: 'dry-run' as const,
        driverId,
        previewDigest: digest,
        action: decision.action,
      };
    }

    const expected = typeof raw.expectedPreviewDigest === 'string' ? raw.expectedPreviewDigest : '';
    if (!expected || expected !== digest) {
      throw new httpsV2.HttpsError('failed-precondition', 'stale_preview');
    }

    if (decision.action === 'already_retired') {
      return { ok: true, driverId, status: 'legacy_login_retired' as const, already: true };
    }

    const bindWrite = await commitIdentityBindingWrite({
      bindingsRef: rtdb.ref(BINDING_ROOT) as never,
      driverId: binding.driverId,
      approvedKey: binding.approvedKey,
      status: 'legacy_login_retired',
      opId: binding.opId,
    });
    if (!bindWrite.ok && bindWrite.reason !== 'already_exact') {
      // One-sided retired state: retry is repair, not a delete.
      throw new httpsV2.HttpsError('failed-precondition', bindWrite.reason);
    }

    await rtdb.ref(`drivers/approved/${binding.approvedKey}`).update({
      legacyLoginRetired: true,
    });

    await writeSecurityAudit({
      action: 'staffRetireLegacyDriverLogin',
      actorUid: caller.uid,
      driverId,
      detail: { status: 'legacy_login_retired', repaired: decision.action === 'repair' },
    });
    return {
      ok: true,
      driverId,
      status: 'legacy_login_retired' as const,
      already: false,
    };
  },
);
