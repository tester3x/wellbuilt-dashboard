/**
 * Two companies both using ticket/invoice #10000 must never cross.
 * Company-scoped, canonical-doc-id-first, fail-closed — no bare global number.
 * Run: node --experimental-strip-types tools/test-duplicateTicketNumber.mjs
 */
import {
  scopeCompanyId,
  planInvoiceLookup,
  invoiceBelongsToCompany,
  planTicketFetch,
  filterTicketsForCompany,
  planAdminTicketAction,
  adminListPreservesDuplicateHumanNumbers,
} from '../src/lib/ticketCompanyLookup.ts';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`); };

const LG = 'liquid-gold', ACME = 'acme';
// Both companies have invoice #10000 and ticket #10000 (duplicate human numbers).
const lgInvoice = { companyId: LG, invoiceNumber: '10000', invoiceDocId: 'inv_lg_1' };
const acmeInvoice = { companyId: ACME, invoiceNumber: '10000', invoiceDocId: 'inv_acme_1' };
const tickets = [
  { id: 't_lg', companyId: LG, ticketNumber: 10000 },
  { id: 't_acme', companyId: ACME, ticketNumber: 10000 },
];

// ── company from the authenticated caller, never client-picked ───────────────
check('scopeCompanyId prefers authenticated company', scopeCompanyId({ authenticatedCompanyId: LG, jobCompanyId: ACME }) === LG);
check('scopeCompanyId falls back to job company', scopeCompanyId({ authenticatedCompanyId: null, jobCompanyId: ACME }) === ACME);
check('scopeCompanyId null when neither', scopeCompanyId({ authenticatedCompanyId: null }) === null);

// ── invoice #10000: resolves within the caller's company only ────────────────
const lgPlan = planInvoiceLookup({ invoiceNumber: '10000', companyId: LG });
check('invoice #10000 → company+number scoped to caller', lgPlan.kind === 'by_company_and_number' && lgPlan.companyId === LG && lgPlan.invoiceNumber === '10000');
check("LG's invoice belongs to LG", invoiceBelongsToCompany(lgInvoice, LG));
check("ACME's #10000 invoice does NOT belong to LG (no cross)", !invoiceBelongsToCompany(acmeInvoice, LG));
check('canonical invoiceDocId takes precedence over number', planInvoiceLookup({ invoiceDocId: 'inv_lg_1', invoiceNumber: '10000', companyId: LG }).kind === 'by_doc_id');
check('no company → refuse_unscoped (no bare global invoice)', planInvoiceLookup({ invoiceNumber: '10000', companyId: null }).kind === 'refuse_unscoped');

// ── tickets: canonical docIds first, else company+numbers; never global ──────
check('ticket docIds (canonical) first', planTicketFetch({ companyId: LG, ticketSummaries: [{ docId: 't_lg' }], ticketNumbers: [10000] }).kind === 'by_doc_ids');
const tPlan = planTicketFetch({ companyId: LG, ticketNumbers: [10000] });
check('ticket #10000 fallback scoped to company', tPlan.kind === 'by_company_and_numbers' && tPlan.companyId === LG);
check('no company → ticket plan none (no bare global ticket)', planTicketFetch({ companyId: '', ticketNumbers: [10000] }).kind === 'none');
check('filterTicketsForCompany keeps only the caller company #10000', (() => {
  const kept = filterTicketsForCompany(tickets, LG);
  return kept.length === 1 && kept[0].id === 't_lg';
})());

// ── platform-admin duplicate-number safeguard ────────────────────────────────
check('admin action by canonical docId+company', planAdminTicketAction({ ticketDocId: 't_lg', companyId: LG }).kind === 'by_canonical');
const bare = planAdminTicketAction({ ticketNumber: '10000', matchesForBareNumber: [{ id: 't_lg', companyId: LG }, { id: 't_acme', companyId: ACME }] });
check('bare #10000 with duplicates → refuse_bare_number (matchCount 2)', bare.kind === 'refuse_bare_number' && bare.matchCount === 2);
check('admin action no docId/number → refuse_unscoped', planAdminTicketAction({}).kind === 'refuse_unscoped');
check('admin listing preserves BOTH companies\' #10000 (no collapse)', adminListPreservesDuplicateHumanNumbers(tickets, '10000').length === 2);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
