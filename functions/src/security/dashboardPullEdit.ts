/**
 * adminSubmitPullEdit — authenticated Dashboard pull edit.
 *
 * The browser used to write the edit packet straight to packets/incoming, which
 * production rules (correctly) refuse. This callable is the authenticated server
 * path: a Dashboard user with manageDrivers validates and submits the edit; the
 * server writes packets/incoming under admin, and the existing processIncomingPull
 * / edit handler applies it exactly as before. Rules stay closed.
 *
 * It only writes an edit packet — same shape the browser produced. No rule change,
 * no direct profile/well mutation, no new authority.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireManageDrivers } from './adminAuth';
import { writeSecurityAudit } from './audit';
import { checkMutationAdmission, MAINTENANCE_ERROR_CODE } from './operational/mutationAdmission';

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const rtdb = () => admin.database();

/** Reviewed edit-packet shape, validated from client input. */
export interface PullEditInput {
  originalPacketId: string;
  wellName: string;
  tankTopInches: number;
  bblsTaken: number;
  wellDown: boolean;
  newDateTimeUTC?: string;
}

export function validatePullEdit(raw: unknown): PullEditInput | { error: string } {
  const d = asRecord(raw);
  const originalPacketId = typeof d.originalPacketId === 'string' ? d.originalPacketId.trim() : '';
  const wellName = typeof d.wellName === 'string' ? d.wellName.trim() : '';
  if (!originalPacketId) return { error: 'originalPacketId_required' };
  if (!wellName || wellName.length > 120) return { error: 'wellName_invalid' };
  // A slash/control char would escape the RTDB path in the id we build.
  if (/[/.#$[\]]/.test(originalPacketId)) return { error: 'originalPacketId_malformed' };

  const tankTopInches = typeof d.tankTopInches === 'number' ? d.tankTopInches : NaN;
  const bblsTaken = typeof d.bblsTaken === 'number' ? d.bblsTaken : NaN;
  if (!Number.isFinite(tankTopInches) || tankTopInches < 0) return { error: 'tankTopInches_invalid' };
  if (!Number.isFinite(bblsTaken) || bblsTaken < 0) return { error: 'bblsTaken_invalid' };

  const wellDown = d.wellDown === true;
  let newDateTimeUTC: string | undefined;
  if (d.newDateTimeUTC !== undefined && d.newDateTimeUTC !== null) {
    if (typeof d.newDateTimeUTC !== 'string' || Number.isNaN(Date.parse(d.newDateTimeUTC))) {
      return { error: 'newDateTimeUTC_invalid' };
    }
    newDateTimeUTC = d.newDateTimeUTC;
  }
  return { originalPacketId, wellName, tankTopInches, bblsTaken, wellDown, newDateTimeUTC };
}

/** Build the exact edit packet the browser used to write. */
export function buildEditPacket(input: PullEditInput, actorUid: string, nowMs: number): {
  packetId: string;
  packet: Record<string, unknown>;
} {
  const cleanWellName = input.wellName.replace(/\s/g, '');
  const packetId = `edit_${nowMs}_${cleanWellName}`;
  const packet: Record<string, unknown> = {
    requestType: 'edit',
    originalPacketId: input.originalPacketId,
    wellName: input.wellName,
    tankTopInches: input.tankTopInches,
    bblsTaken: input.bblsTaken,
    timestamp: new Date(nowMs).toISOString(),
    source: 'dashboard',
    wellDown: input.wellDown,
    // A dashboard edit is an authoritative statement about wellDown (5/8/2026).
    wellDownIsAuthoritative: true,
    editedByUid: actorUid,
  };
  if (input.newDateTimeUTC) {
    packet.dateTimeUTC = input.newDateTimeUTC;
    packet.dateTime = new Date(input.newDateTimeUTC).toLocaleString();
  }
  return { packetId, packet };
}

export const adminSubmitPullEdit = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const caller = await requireManageDrivers(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );

    // Blocker-3: staged-rollout admission gate. Checked AFTER authorization
    // (so an auth failure stays an auth failure, never a maintenance error)
    // and BEFORE writing packets/incoming. Retryable code when paused; the
    // Dashboard caller must surface a maintenance response, never "succeeded".
    const admission = await checkMutationAdmission();
    if (!admission.admitted) {
      throw new httpsV2.HttpsError(MAINTENANCE_ERROR_CODE, admission.reason);
    }

    const parsed = validatePullEdit(request.data);
    if ('error' in parsed) {
      throw new httpsV2.HttpsError('invalid-argument', parsed.error);
    }

    // Company scope: a non-platform caller may only edit a well in their company.
    if (!caller.isPlatformAdmin) {
      const wellSnap = await rtdb().ref(`well_config/${parsed.wellName}`).once('value');
      const well = asRecord(wellSnap.val());
      const wellCompany = typeof well.companyId === 'string' ? well.companyId : '';
      if (!caller.companyId || (wellCompany && wellCompany !== caller.companyId)) {
        throw new httpsV2.HttpsError('permission-denied', 'well_outside_company');
      }
    }

    const { packetId, packet } = buildEditPacket(parsed, caller.uid, Date.now());
    await rtdb().ref(`packets/incoming/${packetId}`).set(packet);

    await writeSecurityAudit({
      action: 'adminSubmitPullEdit',
      actorUid: caller.uid,
      detail: {
        packetId, wellName: parsed.wellName, originalPacketId: parsed.originalPacketId,
        wellDown: parsed.wellDown,
      },
    });

    return { ok: true as const, packetId };
  },
);
