/**
 * Company-scoped ticket/invoice lookup. Human ticketNumber and invoiceNumber
 * are display identifiers. Durable identity is invoiceDocId / ticketDocId.
 * Two companies may both have ticket 10000 / invoice 10000.
 */

export function trustedCompanyId(args: {
  authCompanyId?: string | null;
  staffCompanyId?: string | null;
  clientSuppliedCompanyId?: string | null;
}): string | null {
  const trusted = String(args.authCompanyId || args.staffCompanyId || '').trim();
  if (!trusted) return null;
  const client = String(args.clientSuppliedCompanyId || '').trim();
  if (client && client !== trusted) return trusted;
  return trusted;
}

export function scopeCompanyId(args: {
  authenticatedCompanyId: string | null;
  jobCompanyId?: string | null;
}): string | null {
  if (args.authenticatedCompanyId) return args.authenticatedCompanyId;
  const job = String(args.jobCompanyId || '').trim();
  return job || null;
}

export type InvoiceLookupPlan =
  | { kind: 'by_doc_id'; invoiceDocId: string; companyId: string }
  | { kind: 'by_company_and_number'; invoiceNumber: string; companyId: string }
  | { kind: 'refuse_unscoped' };

export function planInvoiceLookup(args: {
  invoiceDocId?: string | null;
  invoiceNumber?: string | null;
  companyId: string | null;
}): InvoiceLookupPlan {
  const companyId = String(args.companyId || '').trim();
  if (!companyId) return { kind: 'refuse_unscoped' };
  const docId = String(args.invoiceDocId || '').trim();
  if (docId) return { kind: 'by_doc_id', invoiceDocId: docId, companyId };
  const invoiceNumber = String(args.invoiceNumber || '').trim();
  if (invoiceNumber) return { kind: 'by_company_and_number', invoiceNumber, companyId };
  return { kind: 'refuse_unscoped' };
}

export function invoiceBelongsToCompany(
  invoice: { companyId?: string | null } | null | undefined,
  companyId: string,
): boolean {
  if (!invoice) return false;
  return String(invoice.companyId || '') === companyId;
}

export type TicketFetchPlan =
  | { kind: 'by_doc_ids'; ticketDocIds: string[]; companyId: string }
  | { kind: 'by_company_and_numbers'; ticketNumbers: string[]; companyId: string }
  | { kind: 'none' };

export function planTicketFetch(args: {
  companyId: string;
  ticketSummaries?: Array<{ docId?: string | null; ticketNumber?: string | number | null }> | null;
  ticketNumbers?: Array<string | number> | null;
}): TicketFetchPlan {
  const companyId = String(args.companyId || '').trim();
  if (!companyId) return { kind: 'none' };
  const docIds = (args.ticketSummaries || [])
    .map((s) => String(s?.docId || '').trim())
    .filter(Boolean);
  if (docIds.length > 0) return { kind: 'by_doc_ids', ticketDocIds: docIds, companyId };
  const nums = (args.ticketNumbers || [])
    .map((n) => String(n ?? '').trim())
    .filter(Boolean);
  if (nums.length > 0) return { kind: 'by_company_and_numbers', ticketNumbers: nums, companyId };
  return { kind: 'none' };
}

export function filterTicketsForCompany<T extends { companyId?: string | null; id?: string }>(
  tickets: T[],
  companyId: string,
  excludeTicketId?: string,
): T[] {
  return tickets.filter((t) => {
    if (String(t.companyId || '') !== companyId) return false;
    if (excludeTicketId && t.id === excludeTicketId) return false;
    return true;
  });
}

/**
 * Platform-admin listing may be global, but a bare human number must never
 * pick a single candidate when duplicates exist. Actions need doc id + company.
 */
export type AdminTicketActionPlan =
  | { kind: 'by_canonical'; ticketDocId: string; companyId: string }
  | { kind: 'refuse_bare_number'; matchCount: number }
  | { kind: 'refuse_unscoped' };

export function planAdminTicketAction(args: {
  ticketDocId?: string | null;
  companyId?: string | null;
  ticketNumber?: string | null;
  matchesForBareNumber?: Array<{ id: string; companyId?: string | null }>;
}): AdminTicketActionPlan {
  const ticketDocId = String(args.ticketDocId || '').trim();
  const companyId = String(args.companyId || '').trim();
  if (ticketDocId && companyId) {
    return { kind: 'by_canonical', ticketDocId, companyId };
  }
  const bare = String(args.ticketNumber || '').trim();
  if (bare) {
    const matches = args.matchesForBareNumber || [];
    return { kind: 'refuse_bare_number', matchCount: matches.length };
  }
  return { kind: 'refuse_unscoped' };
}

export function adminListPreservesDuplicateHumanNumbers<T extends { id: string; companyId?: string | null; ticketNumber?: string | number }>(
  rows: T[],
  humanNumber: string,
): T[] {
  return rows.filter((r) => String(r.ticketNumber ?? '') === humanNumber);
}
