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

    const parsed = validatePullEdit(request.data);
    if ('error' in parsed) {
      throw new httpsV2.HttpsError('invalid-argument', parsed.error);
    }

    // AUTHORITATIVE WELL comes from the stored pull, never the client. A caller
    // could otherwise name well A (which they may edit) while targeting pull B
    // (which they may not) — authorizing against one well while editing another.
    const origSnap = await rtdb().ref(`packets/processed/${parsed.originalPacketId}`).once('value');
    if (!origSnap.exists()) {
      throw new httpsV2.HttpsError('not-found', 'original_pull_missing');
    }
    const original = asRecord(origSnap.val());
    const authoritativeWell = typeof original.wellName === 'string' ? original.wellName.trim() : '';
    if (!authoritativeWell) {
      throw new httpsV2.HttpsError('failed-precondition', 'original_pull_has_no_well');
    }

    // The client's wellName must match the stored pull's well. A mismatch is a
    // cross-well attempt, refused.
    if (parsed.wellName !== authoritativeWell) {
      throw new httpsV2.HttpsError('permission-denied', 'well_mismatch');
    }

    // Company scope is derived from the authoritative well's config, not the
    // client. Platform admins pass; a company caller may only edit their own.
    const wellSnap = await rtdb().ref(`well_config/${authoritativeWell}`).once('value');
    const well = asRecord(wellSnap.val());
    const wellCompany = typeof well.companyId === 'string' ? well.companyId : '';
    if (!caller.isPlatformAdmin) {
      if (!caller.companyId || (wellCompany && wellCompany !== caller.companyId)) {
        throw new httpsV2.HttpsError('permission-denied', 'well_outside_company');
      }
    }

    // Build against the AUTHORITATIVE well, not the client string.
    const { packetId, packet } = buildEditPacket(
      { ...parsed, wellName: authoritativeWell }, caller.uid, Date.now(),
    );
    await rtdb().ref(`packets/incoming/${packetId}`).set(packet);

    await writeSecurityAudit({
      action: 'adminSubmitPullEdit',
      actorUid: caller.uid,
      detail: {
        packetId, wellName: authoritativeWell, originalPacketId: parsed.originalPacketId,
        wellDown: parsed.wellDown, wellCompany: wellCompany || null,
      },
    });

    return { ok: true as const, packetId };
  },
);
