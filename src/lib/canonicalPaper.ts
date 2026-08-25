/**
 * Canonical paper v1 — ticket-only Water Tickets.
 * Feature flag DEFAULTS OFF. When ON, Tickets and Dispatch fail closed
 * to stored HTML and never rebuild paper from live fields.
 */
import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';

export const CANONICAL_PAPER_TICKET_ONLY_V1 = false;

export type PaperLookup =
  | { ticketDocId: string }
  | { invoiceDocId: string };

export type CanonicalPaperView = {
  ok: true;
  artifactId: string;
  artifactType: 'water_ticket';
  revisionId: string;
  displayNumber: string;
  companyId: string;
  contentHash: string;
  html: string;
};

export function isCanonicalPaperEnabled(): boolean {
  return CANONICAL_PAPER_TICKET_ONLY_V1 === true;
}

export function ticketsPaperLookup(ticketDocId: string): PaperLookup {
  return { ticketDocId };
}

export function dispatchPaperLookup(job: {
  ticketDocId?: string;
  invoiceDocId?: string;
}): PaperLookup | null {
  if (job.ticketDocId) return { ticketDocId: job.ticketDocId };
  if (job.invoiceDocId) return { invoiceDocId: job.invoiceDocId };
  return null;
}

export function isDocumentUnavailable(err: unknown): boolean {
  const msg = err && typeof err === 'object' && 'message' in err ? String((err as { message: unknown }).message) : String(err || '');
  return msg.includes('document_unavailable') || msg.includes('Document unavailable') || msg.includes('not-found');
}

export async function staffGetTicketPaper(lookup: PaperLookup, revisionId?: string): Promise<CanonicalPaperView> {
  const fn = httpsCallable(getFirebaseFunctions(), 'staffGetTicketPaper');
  const payload = revisionId ? { ...lookup, revisionId } : lookup;
  const res = await fn(payload);
  return res.data as CanonicalPaperView;
}

export type PaperPresentationMode = 'edit_form' | 'canonical_paper' | 'read_only_detail';

export type TicketPaperRoute = {
  ok: true;
  mode: PaperPresentationMode;
  canEdit: boolean;
  reason: string;
  evaluatedAtMs: number;
  policyVersion: string;
  previewAvailable: boolean;
  allowedFields?: string[];
  artifactId?: string;
  revisionId?: string;
} | {
  ok: false;
  reason: string;
  message: string;
  canEdit: false;
  evaluatedAtMs: number;
  policyVersion: string;
  gap?: string;
};

export async function getTicketPaperRoute(lookup: PaperLookup): Promise<TicketPaperRoute> {
  const fn = httpsCallable(getFirebaseFunctions(), 'getTicketPaperRoute');
  const res = await fn(lookup);
  return res.data as TicketPaperRoute;
}

export async function staffCorrectTicket(ticketDocId: string, fields: Record<string, unknown>): Promise<{ ok: true }> {
  const fn = httpsCallable(getFirebaseFunctions(), 'staffCorrectTicket');
  const res = await fn({ ticketDocId, fields });
  return res.data as { ok: true };
}
export const staffMutateTicketPaper = staffCorrectTicket;
