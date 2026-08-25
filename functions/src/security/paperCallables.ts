/**
 * Governed canonical paper callables. NOT DEPLOYED in this slice.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { getWaterTicketPaper, materializeWaterTicketPaper } from '../paper/engine';
import { createFirestorePaperStore } from '../paper/firestoreStore';
import { resolvePaperCaller } from '../paper/paperCaller';
import { parseGetPaperRequest, parseMaterializeRequest } from '../paper/requests';
import type { PaperCaller } from '../paper/types';
import { requireManageDrivers } from './adminAuth';
import { writeSecurityAudit } from './audit';

function throwPaper(reason: string, message: string): never {
  const code = reason === 'wrong_company' || reason === 'caller_unscoped'
    || reason === 'missing_capability' || reason === 'not_document_owner'
    || reason === 'drivers_cannot_materialize' || reason === 'unauthorized'
    || reason === 'driver_deactivated' || reason === 'not_dashboard_user'
    || reason === 'driver_unauthenticated'
    ? 'permission-denied'
    : reason === 'unexpected_field' || reason === 'invalid_request' || reason === 'lookup_required'
      || reason === 'ticket_id_required' || reason === 'op_required' || reason === 'ambiguous_lookup'
      ? 'invalid-argument'
    : reason === 'unauthenticated'
      ? 'unauthenticated'
      : reason === 'document_unavailable' || reason === 'ticket_not_found' || reason === 'invoice_not_found'
        || reason === 'event_not_found'
        ? 'not-found'
        : 'failed-precondition';
  throw new httpsV2.HttpsError(code, `${reason}:${message}`);
}

export async function loadPaperReader(request: httpsV2.CallableRequest): Promise<PaperCaller> {
  const uid = request.auth?.uid;
  const token = (request.auth?.token || null) as Record<string, unknown> | null;
  if (token?.kind === 'driver') {
    const driverId = typeof token.driverId === 'string' ? token.driverId : '';
    let profile: { active?: boolean; companyId?: string } | null = null;
    let exists = false;
    if (driverId) {
      const snap = await admin.database().ref(`drivers/profiles/${driverId}`).once('value');
      exists = snap.exists();
      profile = exists ? snap.val() as { active?: boolean; companyId?: string } : null;
    }
    const resolved = resolvePaperCaller({ uid, token, driverProfile: profile, driverProfileExists: exists });
    if (!resolved.ok) throwPaper(resolved.reason, resolved.message);
    return resolved.caller;
  }

  const userSnap = uid ? await admin.database().ref(`users/${uid}`).once('value') : null;
  const rtdbUser = userSnap && userSnap.exists() ? userSnap.val() as Record<string, unknown> : null;
  const resolved = resolvePaperCaller({ uid, token, rtdbUser });
  if (!resolved.ok) throwPaper(resolved.reason, resolved.message);
  return resolved.caller;
}

export const getTicketPaper = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const caller = await loadPaperReader(request);
    const parsed = parseGetPaperRequest(request.data);
    if (!parsed.ok) throwPaper(parsed.reason, parsed.message);
    const store = createFirestorePaperStore();
    const result = await getWaterTicketPaper({
      store,
      caller,
      lookup: parsed.lookup,
      revisionId: parsed.revisionId || undefined,
    });
    if (!result.ok) throwPaper(result.reason, result.message);
    return result;
  },
);

export const staffGetTicketPaper = getTicketPaper;

export const staffMaterializeTicketPaper = httpsV2.onCall(
  { timeoutSeconds: 60, memory: '512MiB', enforceAppCheck: false },
  async (request) => {
    const dash = await requireManageDrivers(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );
    const caller: PaperCaller = {
      kind: 'dashboard',
      uid: dash.uid,
      companyId: dash.companyId,
      isPlatformAdmin: dash.isPlatformAdmin,
      roles: dash.roles,
      caps: dash.caps,
    };
    const parsed = parseMaterializeRequest(request.data);
    if (!parsed.ok) throwPaper(parsed.reason, parsed.message);
    const store = createFirestorePaperStore();
    const result = await materializeWaterTicketPaper({
      store,
      caller,
      ticketDocId: parsed.ticketDocId,
      op: parsed.op,
      nowMs: Date.now(),
    });
    if (!result.ok) throwPaper(result.reason, result.message);
    await writeSecurityAudit({
      action: 'staffMaterializeTicketPaper',
      actorUid: caller.uid,
      detail: {
        artifactId: result.artifact.artifactId,
        revisionId: result.revision.revisionId,
        contentHash: result.revision.contentHash,
        idempotent: result.action === 'idempotent',
      },
    });
    return {
      ok: true as const,
      action: result.action,
      artifactId: result.artifact.artifactId,
      artifactType: result.revision.artifactType,
      revisionId: result.revision.revisionId,
      displayNumber: result.revision.displayNumber,
      companyId: result.revision.companyId,
      contentHash: result.revision.contentHash,
      storageHtmlPath: result.revision.storageHtmlPath,
    };
  },
);
