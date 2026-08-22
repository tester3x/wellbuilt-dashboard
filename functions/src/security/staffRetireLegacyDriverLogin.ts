/**
 * Separate audited retirement of the legacy approved-row login.
 *
 * Preview/Apply digest is bound to driverId, approvedKey, surviving
 * status/opId, both proof conditions, and approved-row retirement state.
 * Partial bindings are repaired only after both proofs. The approved row
 * is stamped only after a terminal reread of both binding sides.
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
  evaluateRetirementPreview,
  parseBinding,
  parseIdentityProof,
  retirementTerminalAllowsApprovedStamp,
  type IdentityBinding,
} from './operational/identityBinding';
import { commitIdentityBindingWrite } from './operational/bindingApplyTransaction';

const ALLOWED = new Set(['driverId', 'mode', 'expectedPreviewDigest']);

async function loadRetirementBindings(
  rtdb: admin.database.Database,
  driverId: string,
): Promise<{
  byDriver: IdentityBinding | null;
  byApproved: IdentityBinding | null;
  byApprovedOwnedByDriver: IdentityBinding[];
}> {
  const byDriver = parseBinding(
    (await rtdb.ref(BINDING_BY_DRIVER(driverId)).once('value')).val(),
  );
  if (byDriver) {
    const byApproved = parseBinding(
      (await rtdb.ref(BINDING_BY_APPROVED(byDriver.approvedKey)).once('value')).val(),
    );
    return { byDriver, byApproved, byApprovedOwnedByDriver: [] };
  }
  const owned: IdentityBinding[] = [];
  const snap = await rtdb.ref(`${BINDING_ROOT}/byApproved`).once('value');
  const raw = snap.val();
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const rec of Object.values(raw as Record<string, unknown>)) {
      const parsed = parseBinding(rec);
      if (parsed && parsed.driverId === driverId) owned.push(parsed);
    }
  }
  const byApproved = owned.length === 1 ? owned[0] : null;
  return { byDriver: null, byApproved, byApprovedOwnedByDriver: owned };
}

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
    const loaded = await loadRetirementBindings(rtdb, driverId);
    const proof = parseIdentityProof((await rtdb.ref(IDENTITY_PROOF(driverId)).once('value')).val());
    const approvedKey = loaded.byDriver?.approvedKey
      || loaded.byApproved?.approvedKey
      || loaded.byApprovedOwnedByDriver[0]?.approvedKey
      || '';
    const approvedRow = approvedKey
      ? ((await rtdb.ref(`drivers/approved/${approvedKey}`).once('value')).val() as Record<string, unknown> | null)
      : null;

    const preview = evaluateRetirementPreview({
      requestedDriverId: driverId,
      byDriver: loaded.byDriver,
      byApproved: loaded.byApproved,
      byApprovedOwnedByDriver: loaded.byApprovedOwnedByDriver,
      proof,
      approvedLegacyLoginRetired: approvedRow?.legacyLoginRetired === true,
    });

    if (!preview.ok) {
      await writeSecurityAudit({
        action: 'staffRetireLegacyDriverLogin_fail',
        actorUid: caller.uid,
        driverId,
        detail: { reason: preview.reason },
      });
      throw new httpsV2.HttpsError('failed-precondition', preview.reason);
    }

    if (mode === 'dry-run') {
      return {
        ok: true,
        mode: 'dry-run' as const,
        driverId,
        previewDigest: preview.digest,
        action: preview.decision.action,
      };
    }

    const expected = typeof raw.expectedPreviewDigest === 'string' ? raw.expectedPreviewDigest : '';
    if (!expected || expected !== preview.digest) {
      throw new httpsV2.HttpsError('failed-precondition', 'stale_preview');
    }

    if (preview.decision.action === 'already_retired') {
      return { ok: true, driverId, status: 'legacy_login_retired' as const, already: true };
    }

    const surviving = preview.decision.surviving;
    const bindWrite = await commitIdentityBindingWrite({
      bindingsRef: rtdb.ref(BINDING_ROOT) as never,
      driverId: surviving.driverId,
      approvedKey: surviving.approvedKey,
      status: 'legacy_login_retired',
      opId: surviving.opId,
    });
    if (!bindWrite.ok && bindWrite.reason !== 'already_exact') {
      throw new httpsV2.HttpsError('failed-precondition', bindWrite.reason);
    }

    const liveByDriver = parseBinding(
      (await rtdb.ref(BINDING_BY_DRIVER(surviving.driverId)).once('value')).val(),
    );
    const liveByApproved = parseBinding(
      (await rtdb.ref(BINDING_BY_APPROVED(surviving.approvedKey)).once('value')).val(),
    );
    const stamp = retirementTerminalAllowsApprovedStamp({
      driverId: surviving.driverId,
      approvedKey: surviving.approvedKey,
      expectedOpId: surviving.opId,
      byDriver: liveByDriver,
      byApproved: liveByApproved,
    });
    if (!stamp.ok) {
      throw new httpsV2.HttpsError('failed-precondition', stamp.reason);
    }

    await rtdb.ref(`drivers/approved/${surviving.approvedKey}`).update({
      legacyLoginRetired: true,
    });

    await writeSecurityAudit({
      action: 'staffRetireLegacyDriverLogin',
      actorUid: caller.uid,
      driverId,
      detail: { status: 'legacy_login_retired', repaired: preview.decision.action === 'repair' },
    });
    return {
      ok: true,
      driverId,
      status: 'legacy_login_retired' as const,
      already: false,
    };
  },
);
