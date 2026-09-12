/**
 * staffSubmitManualPull — governed Dashboard Dispatch MANUAL pull (+Add Pull).
 *
 * Authorized by DISPATCH-WRITE security: the caller must hold the canonical
 * `createDispatch` capability (dispatch managers + admins; dispatch VIEWERS are
 * denied). Reuses the existing exported requireRegisteredDashboardUser loader +
 * the existing capability model — it does NOT add or modify shared claims/guard
 * architecture.
 *
 * Records water moved by hot oilers / washout crews / third-party haulers /
 * non-WB-M/WB-T people. Company is derived from the caller (never a client
 * override). Submits through the canonical WB-M pull-input path (packets/incoming)
 * under the Admin SDK so processIncomingPull updates level/history. Carries no
 * invoice/dispatch/ticket invoicing context ⇒ no ticket/invoice/Payroll/Billing.
 * The authenticated dispatcher is audited separately (dispatchActorUid); the
 * entry is never a real driver. Idempotent by a deterministic packet id.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireRegisteredDashboardUser } from './adminAuth';
import { writeSecurityAudit } from './audit';
import {
  validateManualPull,
  buildManualPullPacket,
  assertNoCommercialProjection,
  type ManualPullInput,
} from './operational/staffManualPull';

/** The canonical dispatch-write capability that gates this control. */
const DISPATCH_WRITE_CAPABILITY = 'createDispatch';

const ALLOWED = new Set([
  'wellName', 'tankLevelFeet', 'bblsTaken', 'dateTimeUTC', 'wellDown',
  'serviceCategory', 'externalCompany', 'externalDriver', 'reason',
  'idempotencyKey', 'timezone', 'linkedDispatchId',
]);

export const staffSubmitManualPull = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    // Dispatch-write authorization: any registered user WITH createDispatch
    // (dispatch managers + admins). Dispatch viewers (viewDispatch only) are denied.
    const caller = await requireRegisteredDashboardUser(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );
    if (!caller.caps.includes(DISPATCH_WRITE_CAPABILITY)) {
      throw new httpsV2.HttpsError('permission-denied', 'createDispatch_required:You need dispatch-management permission to add a pull.');
    }

    const raw = (request.data || {}) as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (!ALLOWED.has(key)) {
        throw new httpsV2.HttpsError('invalid-argument', `Unexpected field: ${key}`);
      }
    }

    // Company is authoritative from the caller.
    if (!caller.companyId) {
      throw new httpsV2.HttpsError('failed-precondition', 'company_required:No company is bound to your account.');
    }

    const verdict = validateManualPull(raw as ManualPullInput, {
      actorUid: caller.uid,
      companyId: caller.companyId,
      nowMs: Date.now(),
    });
    if (!verdict.ok) {
      throw new httpsV2.HttpsError('invalid-argument', `${verdict.reason}:${verdict.message}`);
    }

    const { packetId, packet } = buildManualPullPacket(verdict.value, {
      actorUid: caller.uid,
      companyId: caller.companyId,
      nowMs: Date.now(),
    });
    // Hard invariants: never a commercial projection, never a driver-shaped actor.
    assertNoCommercialProjection(packet);

    const rtdb = admin.database();
    // Idempotency: if this exact manual pull already landed anywhere in the
    // pipeline, do not re-submit (deterministic packetId = same logical pull).
    for (const path of [`packets/processed/${packetId}`, `packets/incoming/${packetId}`, `packets/rejected/${packetId}`]) {
      const snap = await rtdb.ref(path).once('value');
      if (snap.exists()) {
        await writeSecurityAudit({
          action: 'staffSubmitManualPull',
          actorUid: caller.uid,
          detail: { packetId, wellName: verdict.value.wellName, idempotent: true, dispatchActorUid: caller.uid, serviceCategory: verdict.value.serviceCategory },
        });
        return { ok: true as const, packetId, idempotent: true, submitted: false };
      }
    }

    await rtdb.ref(`packets/incoming/${packetId}`).set(packet);

    await writeSecurityAudit({
      action: 'staffSubmitManualPull',
      actorUid: caller.uid,
      detail: {
        packetId,
        wellName: verdict.value.wellName,
        companyId: caller.companyId,
        dispatchActorUid: caller.uid, // authenticated dispatcher (audited separately from any external driver)
        externalDriver: verdict.value.externalDriver || undefined,
        externalCompany: verdict.value.externalCompany || undefined,
        linkedDispatchId: verdict.value.linkedDispatchId || undefined,
        serviceCategory: verdict.value.serviceCategory,
        bblsTaken: verdict.value.bblsTaken,
      },
    });

    return { ok: true as const, packetId, idempotent: false, submitted: true };
  },
);
