/**
 * Governed canonical paper callables. NOT DEPLOYED in this slice.
 * Selector when approved: --only functions:staffGetTicketPaper,functions:staffMaterializeTicketPaper
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import { getWaterTicketPaper, materializeWaterTicketPaper } from '../paper/engine';
import { createFirestorePaperStore } from '../paper/firestoreStore';
import { parseGetPaperRequest, parseMaterializeRequest } from '../paper/requests';
import { requireManageDrivers } from './adminAuth';
import { writeSecurityAudit } from './audit';

function throwPaper(reason: string, message: string): never {
  const code = reason === 'wrong_company' || reason === 'caller_unscoped'
    ? 'permission-denied'
    : reason === 'unexpected_field' || reason === 'invalid_request' || reason === 'lookup_required'
      || reason === 'ticket_id_required' || reason === 'source_event_required'
      || reason === 'source_event_invalid' || reason === 'source_event_mismatch'
      || reason === 'ambiguous_lookup'
      ? 'invalid-argument'
      : reason === 'document_unavailable' || reason === 'ticket_not_found' || reason === 'invoice_not_found'
        ? 'not-found'
        : 'failed-precondition';
  throw new httpsV2.HttpsError(code, `${reason}:${message}`);
}

export const staffGetTicketPaper = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const caller = await requireManageDrivers(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );
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

export const staffMaterializeTicketPaper = httpsV2.onCall(
  { timeoutSeconds: 60, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const caller = await requireManageDrivers(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );
    const parsed = parseMaterializeRequest(request.data);
    if (!parsed.ok) throwPaper(parsed.reason, parsed.message);
    const store = createFirestorePaperStore();
    const result = await materializeWaterTicketPaper({
      store,
      caller,
      ticketDocId: parsed.ticketDocId,
      sourceEventId: parsed.sourceEventId,
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
