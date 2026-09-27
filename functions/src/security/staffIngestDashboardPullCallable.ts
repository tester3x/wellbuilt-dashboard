import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import {
  requireTrustedCompanyCapability,
  TRUSTED_CAPABILITY_MANAGE_DRIVERS,
} from './trustedStaffAuthority';
import { staffWriteDispatchAccessFromTrusted } from './operational/staffWriteDispatch';
import { writeSecurityAudit } from './audit';
import {
  evaluateStaffIngestPull,
  parseStaffIngestPull,
} from './operational/staffIngestDashboardPull';

function throwFail(result: { ok: false; reason: string; field?: string }): never {
  const msg = result.field ? `${result.reason}:${result.field}` : result.reason;
  if (result.reason === 'unauthenticated') {
    throw new httpsV2.HttpsError('unauthenticated', msg);
  }
  if (
    result.reason === 'missing_company'
    || result.reason === 'missing_required_capability'
    || result.reason === 'no_trusted_authority_record'
    || result.reason === 'caller_authority_field'
    || result.reason === 'well_unauthorized'
    || result.reason === 'well_scope_unavailable'
  ) {
    throw new httpsV2.HttpsError('permission-denied', msg);
  }
  throw new httpsV2.HttpsError('invalid-argument', msg);
}

export const staffIngestDashboardPull = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const trusted = await requireTrustedCompanyCapability(
      request.auth?.uid,
      TRUSTED_CAPABILITY_MANAGE_DRIVERS,
    );
    const access = staffWriteDispatchAccessFromTrusted(trusted);
    if (!access.ok) throwFail(access);
    const parsed = parseStaffIngestPull(request.data);
    if (!parsed.ok) throwFail(parsed);
    const catalogSnap = await admin.database().ref('well_config').once('value');
    const decided = evaluateStaffIngestPull({
      request: parsed,
      catalog: catalogSnap.exists() ? catalogSnap.val() : {},
      actingCompanyId: access.companyId,
    });
    if (!decided.ok) throwFail(decided);
    const ref = admin.database().ref(`packets/incoming/${decided.packetId}`);
    const existing = await ref.once('value');
    if (existing.exists()) {
      return { ok: true as const, packetId: decided.packetId, duplicate: true };
    }
    await ref.set({
      packetId: decided.packetId,
      wellName: parsed.wellName,
      tankLevelFeet: parsed.tankLevelFeet,
      bblsTaken: parsed.bblsTaken,
      dateTime: new Date(parsed.dateTimeUTC).toLocaleString(),
      dateTimeUTC: parsed.dateTimeUTC,
      driverName: access.uid,
      driverId: access.uid,
      requestType: 'pull',
      timezone: parsed.timezone,
      wellDown: parsed.wellDown,
      wellDownIsAuthoritative: true,
      ingestedAt: Date.now(),
      ingestedBy: access.uid,
      companyId: access.companyId,
    });
    await writeSecurityAudit({
      action: 'staffIngestDashboardPull',
      actorUid: access.uid,
      detail: { packetId: decided.packetId, companyId: access.companyId },
    });
    return { ok: true as const, packetId: decided.packetId, duplicate: false };
  },
);
