import type { PaperLookup, PaperOp } from './types';
import { MAX_REVIEW_BATCH } from './ticketReview';

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

function parseExpectedVersion(raw: unknown):
  | { ok: true; expectedVersion: number }
  | { ok: false; reason: string; message: string } {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || !Number.isFinite(raw)) {
    return { ok: false, reason: 'expected_version_required', message: 'expectedVersion is required.' };
  }
  return { ok: true, expectedVersion: raw };
}

export function parseMutatePaperRequest(raw: unknown):
  | { ok: true; ticketDocId: string; fields: Record<string, unknown>; expectedVersion: number }
  | { ok: false; reason: string; message: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'invalid_request', message: 'Request must be an object.' };
  }
  const rec = raw as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (key !== 'ticketDocId' && key !== 'fields' && key !== 'expectedVersion') {
      return { ok: false, reason: 'unexpected_field', message: `Unexpected field: ${key}` };
    }
  }
  const ticketDocId = typeof rec.ticketDocId === 'string' ? rec.ticketDocId.trim() : '';
  if (!ticketDocId) return { ok: false, reason: 'ticket_id_required', message: 'ticketDocId is required.' };
  if (!rec.fields || typeof rec.fields !== 'object' || Array.isArray(rec.fields)) {
    return { ok: false, reason: 'invalid_request', message: 'fields must be an object.' };
  }
  const version = parseExpectedVersion(rec.expectedVersion);
  if (!version.ok) return version;
  return { ok: true, ticketDocId, fields: rec.fields as Record<string, unknown>, expectedVersion: version.expectedVersion };
}

export function parseWorkflowTicketRequest(raw: unknown):
  | { ok: true; ticketDocId: string; reason: string; expectedVersion: number }
  | { ok: false; reason: string; message: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'invalid_request', message: 'Request must be an object.' };
  }
  const rec = raw as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (key !== 'ticketDocId' && key !== 'reason' && key !== 'expectedVersion') {
      return { ok: false, reason: 'unexpected_field', message: `Unexpected field: ${key}` };
    }
  }
  const ticketDocId = typeof rec.ticketDocId === 'string' ? rec.ticketDocId.trim() : '';
  if (!ticketDocId) return { ok: false, reason: 'ticket_id_required', message: 'ticketDocId is required.' };
  const reason = typeof rec.reason === 'string' ? rec.reason.trim() : '';
  const version = parseExpectedVersion(rec.expectedVersion);
  if (!version.ok) return version;
  return { ok: true, ticketDocId, reason, expectedVersion: version.expectedVersion };
}

export function parseReviewBatchRequest(raw: unknown):
  | { ok: true; items: Array<{ ticketDocId: string; expectedVersion: number }> }
  | { ok: false; reason: string; message: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'invalid_request', message: 'Request must be an object.' };
  }
  const rec = raw as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (key !== 'tickets') {
      return { ok: false, reason: 'unexpected_field', message: `Unexpected field: ${key}` };
    }
  }
  if (!Array.isArray(rec.tickets) || rec.tickets.length < 1) {
    return { ok: false, reason: 'invalid_request', message: 'tickets must be a non-empty list.' };
  }
  if (rec.tickets.length > MAX_REVIEW_BATCH) {
    return { ok: false, reason: 'invalid_request', message: 'tickets exceeds the bounded batch size.' };
  }
  const items: Array<{ ticketDocId: string; expectedVersion: number }> = [];
  for (const row of rec.tickets) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return { ok: false, reason: 'invalid_request', message: 'Each ticket entry must be an object.' };
    }
    const entry = row as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (key !== 'ticketDocId' && key !== 'expectedVersion') {
        return { ok: false, reason: 'unexpected_field', message: `Unexpected field: ${key}` };
      }
    }
    const ticketDocId = typeof entry.ticketDocId === 'string' ? entry.ticketDocId.trim() : '';
    if (!ticketDocId) return { ok: false, reason: 'ticket_id_required', message: 'ticketDocId is required.' };
    const version = parseExpectedVersion(entry.expectedVersion);
    if (!version.ok) return version;
    items.push({ ticketDocId, expectedVersion: version.expectedVersion });
  }
  return { ok: true, items };
}
