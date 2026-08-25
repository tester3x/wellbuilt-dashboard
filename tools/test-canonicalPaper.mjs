/**
 * Canonical paper v1 client wiring.
 * Run: node tools/test-canonicalPaper.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => readFileSync(join(root, rel), 'utf8');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

{
  const lib = src('src/lib/canonicalPaper.ts');
  check('feature flag name CANONICAL_PAPER_TICKET_ONLY_V1', lib.includes('CANONICAL_PAPER_TICKET_ONLY_V1'));
  check('feature flag defaults OFF', /export const CANONICAL_PAPER_TICKET_ONLY_V1 = false/.test(lib));
  check('Tickets lookup helper exists', lib.includes('export function ticketsPaperLookup'));
  check('Dispatch lookup helper exists', lib.includes('export function dispatchPaperLookup'));
  check('client get uses staffGetTicketPaper callable', lib.includes("httpsCallable") && lib.includes("'staffGetTicketPaper'"));
  check('client get payload is lookup only', /fn\(payload\)/.test(lib) && !/fn\(\{[\s\S]*companyId/.test(lib));
}

{
  const viewer = src('src/components/CanonicalPaperViewer.tsx');
  check('viewer has no INVOICE layout', !/INVOICE/.test(viewer) && !/PaperRow/.test(viewer) && !/JOB DETAILS/.test(viewer));
  check('viewer body is stored HTML iframe', /srcDoc/.test(viewer) && /iframe/.test(viewer));
  check('viewer chrome has print and share', /Print/.test(viewer) && /Share/.test(viewer));
}

{
  const host = src('src/components/CanonicalTicketPaperHost.tsx');
  check('host fail-closed copy is Document unavailable', host.includes('Document unavailable'));
  check('host does not fetch tickets/invoices collections', !/fetchInvoiceForTicket/.test(host) && !/collection\(db, 'tickets'\)/.test(host));
}

{
  const modal = src('src/components/TicketDetailModal.tsx');
  check('legacy Tickets renderer remains when flag OFF', modal.includes('TicketDetailModalLegacy') && modal.includes('INVOICE'));
  check('Tickets canonical path uses stored host', modal.includes('CanonicalTicketPaperHost') && modal.includes('ticketsPaperLookup'));
}

{
  const dispatch = src('src/app/dispatch/page.tsx');
  check('legacy Dispatch renderer remains when flag OFF', dispatch.includes('!isCanonicalPaperEnabled()') && dispatch.includes('INVOICE'));
  check('Dispatch canonical path uses stored host', dispatch.includes('CanonicalTicketPaperHost') && dispatch.includes('dispatchPaperLookup'));
  check('flag ON does not call loadTicketDetail', dispatch.includes('if (isCanonicalPaperEnabled())') && dispatch.includes('setTicketDetailJobId(ticketDetailJobId === job.id ? null : job.id!)'));
}

{
  const rules = src('functions/src/paper/UNDEPLOYED-RULES.md');
  check('undeployed rules deny client paper reads', rules.includes('allow read, write: if false') && rules.includes('NOT applied'));
  const liveRules = src('firestore.rules');
  check('live firestore.rules were not modified for paper', !liveRules.includes('paper_artifacts'));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
