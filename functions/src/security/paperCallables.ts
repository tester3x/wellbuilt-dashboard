/**
 * Governed canonical paper callables. NOT DEPLOYED in this slice.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import { getWaterTicketPaper, materializeWaterTicketPaper } from '../paper/engine';
import { createFirestorePaperStore } from '../paper/firestoreStore';
import { paperAuthIntent, resolvePaperCaller } from '../paper/paperCaller';
import { resolvePaperPresentation } from '../paper/presentation';
import { parseGetPaperRequest, parseMaterializeRequest, parseMutatePaperRequest, parseWorkflowTicketRequest } from '../paper/requests';
import { applyTicketReviewAction } from '../paper/ticketReview';
import type { PaperCaller } from '../paper/types';
import { requireManageDrivers, resolveDashboardCaller } from './adminAuth';
import { writeSecurityAudit } from './audit';
import { requireSecureDriver } from './requireDriverAuth';

function throwPaper(reason: string, message: string): never {
  const code = reason === 'wrong_company' || reason === 'caller_unscoped'
    || reason === 'missing_capability' || reason === 'not_document_owner'
    || reason === 'drivers_cannot_materialize' || reason === 'unauthorized'
    || reason === 'driver_deactivated' || reason === 'not_dashboard_user'
    || reason === 'driver_unauthenticated' || reason === 'not_ticket_owner'
    ? 'permission-denied'
    : reason === 'unexpected_field' || reason === 'invalid_request' || reason === 'lookup_required'
      || reason === 'ticket_id_required' || reason === 'op_required' || reason === 'ambiguous_lookup'
      ? 'invalid-argument'
    : reason === 'unauthenticated'
      ? 'unauthenticated'
      : reason === 'document_unavailable' || reason === 'ticket_not_found' || reason === 'invoice_not_found'
        || reason === 'event_not_found'
        ? 'not-found'
        : reason === 'edit_window_expired' || reason === 'edit_window_unknown' || reason === 'policy_undefined'
          ? 'failed-precondition'
        : 'failed-precondition';
  throw new httpsV2.HttpsError(code, `${reason}:${message}`);
}

export async function loadPaperReader(request: httpsV2.CallableRequest): Promise<PaperCaller> {
  const uid = request.auth?.uid;
  const token = (request.auth?.token || null) as Record<string, unknown> | null;
  if (paperAuthIntent(token) === 'driver') {
    let driver;
    try {
      driver = await requireSecureDriver(request, { allowLegacyHash: false });
    } catch (err) {
      if (err instanceof httpsV2.HttpsError) {
        const msg = String(err.message || '');
        if (/deactivated/i.test(msg)) throwPaper('driver_deactivated', 'Driver deactivated.');
        if (err.code === 'unauthenticated') throwPaper('driver_unauthenticated', 'Driver authentication required.');
        throwPaper('unauthorized', 'Driver authentication required.');
      }
      throw err;
    }
    const resolved = resolvePaperCaller({
      uid: driver.uid,
      token: {
        kind: 'driver',
        driverId: driver.driverId,
        companyId: driver.companyId,
        roles: driver.roles,
      },
      driverProfile: { active: true, companyId: driver.companyId },
      driverProfileExists: true,
    });
    if (!resolved.ok) throwPaper(resolved.reason, resolved.message);
    return resolved.caller;
  }

  const dash = await resolveDashboardCaller(uid, token);
  return {
    kind: 'dashboard',
    uid: dash.uid,
    companyId: dash.companyId,
    isPlatformAdmin: dash.isPlatformAdmin,
    roles: dash.roles,
    caps: dash.caps,
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

export const staffGetTicketPaper = getTicketPaper;

export const getTicketPaperRoute = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const caller = await loadPaperReader(request);
    const parsed = parseGetPaperRequest(request.data);
    if (!parsed.ok) throwPaper(parsed.reason, parsed.message);
    const store = createFirestorePaperStore();
    return resolvePaperPresentation({
      store,
      caller,
      lookup: parsed.lookup,
      nowMs: Date.now(),
    });
  },
);

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

async function runReviewCallable(
  request: httpsV2.CallableRequest,
  action: 'correct' | 'hand_to_payroll' | 'finalize_to_billing' | 'reopen',
) {
  const caller = await loadPaperReader(request);
  const store = createFirestorePaperStore();
  if (action === 'correct') {
    const parsed = parseMutatePaperRequest(request.data);
    if (!parsed.ok) throwPaper(parsed.reason, parsed.message);
    const result = await applyTicketReviewAction({
      store, caller, ticketDocId: parsed.ticketDocId, action, fields: parsed.fields, nowMs: Date.now(),
    });
    if (!result.ok) throwPaper(result.reason, result.message);
    return result;
  }
  const parsed = parseWorkflowTicketRequest(request.data);
  if (!parsed.ok) throwPaper(parsed.reason, parsed.message);
  const result = await applyTicketReviewAction({
    store, caller, ticketDocId: parsed.ticketDocId, action, reason: parsed.reason, nowMs: Date.now(),
  });
  if (!result.ok) throwPaper(result.reason, result.message);
  return result;
}

export const staffCorrectTicket = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  (request) => runReviewCallable(request, 'correct'),
);
export const staffMutateTicketPaper = staffCorrectTicket;

export const staffHandReviewToPayroll = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  (request) => runReviewCallable(request, 'hand_to_payroll'),
);
export const staffHandTicketToPayroll = staffHandReviewToPayroll;

export const staffFinalizeReviewToBilling = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  (request) => runReviewCallable(request, 'finalize_to_billing'),
);
export const staffFinalizeTicketToBilling = staffFinalizeReviewToBilling;

export const staffReopenTicketReview = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  (request) => runReviewCallable(request, 'reopen'),
);
export const staffReopenTicketPaper = staffReopenTicketReview;
