import { MemoryPaperStore } from '../store';
import {
  applyTicketReviewAction,
  applyTicketReviewBatch,
  batchItemMutationId,
  commitReviewBatchItem,
} from '../ticketReview';
import { seedDispatchReviewWorkflow } from '../workflow';
import {
  CLOSED_AT_MS,
  COMPANY_LG,
  INVOICE_20100_ID,
  TICKET_20100_ID,
  dispatchLg,
  invoice20100,
  ticket20100,
} from './fixture20100';

const dispatchCap = { ...dispatchLg, caps: ['createDispatch', 'viewDispatch'] };
const closedInvoice = { ...invoice20100, status: 'closed', closedAtMs: CLOSED_AT_MS };
const dispatchReview = seedDispatchReviewWorkflow({
  ticketDocId: TICKET_20100_ID,
  invoiceDocId: INVOICE_20100_ID,
  companyId: COMPANY_LG,
  invoice: closedInvoice,
  nowMs: CLOSED_AT_MS,
});

function seedTwo() {
  const store = new MemoryPaperStore();
  store.tickets.set(TICKET_20100_ID, { ...ticket20100 });
  store.invoices.set(INVOICE_20100_ID, closedInvoice);
  store.workflows.set(TICKET_20100_ID, { ...dispatchReview });
  const ticketB = `${TICKET_20100_ID}-b`;
  store.tickets.set(ticketB, { ...ticket20100, id: ticketB });
  store.workflows.set(ticketB, { ...dispatchReview, ticketDocId: ticketB, version: 9 });
  return { store, ticketB };
}

describe('atomic batch item durability', () => {
  it('retry after halt returns stored success without another mutation or event', async () => {
    const { store, ticketB } = seedTwo();
    const items = [
      { ticketDocId: TICKET_20100_ID, expectedVersion: 1 },
      { ticketDocId: ticketB, expectedVersion: 9 },
    ];
    const partial = await applyTicketReviewBatch({
      store, caller: dispatchCap, action: 'hand_to_payroll', items, batchId: 'atomic-1', nowMs: CLOSED_AT_MS + 1, haltAfterIndex: 0,
    });
    expect(partial.ok).toBe(true);
    if (!partial.ok) return;
    expect(partial.results).toHaveLength(1);
    expect(partial.results[0]).toMatchObject({ ok: true, ticketDocId: TICKET_20100_ID, mutationId: batchItemMutationId('atomic-1', 0) });
    expect(store.reviewEvents.size).toBe(1);
    expect(store.workflows.get(TICKET_20100_ID)?.stage).toBe('payroll_review');
    expect(store.workflows.get(ticketB)?.stage).toBe('dispatch_review');

    const retry = await applyTicketReviewBatch({
      store, caller: dispatchCap, action: 'hand_to_payroll', items, batchId: 'atomic-1', nowMs: CLOSED_AT_MS + 2,
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.results[0]).toEqual(partial.results[0]);
    expect(retry.results[1]).toMatchObject({ ok: true, ticketDocId: ticketB });
    expect(store.reviewEvents.size).toBe(2);
    expect(store.reviewEvents.get(batchItemMutationId('atomic-1', 0))?.mutationId).toBe(batchItemMutationId('atomic-1', 0));
  });

  it('concurrent same batchId and digest collapse to one event per successful item', async () => {
    const { store, ticketB } = seedTwo();
    const items = [
      { ticketDocId: TICKET_20100_ID, expectedVersion: 1 },
      { ticketDocId: ticketB, expectedVersion: 9 },
    ];
    const [a, b] = await Promise.all([
      applyTicketReviewBatch({
        store, caller: dispatchCap, action: 'hand_to_payroll', items, batchId: 'atomic-conc', nowMs: CLOSED_AT_MS + 1,
      }),
      applyTicketReviewBatch({
        store, caller: dispatchCap, action: 'hand_to_payroll', items, batchId: 'atomic-conc', nowMs: CLOSED_AT_MS + 1,
      }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.results).toEqual(b.results);
    expect(a.results.every((row) => row.ok)).toBe(true);
    expect(store.reviewEvents.size).toBe(2);
    expect(store.workflows.get(TICKET_20100_ID)?.version).toBe(2);
    expect(store.workflows.get(ticketB)?.version).toBe(10);
  });

  it('recorded failure remains the original result after later state change', async () => {
    const store = new MemoryPaperStore();
    store.tickets.set(TICKET_20100_ID, { ...ticket20100 });
    store.invoices.set(INVOICE_20100_ID, closedInvoice);
    store.workflows.set(TICKET_20100_ID, { ...dispatchReview });
    const items = [{ ticketDocId: TICKET_20100_ID, expectedVersion: 99 }];
    const first = await applyTicketReviewBatch({
      store, caller: dispatchCap, action: 'hand_to_payroll', items, batchId: 'atomic-fail', nowMs: CLOSED_AT_MS + 1,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.results[0]).toMatchObject({ ok: false, reason: 'version_conflict' });
    expect(store.reviewEvents.size).toBe(0);

    const later = await applyTicketReviewAction({
      store, caller: dispatchCap, ticketDocId: TICKET_20100_ID, action: 'hand_to_payroll', nowMs: CLOSED_AT_MS + 2, expectedVersion: 1,
    });
    expect(later.ok).toBe(true);
    expect(store.workflows.get(TICKET_20100_ID)?.stage).toBe('payroll_review');

    const retry = await applyTicketReviewBatch({
      store, caller: dispatchCap, action: 'hand_to_payroll', items, batchId: 'atomic-fail', nowMs: CLOSED_AT_MS + 3,
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.results).toEqual(first.results);
    expect(store.reviewEvents.size).toBe(1);
  });

  it('commitReviewBatchItem replay does not write a second event', async () => {
    const store = new MemoryPaperStore();
    store.tickets.set(TICKET_20100_ID, { ...ticket20100 });
    store.invoices.set(INVOICE_20100_ID, closedInvoice);
    store.workflows.set(TICKET_20100_ID, { ...dispatchReview });
    const items = [{ ticketDocId: TICKET_20100_ID, expectedVersion: 1 }];
    const first = await applyTicketReviewBatch({
      store, caller: dispatchCap, action: 'hand_to_payroll', items, batchId: 'atomic-replay', nowMs: CLOSED_AT_MS + 1, haltAfterIndex: 0,
    });
    expect(first.ok).toBe(true);
    const again = await commitReviewBatchItem({
      store, caller: dispatchCap, batchId: 'atomic-replay', index: 0, nowMs: CLOSED_AT_MS + 2,
    });
    expect(again).toMatchObject({ ok: true, replayed: true });
    expect(store.reviewEvents.size).toBe(1);
  });
});
