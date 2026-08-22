/**
 * Separate audited retirement of the legacy approved-row login.
 *
 * Preview requires a valid approved-row object and binds the complete
 * canonical row fingerprint into the digest. Apply stamps only through a
 * primed aborting transaction that re-checks that fingerprint, then rereads
 * the retired row and both exact binding sides before success.
 * update() is never used: it would create a ghost row from a missing path.
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
  evaluateRetirementApplyGate,
  evaluateRetirementPreview,
  parseBinding,
  parseIdentityProof,
  proveRetirementCommit,
  retirementTerminalAllowsApprovedStamp,
  type IdentityBinding,
} from './operational/identityBinding';
import { commitIdentityBindingWrite } from './operational/bindingApplyTransaction';
import { commitApprovedRetirementStamp } from './operational/retirementApplyTransaction';

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
      ? (await rtdb.ref(`drivers/approved/${approvedKey}`).once('value')).val()
      : null;

    const preview = evaluateRetirementPreview({
      requestedDriverId: driverId,
      byDriver: loaded.byDriver,
      byApproved: loaded.byApproved,
      byApprovedOwnedByDriver: loaded.byApprovedOwnedByDriver,
      proof,
      approvedRow,
    });

    if (mode === 'dry-run') {
      if (!preview.ok) {
        await writeSecurityAudit({
          action: 'staffRetireLegacyDriverLogin_fail',
          actorUid: caller.uid,
          driverId,
          detail: { reason: preview.reason },
        });
        throw new httpsV2.HttpsError('failed-precondition', preview.reason);
      }
      return {
        ok: true,
        mode: 'dry-run' as const,
        driverId,
        previewDigest: preview.digest,
        action: preview.decision.action,
      };
    }

    const expected = typeof raw.expectedPreviewDigest === 'string' ? raw.expectedPreviewDigest : '';
    const gate = evaluateRetirementApplyGate({
      preview,
      expectedPreviewDigest: expected,
    });
    if (!gate.ok) {
      await writeSecurityAudit({
        action: 'staffRetireLegacyDriverLogin_fail',
        actorUid: caller.uid,
        driverId,
        detail: { reason: gate.reason },
      });
      throw new httpsV2.HttpsError('failed-precondition', gate.reason);
    }

    if (gate.decision.action === 'already_retired') {
      return { ok: true, driverId, status: 'legacy_login_retired' as const, already: true };
    }

    const surviving = gate.decision.surviving;
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

    const stamped = await commitApprovedRetirementStamp({
      approvedRef: rtdb.ref(`drivers/approved/${surviving.approvedKey}`) as never,
      expectedRowFingerprint: gate.approvedRowFingerprint,
    });
    if (!stamped.ok) {
      throw new httpsV2.HttpsError('failed-precondition', stamped.reason);
    }

    const provedRow = (await rtdb.ref(`drivers/approved/${surviving.approvedKey}`).once('value')).val();
    const provedByDriver = parseBinding(
      (await rtdb.ref(BINDING_BY_DRIVER(surviving.driverId)).once('value')).val(),
    );
    const provedByApproved = parseBinding(
      (await rtdb.ref(BINDING_BY_APPROVED(surviving.approvedKey)).once('value')).val(),
    );
    const proved = proveRetirementCommit({
      approvedRow: provedRow,
      byDriver: provedByDriver,
      byApproved: provedByApproved,
      expectedDriverId: surviving.driverId,
      expectedApprovedKey: surviving.approvedKey,
      expectedOpId: surviving.opId,
    });
    if (!proved.ok) {
      throw new httpsV2.HttpsError('failed-precondition', proved.reason);
    }

    await writeSecurityAudit({
      action: 'staffRetireLegacyDriverLogin',
      actorUid: caller.uid,
      driverId,
      detail: { status: 'legacy_login_retired', repaired: gate.decision.action === 'repair' },
    });
    return {
      ok: true,
      driverId,
      status: 'legacy_login_retired' as const,
      already: false,
    };
  },
);
