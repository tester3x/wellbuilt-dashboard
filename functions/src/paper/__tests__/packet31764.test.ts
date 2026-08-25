import { readFileSync } from 'fs';
import { join } from 'path';
import { evaluatePaperPresentation, paperBytesAllowed } from '../actorPolicy';
import { getWaterTicketPaper, materializeWaterTicketPaper } from '../engine';
import { applyInvoicePaperLifecycle, applyTicketPaperLifecycle } from '../lifecycle';
import { parseMutatePaperRequest, parseReviewBatchRequest, parseWorkflowTicketRequest } from '../requests';
import { changedPaperMutationId, deriveGovernedSourceEvent } from '../sourceEvent';
import { MemoryPaperStore } from '../store';
import { applyTicketReviewAction } from '../ticketReview';
import { waterTicketArtifactId } from '../types';
import { seedDispatchReviewWorkflow } from '../workflow';
import {
  CLOSED_AT_MS,
  COMPANY_LG,
  DRIVER_ZFOLD,
  INVOICE_20100_ID,
  JSA_BYTES,
  PIXEL_A,
  PIXEL_B,
  TICKET_20100_ID,
  dispatchLg,
  invoice20100,
  payrollLg,
  staffLg,
  ticket20100,
} from './fixture20100';

const dispatchCap = { ...dispatchLg, caps: ['createDispatch', 'viewDispatch'] };
const payrollCap = { ...payrollLg, caps: ['approvePayroll', 'viewPayroll'] };
const billingCap = {
  kind: 'dashboard' as const,
  uid: 'billing-lg',
  companyId: COMPANY_LG,
  isPlatformAdmin: false,
  roles: ['billing'],
  caps: ['editBilling', 'viewBilling'],
};

function seed(store = new MemoryPaperStore()) {
  store.tickets.set(TICKET_20100_ID, { ...ticket20100 });
  store.invoices.set(INVOICE_20100_ID, {
    ...invoice20100,
    timeline: [...(invoice20100.timeline as object[])],
    photos: [...(invoice20100.photos as object[])],
  });
  store.identities.set(DRIVER_ZFOLD, {
    driverId: DRIVER_ZFOLD,
    legalName: 'Mike ZFold7 Burger',
    displayName: 'Mikezfold',
  });
  store.liveAssets.set('https://storage.example/a.jpg', PIXEL_A);
  store.liveAssets.set('https://storage.example/b.jpg', PIXEL_B);
  store.liveAssets.set('https://storage.example/jsa.pdf', JSA_BYTES);
  return store;
}

describe('stale paperMutationId is not correction provenance', () => {
  it('changedPaperMutationId only fires when the value actually changes', () => {
    expect(changedPaperMutationId({ paperMutationId: 'A' }, { paperMutationId: 'A', updatedAt: 9 })).toBe('');
    expect(changedPaperMutationId({ paperMutationId: 'A' }, { paperMutationId: 'B' })).toBe('B');
    expect(changedPaperMutationId({}, { paperMutationId: 'A' })).toBe('A');
    expect(changedPaperMutationId({ paperMutationId: 'A' }, { })).toBe('');
  });

  it('deriveGovernedSourceEvent ignores a stored mutation id unless correctionMutationId is supplied', () => {
    const stale = deriveGovernedSourceEvent({
      ticket: { ...ticket20100, paperMutationId: 'old-A', updatedAt: { toMillis: () => CLOSED_AT_MS + 9 } },
      invoice: invoice20100,
      op: 'edit',
      editSource: 'ticket',
    });
    expect(stale.ok && stale.sourceEventId).toBe(`ticket_edit:${TICKET_20100_ID}:${CLOSED_AT_MS + 9}`);
    const correction = deriveGovernedSourceEvent({
      ticket: { ...ticket20100, paperMutationId: 'old-A', updatedAt: { toMillis: () => CLOSED_AT_MS + 9 } },
      invoice: { ...invoice20100, paperMutationId: 'old-A' },
      op: 'edit',
      correctionMutationId: 'new-B',
    });
    expect(correction.ok && correction.sourceEventId).toBe('correction:new-B');
  });
});

describe('one correction / one revision and later ordinary edits', () => {
  it('close r1, mutation A r2, later ticket edit r3, later invoice edit r4', async () => {
    const store = seed();
    const close = await applyInvoicePaperLifecycle({
      store,
      invoiceId: INVOICE_20100_ID,
      before: { status: 'open' },
      after: { ...invoice20100, status: 'closed', closedAtMs: CLOSED_AT_MS } as Record<string, unknown>,
      nowMs: CLOSED_AT_MS,
    });
    expect(close.class).toBe('success');
    const r1 = await getWaterTicketPaper({
      store, caller: dispatchLg, lookup: { ticketDocId: TICKET_20100_ID }, nowMs: CLOSED_AT_MS,
    });
    expect(r1.ok && r1.revisionId).toBe('r1');
    if (!r1.ok) return;
    const r1Hash = r1.contentHash;

    const review = await store.getWorkflow(TICKET_20100_ID);
    const corrected = await applyTicketReviewAction({
      store,
      caller: dispatchCap,
      ticketDocId: TICKET_20100_ID,
      action: 'correct',
      fields: { truck: '888' },
      nowMs: CLOSED_AT_MS + 10,
      expectedVersion: review?.version ?? 1,
    });
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) return;
    const mutationA = corrected.mutationId;
    const ticketAfterA = await store.getTicket(TICKET_20100_ID);
    const invoiceAfterA = await store.getInvoice(INVOICE_20100_ID);
    const [tCorr, iCorr] = await Promise.all([
      applyTicketPaperLifecycle({
        store,
        ticketId: TICKET_20100_ID,
        before: { ...ticket20100 } as Record<string, unknown>,
        after: { ...(ticketAfterA as object) } as Record<string, unknown>,
        nowMs: CLOSED_AT_MS + 11,
      }),
      applyInvoicePaperLifecycle({
        store,
        invoiceId: INVOICE_20100_ID,
        before: { ...invoice20100, status: 'closed' } as Record<string, unknown>,
        after: { ...(invoiceAfterA as object) } as Record<string, unknown>,
        nowMs: CLOSED_AT_MS + 11,
      }),
    ]);
    expect(tCorr.class === 'success' || iCorr.class === 'success').toBe(true);
    expect(await store.getRevision(waterTicketArtifactId(TICKET_20100_ID), 'r2')).toBeTruthy();
    expect(await store.getRevision(waterTicketArtifactId(TICKET_20100_ID), 'r3')).toBeNull();
    const r2 = await getWaterTicketPaper({
      store, caller: dispatchLg, lookup: { ticketDocId: TICKET_20100_ID }, nowMs: CLOSED_AT_MS + 11,
    });
    expect(r2.ok && r2.revisionId).toBe('r2');

    const dupTicket = await applyTicketPaperLifecycle({
      store,
      ticketId: TICKET_20100_ID,
      before: { ...ticket20100 } as Record<string, unknown>,
      after: { ...(ticketAfterA as object) } as Record<string, unknown>,
      nowMs: CLOSED_AT_MS + 12,
    });
    const dupInvoice = await applyInvoicePaperLifecycle({
      store,
      invoiceId: INVOICE_20100_ID,
      before: { ...invoice20100, status: 'closed' } as Record<string, unknown>,
      after: { ...(invoiceAfterA as object) } as Record<string, unknown>,
      nowMs: CLOSED_AT_MS + 12,
    });
    expect(dupTicket.class).toBe('success');
    expect(dupInvoice.class).toBe('success');
    expect(await store.getRevision(waterTicketArtifactId(TICKET_20100_ID), 'r3')).toBeNull();

    const ticketEditMs = CLOSED_AT_MS + 20;
    const ticketBefore = { ...(await store.getTicket(TICKET_20100_ID) as object) } as Record<string, unknown>;
    const ticketOrdinary = {
      ...ticketBefore,
      location: 'NEW WELL',
      paperMutationId: mutationA,
      updatedAt: { toMillis: () => ticketEditMs },
    };
    store.tickets.set(TICKET_20100_ID, ticketOrdinary as typeof ticket20100);
    const t3 = await applyTicketPaperLifecycle({
      store,
      ticketId: TICKET_20100_ID,
      before: ticketBefore,
      after: ticketOrdinary,
      nowMs: ticketEditMs,
    });
    expect(t3.class).toBe('success');
    expect(await store.getRevision(waterTicketArtifactId(TICKET_20100_ID), 'r3')).toBeTruthy();

    const invoiceEditMs = CLOSED_AT_MS + 30;
    const invoiceBefore = { ...(await store.getInvoice(INVOICE_20100_ID) as object) } as Record<string, unknown>;
    const invoiceOrdinary = {
      ...invoiceBefore,
      operator: 'Edited Operator',
      paperMutationId: mutationA,
      updatedAt: invoiceEditMs,
      editedAt: { toMillis: () => invoiceEditMs },
    };
    store.invoices.set(INVOICE_20100_ID, invoiceOrdinary as typeof invoice20100);
    const i4 = await applyInvoicePaperLifecycle({
      store,
      invoiceId: INVOICE_20100_ID,
      before: invoiceBefore,
      after: invoiceOrdinary,
      nowMs: invoiceEditMs,
    });
    expect(i4.class).toBe('success');
    expect(await store.getRevision(waterTicketArtifactId(TICKET_20100_ID), 'r4')).toBeTruthy();

    const current = await getWaterTicketPaper({
      store, caller: dispatchLg, lookup: { ticketDocId: TICKET_20100_ID }, nowMs: invoiceEditMs,
    });
    const old = await getWaterTicketPaper({
      store, caller: dispatchLg, lookup: { ticketDocId: TICKET_20100_ID }, revisionId: 'r1', nowMs: invoiceEditMs,
    });
    expect(current.ok && current.revisionId).toBe('r4');
    expect(old.ok && old.revisionId).toBe('r1');
    if (!current.ok || !old.ok) return;
    expect(old.contentHash).toBe(r1Hash);
    expect(old.contentHash).not.toBe(current.contentHash);
  });

  it('an older late-finishing event does not replace a newer current revision', async () => {
    const store = seed();
    await applyInvoicePaperLifecycle({
      store,
      invoiceId: INVOICE_20100_ID,
      before: { status: 'open' },
      after: { ...invoice20100, status: 'closed', closedAtMs: CLOSED_AT_MS } as Record<string, unknown>,
      nowMs: CLOSED_AT_MS,
    });
    const newerMs = CLOSED_AT_MS + 40;
    const olderMs = CLOSED_AT_MS + 20;
    const afterNew = { ...ticket20100, location: 'NEW', updatedAt: { toMillis: () => newerMs } };
    store.tickets.set(TICKET_20100_ID, afterNew);
    const newer = await applyTicketPaperLifecycle({
      store,
      ticketId: TICKET_20100_ID,
      before: { ...ticket20100 } as Record<string, unknown>,
      after: afterNew as Record<string, unknown>,
      nowMs: newerMs,
    });
    expect(newer.class).toBe('success');
    const afterOld = { ...ticket20100, location: 'OLD', updatedAt: { toMillis: () => olderMs } };
    const older = await applyTicketPaperLifecycle({
      store,
      ticketId: TICKET_20100_ID,
      before: { ...ticket20100 } as Record<string, unknown>,
      after: afterOld as Record<string, unknown>,
      nowMs: olderMs,
    });
    expect(older.class === 'success' || older.class === 'ignored').toBe(true);
    const current = await getWaterTicketPaper({
      store, caller: dispatchLg, lookup: { ticketDocId: TICKET_20100_ID }, nowMs: newerMs,
    });
    expect(current.ok && current.revisionId).toBe('r2');
    if (!current.ok) return;
    expect(current.html).toContain('NEW');
  });
});

describe('getTicketPaper uses the same stage authority as the route', () => {
  async function closedStore() {
    const store = seed();
    await materializeWaterTicketPaper({
      store, caller: staffLg, ticketDocId: TICKET_20100_ID, op: 'close', nowMs: CLOSED_AT_MS,
    });
    return store;
  }

  it('payroll cannot fetch bytes during dispatch_review', async () => {
    const store = await closedStore();
    const route = evaluatePaperPresentation({
      caller: payrollCap,
      ticket: ticket20100,
      invoice: { ...invoice20100, status: 'closed', closedAtMs: CLOSED_AT_MS },
      workflow: await store.getWorkflow(TICKET_20100_ID),
      nowMs: CLOSED_AT_MS,
    });
    const got = await getWaterTicketPaper({
      store, caller: payrollCap, lookup: { ticketDocId: TICKET_20100_ID }, nowMs: CLOSED_AT_MS,
    });
    expect(route.ok).toBe(false);
    expect(got.ok).toBe(false);
    expect(got).toMatchObject({ ok: false, reason: route.ok ? 'paper_not_visible' : route.reason });
  });

  it('payroll can fetch bytes in payroll_review and after billing lock', async () => {
    const store = await closedStore();
    const review = await store.getWorkflow(TICKET_20100_ID);
    const handed = await applyTicketReviewAction({
      store, caller: dispatchCap, ticketDocId: TICKET_20100_ID, action: 'hand_to_payroll', nowMs: CLOSED_AT_MS + 1, expectedVersion: review?.version ?? 1,
    });
    expect(handed.ok).toBe(true);
    const during = await getWaterTicketPaper({
      store, caller: payrollCap, lookup: { ticketDocId: TICKET_20100_ID }, nowMs: CLOSED_AT_MS + 1,
    });
    expect(during.ok).toBe(true);

    const billed = await applyTicketReviewAction({
      store, caller: payrollCap, ticketDocId: TICKET_20100_ID, action: 'finalize_to_billing', nowMs: CLOSED_AT_MS + 2, expectedVersion: handed.ok ? handed.version : 0,
    });
    expect(billed.ok).toBe(true);
    const after = await getWaterTicketPaper({
      store, caller: payrollCap, lookup: { ticketDocId: TICKET_20100_ID }, nowMs: CLOSED_AT_MS + 2,
    });
    expect(after.ok).toBe(true);
  });

  it('billing can fetch bytes only in billing', async () => {
    const store = await closedStore();
    const early = await getWaterTicketPaper({
      store, caller: billingCap, lookup: { ticketDocId: TICKET_20100_ID }, nowMs: CLOSED_AT_MS,
    });
    expect(early.ok).toBe(false);
    const review = await store.getWorkflow(TICKET_20100_ID);
    const handed = await applyTicketReviewAction({
      store, caller: dispatchCap, ticketDocId: TICKET_20100_ID, action: 'hand_to_payroll', nowMs: CLOSED_AT_MS + 1, expectedVersion: review?.version ?? 1,
    });
    expect(handed.ok).toBe(true);
    const mid = await getWaterTicketPaper({
      store, caller: billingCap, lookup: { ticketDocId: TICKET_20100_ID }, nowMs: CLOSED_AT_MS + 1,
    });
    expect(mid.ok).toBe(false);
    const billed = await applyTicketReviewAction({
      store, caller: payrollCap, ticketDocId: TICKET_20100_ID, action: 'finalize_to_billing', nowMs: CLOSED_AT_MS + 2, expectedVersion: handed.ok ? handed.version : 0,
    });
    expect(billed.ok).toBe(true);
    const late = await getWaterTicketPaper({
      store, caller: billingCap, lookup: { ticketDocId: TICKET_20100_ID }, nowMs: CLOSED_AT_MS + 2,
    });
    expect(late.ok).toBe(true);
  });

  it('dispatch can preview while it can edit and still fetch paper after handoff', async () => {
    const store = await closedStore();
    const during = await getWaterTicketPaper({
      store, caller: dispatchCap, lookup: { ticketDocId: TICKET_20100_ID }, nowMs: CLOSED_AT_MS,
    });
    expect(during.ok).toBe(true);
    const review = await store.getWorkflow(TICKET_20100_ID);
    await applyTicketReviewAction({
      store, caller: dispatchCap, ticketDocId: TICKET_20100_ID, action: 'hand_to_payroll', nowMs: CLOSED_AT_MS + 1, expectedVersion: review?.version ?? 1,
    });
    const after = await getWaterTicketPaper({
      store, caller: dispatchCap, lookup: { ticketDocId: TICKET_20100_ID }, nowMs: CLOSED_AT_MS + 1,
    });
    expect(after.ok).toBe(true);
  });
});

describe('request parsers require expectedVersion', () => {
  it('correction, handoff, finalize, and reopen require expectedVersion', () => {
    expect(parseMutatePaperRequest({ ticketDocId: 't1', fields: { truck: '1' } }))
      .toMatchObject({ ok: false, reason: 'expected_version_required' });
    expect(parseMutatePaperRequest({ ticketDocId: 't1', fields: { truck: '1' }, expectedVersion: 2 }))
      .toMatchObject({ ok: true, expectedVersion: 2 });
    expect(parseWorkflowTicketRequest({ ticketDocId: 't1', reason: 'need to reopen ticket' }))
      .toMatchObject({ ok: false, reason: 'expected_version_required' });
    expect(parseWorkflowTicketRequest({ ticketDocId: 't1', reason: 'need to reopen ticket', expectedVersion: 3 }))
      .toMatchObject({ ok: true, expectedVersion: 3 });
  });

  it('batch handoff accepts a one-ticket list and rejects an empty list', () => {
    expect(parseReviewBatchRequest({ tickets: [] })).toMatchObject({ ok: false, reason: 'invalid_request' });
    expect(parseReviewBatchRequest({
      batchId: 'b1',
      tickets: [{ ticketDocId: 't1', expectedVersion: 1 }],
    })).toMatchObject({ ok: true, batchId: 'b1', items: [{ ticketDocId: 't1', expectedVersion: 1 }] });
    expect(parseReviewBatchRequest({
      batchId: 'b1',
      tickets: [
        { ticketDocId: 't1', expectedVersion: 1 },
        { ticketDocId: 't1', expectedVersion: 2 },
      ],
    })).toMatchObject({ ok: false, reason: 'duplicate_ticket' });
  });
});

describe('Dispatch dispatch_review editor surface', () => {
  const root = join(__dirname, '../../../../src');
  const routed = readFileSync(join(root, 'components/TicketPaperRoutedView.tsx'), 'utf8');
  const editor = readFileSync(join(root, 'components/TicketReviewEditor.tsx'), 'utf8');
  const dispatch = readFileSync(join(root, 'app/dispatch/page.tsx'), 'utf8');
  const client = readFileSync(join(root, 'lib/canonicalPaper.ts'), 'utf8');

  it('does not fabricate an empty Ticket and fails closed without a structured record', () => {
    expect(routed).toContain('structuredRecord');
    expect(routed).toContain('structured_record_unavailable');
    expect(routed).not.toContain("id: '', ticketNumber: ''");
    expect(dispatch).toContain('TicketPaperRoutedView');
    expect(editor).toContain('reviewVersion');
    expect(editor).toContain('version_conflict');
    expect(editor).toContain('data-paper-rejected-draft');
    expect(client).toContain('expectedVersion');
  });

  it('Dispatch dispatch_review presents populated editor fields, saves a correction, and returns from preview', async () => {
    const store = seed();
    const workflow = seedDispatchReviewWorkflow({
      ticketDocId: TICKET_20100_ID,
      invoiceDocId: INVOICE_20100_ID,
      companyId: COMPANY_LG,
      invoice: { ...invoice20100, status: 'closed', closedAtMs: CLOSED_AT_MS },
      nowMs: CLOSED_AT_MS,
    });
    store.workflows.set(TICKET_20100_ID, workflow);
    const route = evaluatePaperPresentation({
      caller: dispatchCap,
      ticket: ticket20100,
      invoice: { ...invoice20100, status: 'closed', closedAtMs: CLOSED_AT_MS },
      workflow,
      nowMs: CLOSED_AT_MS,
    });
    expect(route).toMatchObject({ ok: true, mode: 'edit_form', reason: 'dispatch_review' });
    if (!route.ok) return;
    expect(route.structuredRecord.truck).toBe('102');
    expect(route.structuredRecord.location).toBe('KAHUNA 2');
    expect(route.reviewVersion).toBe(1);
    expect(paperBytesAllowed(route)).toBe(true);

    const saved = await applyTicketReviewAction({
      store,
      caller: dispatchCap,
      ticketDocId: route.structuredRecord.id,
      action: 'correct',
      fields: { truck: '777' },
      nowMs: CLOSED_AT_MS + 1,
      expectedVersion: route.reviewVersion,
    });
    expect(saved.ok).toBe(true);
    expect(store.tickets.get(TICKET_20100_ID)?.truck).toBe('777');

    expect(routed).toContain('Back to editor');
    expect(routed).toContain("route.mode === 'edit_form'");
    expect(editor).toContain('Preview paper');
  });
});
