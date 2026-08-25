/**
 * Governed canonical paper callables. NOT DEPLOYED in this slice.
 * Selector when approved:
 *   --only functions:getTicketPaper,functions:staffGetTicketPaper,functions:staffMaterializeTicketPaper
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import { getWaterTicketPaper, materializeWaterTicketPaper } from '../paper/engine';
import { createFirestorePaperStore } from '../paper/firestoreStore';
import { parseGetPaperRequest, parseMaterializeRequest } from '../paper/requests';
import type { PaperCaller } from '../paper/types';
import { requireManageDrivers, requireRegisteredDashboardUser } from './adminAuth';
import { writeSecurityAudit } from './audit';
import { requireSecureDriver } from './requireDriverAuth';

function throwPaper(reason: string, message: string): never {
  const code = reason === 'wrong_company' || reason === 'caller_unscoped'
    || reason === 'missing_capability' || reason === 'not_document_owner'
    || reason === 'drivers_cannot_materialize' || reason === 'unauthorized'
    ? 'permission-denied'
    : reason === 'unexpected_field' || reason === 'invalid_request' || reason === 'lookup_required'
      || reason === 'ticket_id_required' || reason === 'op_required' || reason === 'ambiguous_lookup'
      ? 'invalid-argument'
      : reason === 'document_unavailable' || reason === 'ticket_not_found' || reason === 'invoice_not_found'
        || reason === 'event_not_found'
        ? 'not-found'
        : 'failed-precondition';
  throw new httpsV2.HttpsError(code, `${reason}:${message}`);
}

async function loadPaperReader(request: httpsV2.CallableRequest): Promise<PaperCaller> {
  try {
    const dash = await requireRegisteredDashboardUser(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );
    return {
      kind: 'dashboard',
      uid: dash.uid,
      companyId: dash.companyId,
      isPlatformAdmin: dash.isPlatformAdmin,
      roles: dash.roles,
      caps: dash.caps,
    };
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
    if (code && !code.includes('unauthenticated') && !code.includes('permission-denied')) throw err;
  }
  const driver = await requireSecureDriver(request);
  return {
    kind: 'driver',
    uid: driver.uid,
    companyId: driver.companyId,
    isPlatformAdmin: false,
    driverId: driver.driverId,
    roles: driver.roles,
    caps: [],
  };
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

/** Dashboard alias for the shared read callable. */
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
