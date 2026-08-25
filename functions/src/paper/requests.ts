import type { PaperLookup, PaperOp } from './types';

export function parseGetPaperRequest(raw: unknown):
  | { ok: true; lookup: PaperLookup; revisionId: string }
  | { ok: false; reason: string; message: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'invalid_request', message: 'Request must be an object.' };
  }
  const rec = raw as Record<string, unknown>;
  const allowed = new Set(['ticketDocId', 'invoiceDocId', 'revisionId']);
  for (const key of Object.keys(rec)) {
    if (!allowed.has(key)) {
      return { ok: false, reason: 'unexpected_field', message: `Unexpected field: ${key}` };
    }
  }
  const ticketDocId = typeof rec.ticketDocId === 'string' ? rec.ticketDocId.trim() : '';
  const invoiceDocId = typeof rec.invoiceDocId === 'string' ? rec.invoiceDocId.trim() : '';
  const revisionId = typeof rec.revisionId === 'string' ? rec.revisionId.trim() : '';
  if (ticketDocId && invoiceDocId) {
    return { ok: false, reason: 'ambiguous_lookup', message: 'Provide ticketDocId or invoiceDocId, not both.' };
  }
  if (ticketDocId) return { ok: true, lookup: { ticketDocId }, revisionId };
  if (invoiceDocId) return { ok: true, lookup: { invoiceDocId }, revisionId };
  return { ok: false, reason: 'lookup_required', message: 'ticketDocId or invoiceDocId is required.' };
}

export function parseMaterializeRequest(raw: unknown):
  | { ok: true; ticketDocId: string; op: PaperOp }
  | { ok: false; reason: string; message: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'invalid_request', message: 'Request must be an object.' };
  }
  const rec = raw as Record<string, unknown>;
  const allowed = new Set(['ticketDocId', 'op']);
  for (const key of Object.keys(rec)) {
    if (!allowed.has(key)) {
      return { ok: false, reason: 'unexpected_field', message: `Unexpected field: ${key}` };
    }
  }
  const ticketDocId = typeof rec.ticketDocId === 'string' ? rec.ticketDocId.trim() : '';
  const op = rec.op;
  if (!ticketDocId) return { ok: false, reason: 'ticket_id_required', message: 'ticketDocId is required.' };
  if (op !== 'close' && op !== 'edit') {
    return { ok: false, reason: 'op_required', message: 'op must be close or edit.' };
  }
  return { ok: true, ticketDocId, op };
}
