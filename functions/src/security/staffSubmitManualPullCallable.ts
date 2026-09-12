/**
 * staffSubmitManualPull — governed dispatcher/admin MANUAL pull entry (+Add Pull).
 *
 * The browser used to write packets/incoming directly (denied by production
 * rules → the +Add Pull no-op). This authenticated callable is the governed
 * path for water moved by hot oilers / washout crews / third-party haulers /
 * anyone not on WB-M/WB-T. It reuses the existing manageDrivers guard (same as
 * staffWriteDispatch / staffWriteWellConfig), derives the company from the
 * caller (never a client override), and submits through the canonical WB-M
 * pull-input path (packets/incoming) under the Admin SDK so processIncomingPull
 * updates level/history normally. It carries NO invoice/dispatch/ticket context,
 * so no ticket/invoice/Payroll/Billing projection is produced. Idempotent by a
 * deterministic packet id.
 *
 * It does NOT modify any shared guard, rule, AFR logic, or driver identity.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireManageDrivers } from './adminAuth';
import { writeSecurityAudit } from './audit';
import {
  validateManualPull,
  buildManualPullPacket,
  assertNoCommercialProjection,
  type ManualPullInput,
} from './operational/staffManualPull';

const ALLOWED = new Set([
  'wellName', 'tankLevelFeet', 'bblsTaken', 'dateTimeUTC', 'wellDown',
  'serviceCategory', 'externalCompany', 'externalDriver', 'reason',
  'idempotencyKey', 'timezone',
]);

export const staffSubmitManualPull = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const caller = await requireManageDrivers(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );

    const raw = (request.data || {}) as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (!ALLOWED.has(key)) {
        throw new httpsV2.HttpsError('invalid-argument', `Unexpected field: ${key}`);
      }
    }

    // Company is authoritative from the caller. A platform admin with no company
    // scope cannot manual-enter a pull without impersonating a company.
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
    // Hard invariant: never a commercial projection.
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
          detail: { packetId, wellName: verdict.value.wellName, idempotent: true, serviceCategory: verdict.value.serviceCategory },
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
        serviceCategory: verdict.value.serviceCategory,
        bblsTaken: verdict.value.bblsTaken,
      },
    });

    return { ok: true as const, packetId, idempotent: false, submitted: true };
  },
);
