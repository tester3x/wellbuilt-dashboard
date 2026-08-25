import {
  DRIVER_EDIT_WINDOW_MS,
  PAPER_ACTOR_POLICY_VERSION,
  assertActorMayMutateTicket,
  evaluatePaperPresentation,
} from '../actorPolicy';
import { applyTicketReviewAction } from '../ticketReview';
import { MemoryPaperStore } from '../store';
import { resolvePaperPresentation } from '../presentation';
import { waterTicketArtifactId } from '../types';
import { finalizeToBilling, handToPayroll, reopenForOverride, seedDispatchReviewWorkflow } from '../workflow';
import {
  CLOSED_AT_MS,
  COMPANY_LG,
  DRIVER_OTHER,
  DRIVER_ZFOLD,
  INVOICE_20100_ID,
  TICKET_20100_ID,
  dispatchLg,
  driverOther,
  driverOwner,
  invoice20100,
  payrollLg,
  platformAdmin,
  ticket20100,
} from './fixture20100';

const closedInvoice = { ...invoice20100, status: 'closed', closedAtMs: CLOSED_AT_MS };
const createdLongAgo = CLOSED_AT_MS - (3 * 24 * 60 * 60 * 1000);
const dispatchReview = seedDispatchReviewWorkflow({
  ticketDocId: TICKET_20100_ID,
  invoiceDocId: INVOICE_20100_ID,
  companyId: COMPANY_LG,
  invoice: closedInvoice,
  nowMs: CLOSED_AT_MS,
});
const dispatchCap = { ...dispatchLg, caps: ['createDispatch', 'viewDispatch'] };
const payrollCap = { ...payrollLg, caps: ['approvePayroll', 'viewPayroll'] };

const combinedPayrollBilling = {
  kind: 'dashboard' as const,
  uid: 'combo',
  companyId: COMPANY_LG,
  isPlatformAdmin: false,
  roles: ['payroll'],
  caps: ['approvePayroll', 'editBilling', 'viewPayroll', 'viewBilling'],
};

describe('driver close-origin window', () => {
  it('open owner-driver job is edit_form even if createdAt is old', () => {
    const r = evaluatePaperPresentation({
      caller: driverOwner,
      ticket: ticket20100,
      invoice: { ...invoice20100, createdAtMs: createdLongAgo, closedAtMs: undefined, closedAt: undefined, status: 'open' },
      nowMs: CLOSED_AT_MS,
    });
    expect(r).toMatchObject({ ok: true, mode: 'edit_form', reason: 'driver_open_job', canEdit: true });
  });

  it('close starts the clock; createdAt does not', () => {
    const r = evaluatePaperPresentation({
      caller: driverOwner,
      ticket: ticket20100,
      invoice: { ...closedInvoice, createdAtMs: createdLongAgo },
      nowMs: CLOSED_AT_MS + 60 * 60 * 1000,
    });
    expect(r).toMatchObject({ ok: true, mode: 'edit_form', reason: 'driver_correction_window', previewAvailable: true });
  });

  it('driver at/after closedAt + 24h is canonical_paper', () => {
    const r = evaluatePaperPresentation({
      caller: driverOwner,
      ticket: ticket20100,
      invoice: closedInvoice,
      nowMs: CLOSED_AT_MS + DRIVER_EDIT_WINDOW_MS,
      artifact: { artifactId: waterTicketArtifactId(TICKET_20100_ID), currentRevisionId: 'r1' },
    });
    expect(r).toMatchObject({ ok: true, mode: 'canonical_paper', canEdit: false, revisionId: 'r1' });
  });

  it('closed job without closedAt fails closed', () => {
    const r = evaluatePaperPresentation({
      caller: driverOwner,
      ticket: ticket20100,
      invoice: { ...invoice20100, status: 'closed', closedAtMs: undefined, closedAt: undefined },
      nowMs: CLOSED_AT_MS,
    });
    expect(r).toMatchObject({ ok: false, reason: 'edit_window_unknown', canEdit: false });
  });

  it('server nowMs controls expiration', () => {
    const r = evaluatePaperPresentation({
      caller: driverOwner,
      ticket: ticket20100,
      invoice: closedInvoice,
      nowMs: CLOSED_AT_MS + DRIVER_EDIT_WINDOW_MS,
    });
    expect(r.ok && r.mode).toBe('canonical_paper');
  });
});

describe('capability and workflow stage', () => {
  it('dispatch before payroll handoff gets structured form', () => {
    const r = evaluatePaperPresentation({
      caller: dispatchCap,
      ticket: ticket20100,
      invoice: closedInvoice,
      workflow: dispatchReview,
      nowMs: CLOSED_AT_MS + DRIVER_EDIT_WINDOW_MS + 1000,
    });
    expect(r).toMatchObject({ ok: true, mode: 'edit_form', stageActor: 'dispatch', canEdit: true, reason: 'dispatch_review' });
  });

  it('dispatch after handoff receives canonical paper', () => {
    const handed = handToPayroll(dispatchReview, dispatchCap, CLOSED_AT_MS + 1);
    expect(handed.ok).toBe(true);
    if (!handed.ok) return;
    const r = evaluatePaperPresentation({
      caller: dispatchCap,
      ticket: ticket20100,
      invoice: closedInvoice,
      workflow: handed.workflow,
      nowMs: CLOSED_AT_MS + 2,
    });
    expect(r).toMatchObject({ ok: true, mode: 'canonical_paper', canEdit: false });
  });

  it('payroll during payroll_review gets payroll fields', () => {
    const handed = handToPayroll(dispatchReview, dispatchCap, CLOSED_AT_MS + 1);
    expect(handed.ok).toBe(true);
    if (!handed.ok) return;
    const r = evaluatePaperPresentation({
      caller: payrollCap,
      ticket: ticket20100,
      invoice: closedInvoice,
      workflow: handed.workflow,
      nowMs: CLOSED_AT_MS + 2,
    });
    expect(r.ok && r.mode).toBe('edit_form');
    expect(r.ok && r.allowedFields).toEqual(expect.arrayContaining(['hours', 'totalHours']));
    expect(r.ok && r.allowedFields).not.toContain('qty');
    expect(r.ok && r.allowedFields).not.toContain('location');
  });

  it('payroll after billing handoff receives paper', () => {
    const handed = handToPayroll(dispatchReview, dispatchCap, CLOSED_AT_MS + 1);
    expect(handed.ok && handed.ok).toBe(true);
    if (!handed.ok) return;
    const billed = finalizeToBilling(handed.workflow, payrollCap, CLOSED_AT_MS + 2);
    expect(billed.ok).toBe(true);
    if (!billed.ok) return;
    const r = evaluatePaperPresentation({
      caller: payrollCap,
      ticket: ticket20100,
      invoice: closedInvoice,
      workflow: billed.workflow,
      nowMs: CLOSED_AT_MS + 3,
    });
    expect(r).toMatchObject({ ok: true, mode: 'canonical_paper', canEdit: false });
  });

  it('combined payroll+billing user loses edit after payroll finalization', () => {
    const handed = handToPayroll(dispatchReview, dispatchCap, CLOSED_AT_MS + 1);
    expect(handed.ok).toBe(true);
    if (!handed.ok) return;
    const during = evaluatePaperPresentation({
      caller: combinedPayrollBilling,
      ticket: ticket20100,
      invoice: closedInvoice,
      workflow: handed.workflow,
      nowMs: CLOSED_AT_MS + 2,
    });
    expect(during).toMatchObject({ ok: true, mode: 'edit_form', stageActor: 'payroll' });
    const billed = finalizeToBilling(handed.workflow, combinedPayrollBilling, CLOSED_AT_MS + 3);
    expect(billed.ok).toBe(true);
    if (!billed.ok) return;
    const after = evaluatePaperPresentation({
      caller: combinedPayrollBilling,
      ticket: ticket20100,
      invoice: closedInvoice,
      workflow: billed.workflow,
      nowMs: CLOSED_AT_MS + 4,
    });
    expect(after).toMatchObject({ ok: true, mode: 'canonical_paper', stageActor: 'billing', canEdit: false });
  });

  it('billing cannot mutate the original ticket', () => {
    const billed = {
      ...dispatchReview,
      stage: 'billing' as const,
    };
    expect(assertActorMayMutateTicket({
      caller: combinedPayrollBilling,
      ticket: ticket20100,
      invoice: closedInvoice,
      workflow: billed,
      nowMs: CLOSED_AT_MS + 10,
      fields: ['qty'],
    })).toMatchObject({ ok: false, reason: 'billing_cannot_mutate_ticket' });
  });

  it('billing correction requires governed reopen/reason', () => {
    const billed = { ...dispatchReview, stage: 'billing' as const };
    const missing = reopenForOverride(billed, platformAdmin, 'short', CLOSED_AT_MS);
    expect(missing).toMatchObject({ ok: false, reason: 'reason_required' });
    const ok = reopenForOverride(billed, platformAdmin, 'quantity error found in billing', CLOSED_AT_MS);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    const view = evaluatePaperPresentation({
      caller: platformAdmin,
      ticket: ticket20100,
      invoice: closedInvoice,
      workflow: ok.workflow,
      nowMs: CLOSED_AT_MS + 1,
    });
    expect(view).toMatchObject({ ok: true, mode: 'edit_form', reason: 'admin_override' });
  });

  it('platform admin normal view is paper', () => {
    const r = evaluatePaperPresentation({
      caller: platformAdmin,
      ticket: ticket20100,
      invoice: closedInvoice,
      workflow: dispatchReview,
      nowMs: CLOSED_AT_MS,
    });
    expect(r).toMatchObject({ ok: true, mode: 'canonical_paper', canEdit: false, reason: 'admin_view_paper' });
  });

  it('multi-role resolution uses capabilities/state, not roles[0]', () => {
    const weird = {
      kind: 'dashboard' as const,
      uid: 'x',
      companyId: COMPANY_LG,
      isPlatformAdmin: false,
      roles: ['viewer', 'payroll', 'dispatch'],
      caps: ['createDispatch'],
    };
    const r = evaluatePaperPresentation({
      caller: weird,
      ticket: ticket20100,
      invoice: closedInvoice,
      workflow: dispatchReview,
      nowMs: CLOSED_AT_MS,
    });
    expect(r).toMatchObject({ ok: true, stageActor: 'dispatch', mode: 'edit_form' });
  });

  it('open dashboard job is read_only_detail', () => {
    const r = evaluatePaperPresentation({
      caller: dispatchCap,
      ticket: ticket20100,
      invoice: { ...invoice20100, closedAtMs: undefined, closedAt: undefined, status: 'open' },
      nowMs: CLOSED_AT_MS,
    });
    expect(r).toMatchObject({ ok: true, mode: 'read_only_detail', canEdit: false });
  });
});

describe('mutation enforcement', () => {
  it('rejects driver mutation after window', () => {
    expect(assertActorMayMutateTicket({
      caller: driverOwner,
      ticket: ticket20100,
      invoice: closedInvoice,
      nowMs: CLOSED_AT_MS + DRIVER_EDIT_WINDOW_MS,
      fields: ['qty'],
    })).toMatchObject({ ok: false, reason: 'edit_window_expired' });
  });

  it('rejects dispatch field outside operational scope', () => {
    expect(assertActorMayMutateTicket({
      caller: dispatchCap,
      ticket: ticket20100,
      invoice: closedInvoice,
      workflow: dispatchReview,
      nowMs: CLOSED_AT_MS,
      fields: ['totalBBL'],
    })).toMatchObject({ ok: false, reason: 'unexpected_field' });
  });

  it('mutateTicketPaper writes allowed dispatch fields and rejects billing', async () => {
    const store = new MemoryPaperStore();
    store.tickets.set(TICKET_20100_ID, { ...ticket20100 });
    store.invoices.set(INVOICE_20100_ID, closedInvoice);
    store.workflows.set(TICKET_20100_ID, dispatchReview);
    const ok = await applyTicketReviewAction({
      store, caller: dispatchCap, ticketDocId: TICKET_20100_ID, action: 'correct', fields: { truck: '999' }, nowMs: CLOSED_AT_MS,
    });
    expect(ok).toMatchObject({ ok: true, via: 'dispatch' });
    expect(store.tickets.get(TICKET_20100_ID)?.truck).toBe('999');
    const billed = { ...dispatchReview, stage: 'billing' as const };
    store.workflows.set(TICKET_20100_ID, billed);
    const denied = await applyTicketReviewAction({
      store, caller: combinedPayrollBilling, ticketDocId: TICKET_20100_ID, action: 'correct', fields: { qty: '1' }, nowMs: CLOSED_AT_MS + 1,
    });
    expect(denied).toMatchObject({ ok: false, reason: 'billing_cannot_mutate_ticket' });
  });
});

describe('resolvePaperPresentation', () => {
  it('returns revision identity after driver expiry', async () => {
    const store = new MemoryPaperStore();
    store.tickets.set(TICKET_20100_ID, { ...ticket20100 });
    store.invoices.set(INVOICE_20100_ID, closedInvoice);
    store.artifacts.set(waterTicketArtifactId(TICKET_20100_ID), {
      artifactId: waterTicketArtifactId(TICKET_20100_ID),
      artifactType: 'water_ticket',
      currentRevisionId: 'r2',
      nextRevisionSeq: 2,
      displayNumber: '20100',
      companyId: COMPANY_LG,
      ticketDocId: TICKET_20100_ID,
      invoiceDocId: INVOICE_20100_ID,
      ownerDriverId: DRIVER_ZFOLD,
      paperTimeZone: 'America/Chicago',
      currentEventMs: CLOSED_AT_MS,
      currentSourceEventId: `close:${TICKET_20100_ID}:${CLOSED_AT_MS}`,
      createdAtMs: CLOSED_AT_MS,
      updatedAtMs: CLOSED_AT_MS,
    });
    const r = await resolvePaperPresentation({
      store,
      caller: driverOwner,
      lookup: { ticketDocId: TICKET_20100_ID },
      nowMs: CLOSED_AT_MS + DRIVER_EDIT_WINDOW_MS + 1,
    });
    expect(r).toMatchObject({ ok: true, mode: 'canonical_paper', revisionId: 'r2' });
  });
});

describe('fail closed and tenant', () => {
  it('role label alone does not grant dispatch mutation', () => {
    expect(assertActorMayMutateTicket({
      caller: dispatchLg,
      ticket: ticket20100,
      invoice: closedInvoice,
      workflow: dispatchReview,
      nowMs: CLOSED_AT_MS,
      fields: ['truck'],
    })).toMatchObject({ ok: false });
  });

  it('missing workflow fails closed for dispatch', () => {
    const r = evaluatePaperPresentation({
      caller: dispatchCap,
      ticket: ticket20100,
      invoice: closedInvoice,
      nowMs: CLOSED_AT_MS,
    });
    expect(r).toMatchObject({ ok: false, reason: 'workflow_unavailable', canEdit: false });
  });

  it('payroll cannot change operational measurements', () => {
    const handed = handToPayroll(dispatchReview, dispatchCap, CLOSED_AT_MS + 1);
    expect(handed.ok).toBe(true);
    if (!handed.ok) return;
    expect(assertActorMayMutateTicket({
      caller: payrollCap,
      ticket: ticket20100,
      invoice: closedInvoice,
      workflow: handed.workflow,
      nowMs: CLOSED_AT_MS + 2,
      fields: ['qty'],
    })).toMatchObject({ ok: false, reason: 'unexpected_field' });
  });

  it('cross-company mutation and handoff are denied', async () => {
    const store = new MemoryPaperStore();
    store.tickets.set(TICKET_20100_ID, { ...ticket20100 });
    store.invoices.set(INVOICE_20100_ID, closedInvoice);
    store.workflows.set(TICKET_20100_ID, dispatchReview);
    const other = { ...dispatchCap, companyId: 'other-co' };
    const mut = await applyTicketReviewAction({
      store, caller: other, ticketDocId: TICKET_20100_ID, action: 'correct', fields: { truck: '1' }, nowMs: CLOSED_AT_MS,
    });
    expect(mut).toMatchObject({ ok: false, reason: 'record_company_mismatch' });
    const hand = await applyTicketReviewAction({
      store, caller: other, ticketDocId: TICKET_20100_ID, action: 'hand_to_payroll', nowMs: CLOSED_AT_MS,
    });
    expect(hand).toMatchObject({ ok: false, reason: 'record_company_mismatch' });
    const fin = await applyTicketReviewAction({
      store, caller: { ...payrollCap, companyId: 'other-co' }, ticketDocId: TICKET_20100_ID, action: 'finalize_to_billing', nowMs: CLOSED_AT_MS,
    });
    expect(fin).toMatchObject({ ok: false, reason: 'record_company_mismatch' });
    const re = await applyTicketReviewAction({
      store, caller: { ...platformAdmin, companyId: 'other-co', isPlatformAdmin: false, caps: [] }, ticketDocId: TICKET_20100_ID, action: 'reopen', reason: 'need to reopen ticket', nowMs: CLOSED_AT_MS,
    });
    expect(re.ok).toBe(false);
  });

  it('typed invalid values are rejected', async () => {
    const store = new MemoryPaperStore();
    store.tickets.set(TICKET_20100_ID, { ...ticket20100 });
    store.invoices.set(INVOICE_20100_ID, closedInvoice);
    store.workflows.set(TICKET_20100_ID, dispatchReview);
    const bad = await applyTicketReviewAction({
      store, caller: dispatchCap, ticketDocId: TICKET_20100_ID, action: 'correct', fields: { hours: 'twelve' }, nowMs: CLOSED_AT_MS,
    });
    expect(bad).toMatchObject({ ok: false, reason: 'invalid_field_type' });
  });

  it('open invoice cannot hand off', async () => {
    const store = new MemoryPaperStore();
    store.tickets.set(TICKET_20100_ID, { ...ticket20100 });
    store.invoices.set(INVOICE_20100_ID, { ...invoice20100, closedAtMs: undefined, closedAt: undefined, status: 'open' });
    const r = await applyTicketReviewAction({
      store, caller: dispatchCap, ticketDocId: TICKET_20100_ID, action: 'hand_to_payroll', nowMs: CLOSED_AT_MS,
    });
    expect(r.ok).toBe(false);
  });

  it('concurrent handoff cannot regress', async () => {
    const store = new MemoryPaperStore();
    store.tickets.set(TICKET_20100_ID, { ...ticket20100 });
    store.invoices.set(INVOICE_20100_ID, closedInvoice);
    store.workflows.set(TICKET_20100_ID, dispatchReview);
    const [a, b] = await Promise.all([
      applyTicketReviewAction({ store, caller: dispatchCap, ticketDocId: TICKET_20100_ID, action: 'hand_to_payroll', nowMs: CLOSED_AT_MS + 1 }),
      applyTicketReviewAction({ store, caller: dispatchCap, ticketDocId: TICKET_20100_ID, action: 'hand_to_payroll', nowMs: CLOSED_AT_MS + 1 }),
    ]);
    const ok = [a, b].filter((x) => x.ok);
    const fail = [a, b].filter((x) => !x.ok);
    expect(ok).toHaveLength(1);
    expect(fail).toHaveLength(1);
    expect(store.workflows.get(TICKET_20100_ID)?.stage).toBe('payroll_review');
    expect(store.reviewEvents.size).toBe(1);
  });

  it('ticket+invoice correction shares one mutationId', async () => {
    const store = new MemoryPaperStore();
    store.tickets.set(TICKET_20100_ID, { ...ticket20100 });
    store.invoices.set(INVOICE_20100_ID, closedInvoice);
    store.workflows.set(TICKET_20100_ID, dispatchReview);
    const r = await applyTicketReviewAction({
      store, caller: dispatchCap, ticketDocId: TICKET_20100_ID, action: 'correct', fields: { truck: '777' }, nowMs: CLOSED_AT_MS,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(store.tickets.get(TICKET_20100_ID)?.paperMutationId).toBe(r.mutationId);
    expect(store.invoices.get(INVOICE_20100_ID)?.paperMutationId).toBe(r.mutationId);
  });
});

describe('other driver', () => {
  it('other driver is denied', () => {
    const r = evaluatePaperPresentation({
      caller: { ...driverOther, driverId: DRIVER_OTHER },
      ticket: ticket20100,
      invoice: closedInvoice,
      nowMs: CLOSED_AT_MS,
    });
    expect(r).toMatchObject({ ok: false, reason: 'not_document_owner' });
  });
});
