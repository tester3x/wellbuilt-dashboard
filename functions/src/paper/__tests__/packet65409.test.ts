import { evaluateStoredPaperAccess } from '../actorPolicy';
import { getWaterTicketPaper, materializeWaterTicketPaper } from '../engine';
import { applyInvoicePaperLifecycle, applyTicketPaperLifecycle } from '../lifecycle';
import { parseReviewBatchRequest } from '../requests';
import { MemoryPaperStore } from '../store';
import { applyTicketReviewAction, applyTicketReviewBatch, validateTypedFields } from '../ticketReview';
import { waterTicketArtifactId } from '../types';
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
  driverOther,
  driverOwner,
  invoice20100,
  payrollLg,
  platformAdmin,
  staffLg,
  staffOther,
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
const combinedPayrollBilling = {
  kind: 'dashboard' as const,
  uid: 'combo',
  companyId: COMPANY_LG,
  isPlatformAdmin: false,
  roles: ['payroll'],
  caps: ['approvePayroll', 'editBilling', 'viewPayroll', 'viewBilling'],
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

async function closeStore() {
  const store = seed();
  await materializeWaterTicketPaper({
    store, caller: staffLg, ticketDocId: TICKET_20100_ID, op: 'close', nowMs: CLOSED_AT_MS,
  });
  return store;
}

describe('batch handoff retry idempotency', () => {
  it('rejects duplicate ticketDocIds in one batch', () => {
    expect(parseReviewBatchRequest({
      batchId: 'b1',
      tickets: [
        { ticketDocId: TICKET_20100_ID, expectedVersion: 1 },
        { ticketDocId: TICKET_20100_ID, expectedVersion: 1 },
      ],
    })).toMatchObject({ ok: false, reason: 'duplicate_ticket' });
  });

  it('same batchId + digest returns original results; different digest conflicts', async () => {
    const store = await closeStore();
    const review = await store.getWorkflow(TICKET_20100_ID);
    const items = [{ ticketDocId: TICKET_20100_ID, expectedVersion: review?.version ?? 1 }];
    const first = await applyTicketReviewBatch({
      store, caller: dispatchCap, action: 'hand_to_payroll', items, batchId: 'pay-1', nowMs: CLOSED_AT_MS + 1,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.results[0]).toMatchObject({ ok: true, ticketDocId: TICKET_20100_ID });
    const retry = await applyTicketReviewBatch({
      store, caller: dispatchCap, action: 'hand_to_payroll', items, batchId: 'pay-1', nowMs: CLOSED_AT_MS + 2,
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.idempotent).toBe(true);
    expect(retry.results).toEqual(first.results);
    expect(store.reviewEvents.size).toBe(1);

    const clash = await applyTicketReviewBatch({
      store,
      caller: dispatchCap,
      action: 'finalize_to_billing',
      items,
      batchId: 'pay-1',
      nowMs: CLOSED_AT_MS + 3,
    });
    expect(clash).toMatchObject({ ok: false, reason: 'batch_id_conflict' });
  });
});

describe('deleted-source paper access stays stage-aware', () => {
  async function deletedAtStage(stage: 'dispatch_review' | 'payroll_review' | 'billing') {
    const store = await closeStore();
    const review = await store.getWorkflow(TICKET_20100_ID);
    if (stage !== 'dispatch_review') {
      const handed = await applyTicketReviewAction({
        store, caller: dispatchCap, ticketDocId: TICKET_20100_ID, action: 'hand_to_payroll',
        nowMs: CLOSED_AT_MS + 1, expectedVersion: review?.version ?? 1,
      });
      expect(handed.ok).toBe(true);
      if (stage === 'billing' && handed.ok) {
        const billed = await applyTicketReviewAction({
          store, caller: payrollCap, ticketDocId: TICKET_20100_ID, action: 'finalize_to_billing',
          nowMs: CLOSED_AT_MS + 2, expectedVersion: handed.version,
        });
        expect(billed.ok).toBe(true);
      }
    }
    store.tickets.delete(TICKET_20100_ID);
    store.invoices.delete(INVOICE_20100_ID);
    return store;
  }

  it('driver owner can read after deletion; other driver cannot', async () => {
    const store = await deletedAtStage('dispatch_review');
    const own = await getWaterTicketPaper({
      store, caller: driverOwner, lookup: { ticketDocId: TICKET_20100_ID }, nowMs: CLOSED_AT_MS,
    });
    const other = await getWaterTicketPaper({
      store, caller: driverOther, lookup: { ticketDocId: TICKET_20100_ID }, nowMs: CLOSED_AT_MS,
    });
    expect(own.ok).toBe(true);
    expect(other).toMatchObject({ ok: false, reason: 'not_document_owner' });
  });

  it('Dispatch/Payroll/Billing/combined follow stage policy after deletion', async () => {
    const dispatchStage = await deletedAtStage('dispatch_review');
    expect((await getWaterTicketPaper({
      store: dispatchStage, caller: dispatchCap, lookup: { ticketDocId: TICKET_20100_ID }, nowMs: CLOSED_AT_MS,
    })).ok).toBe(true);
    expect((await getWaterTicketPaper({
      store: dispatchStage, caller: payrollCap, lookup: { ticketDocId: TICKET_20100_ID }, nowMs: CLOSED_AT_MS,
    })).ok).toBe(false);
    expect((await getWaterTicketPaper({
      store: dispatchStage, caller: billingCap, lookup: { ticketDocId: TICKET_20100_ID }, nowMs: CLOSED_AT_MS,
    })).ok).toBe(false);
    expect((await getWaterTicketPaper({
      store: dispatchStage, caller: combinedPayrollBilling, lookup: { ticketDocId: TICKET_20100_ID }, nowMs: CLOSED_AT_MS,
    })).ok).toBe(false);

    const payrollStage = await deletedAtStage('payroll_review');
    expect((await getWaterTicketPaper({
      store: payrollStage, caller: payrollCap, lookup: { ticketDocId: TICKET_20100_ID }, nowMs: CLOSED_AT_MS,
    })).ok).toBe(true);
    expect((await getWaterTicketPaper({
      store: payrollStage, caller: billingCap, lookup: { ticketDocId: TICKET_20100_ID }, nowMs: CLOSED_AT_MS,
    })).ok).toBe(false);
    expect((await getWaterTicketPaper({
      store: payrollStage, caller: combinedPayrollBilling, lookup: { ticketDocId: TICKET_20100_ID }, nowMs: CLOSED_AT_MS,
    })).ok).toBe(true);

    const billingStage = await deletedAtStage('billing');
    expect((await getWaterTicketPaper({
      store: billingStage, caller: billingCap, lookup: { ticketDocId: TICKET_20100_ID }, nowMs: CLOSED_AT_MS,
    })).ok).toBe(true);
    expect((await getWaterTicketPaper({
      store: billingStage, caller: payrollCap, lookup: { ticketDocId: TICKET_20100_ID }, nowMs: CLOSED_AT_MS,
    })).ok).toBe(true);
    expect((await getWaterTicketPaper({
      store: billingStage, caller: combinedPayrollBilling, lookup: { ticketDocId: TICKET_20100_ID }, nowMs: CLOSED_AT_MS,
    })).ok).toBe(true);
  });

  it('unrelated company is denied and missing workflow fails closed except platform admin', async () => {
    const store = await deletedAtStage('dispatch_review');
    expect((await getWaterTicketPaper({
      store, caller: staffOther, lookup: { ticketDocId: TICKET_20100_ID }, nowMs: CLOSED_AT_MS,
    }))).toMatchObject({ ok: false, reason: 'record_company_mismatch' });
    expect((await getWaterTicketPaper({
      store, caller: platformAdmin, lookup: { ticketDocId: TICKET_20100_ID }, nowMs: CLOSED_AT_MS,
    })).ok).toBe(true);

    store.workflows.delete(TICKET_20100_ID);
    expect((await getWaterTicketPaper({
      store, caller: dispatchCap, lookup: { ticketDocId: TICKET_20100_ID }, nowMs: CLOSED_AT_MS,
    }))).toMatchObject({ ok: false, reason: 'workflow_unavailable' });
    expect((await getWaterTicketPaper({
      store, caller: platformAdmin, lookup: { ticketDocId: TICKET_20100_ID }, nowMs: CLOSED_AT_MS,
    })).ok).toBe(true);
    expect(evaluateStoredPaperAccess({
      caller: dispatchCap,
      artifact: { companyId: COMPANY_LG, ownerDriverId: DRIVER_ZFOLD },
      workflow: null,
    })).toMatchObject({ ok: false, reason: 'workflow_unavailable' });
  });
});

describe('mirrored-field no-op detection', () => {
  it('stale invoice mirror is a real correction; true no-op writes nothing', async () => {
    const store = await closeStore();
    store.invoices.set(INVOICE_20100_ID, {
      ...store.invoices.get(INVOICE_20100_ID)!,
      truckNumber: '999',
      trailer: 'OLD',
      totalHours: 9,
      operator: 'Stale Op',
      wellName: 'STALE WELL',
      hauledTo: 'STALE SWD',
    });
    const review = await store.getWorkflow(TICKET_20100_ID);
    const truck = await applyTicketReviewAction({
      store, caller: dispatchCap, ticketDocId: TICKET_20100_ID, action: 'correct',
      fields: { truck: '102' }, nowMs: CLOSED_AT_MS + 3, expectedVersion: review?.version ?? 1,
    });
    expect(truck.ok).toBe(true);
    expect(store.invoices.get(INVOICE_20100_ID)?.truckNumber).toBe('102');
    expect(store.tickets.get(TICKET_20100_ID)?.truck).toBe('102');

    const next = await store.getWorkflow(TICKET_20100_ID);
    const trailer = await applyTicketReviewAction({
      store, caller: dispatchCap, ticketDocId: TICKET_20100_ID, action: 'correct',
      fields: { trailer: 'T30' }, nowMs: CLOSED_AT_MS + 4, expectedVersion: next?.version ?? 2,
    });
    expect(trailer.ok).toBe(true);
    expect(store.invoices.get(INVOICE_20100_ID)?.trailer).toBe('T30');

    const afterTrailer = await store.getWorkflow(TICKET_20100_ID);
    const hours = await applyTicketReviewAction({
      store, caller: dispatchCap, ticketDocId: TICKET_20100_ID, action: 'correct',
      fields: { hours: 0 }, nowMs: CLOSED_AT_MS + 5, expectedVersion: afterTrailer?.version ?? 3,
    });
    expect(hours.ok).toBe(true);
    expect(store.invoices.get(INVOICE_20100_ID)?.totalHours).toBe(0);
    expect(store.tickets.get(TICKET_20100_ID)?.hours).toBe(0);

    const afterHours = await store.getWorkflow(TICKET_20100_ID);
    const noop = await applyTicketReviewAction({
      store, caller: dispatchCap, ticketDocId: TICKET_20100_ID, action: 'correct',
      fields: { truck: '102', trailer: 'T30', hours: 0 },
      nowMs: CLOSED_AT_MS + 6, expectedVersion: afterHours?.version ?? 4,
    });
    expect(noop).toMatchObject({ ok: false, reason: 'no_effective_change' });
    expect(store.workflows.get(TICKET_20100_ID)?.version).toBe(afterHours?.version);
  });
});

describe('driver CAS gap is closed', () => {
  it('rejects driver use of staffCorrectTicket', async () => {
    const store = seed();
    const denied = await applyTicketReviewAction({
      store, caller: driverOwner, ticketDocId: TICKET_20100_ID, action: 'correct',
      fields: { truck: '1' }, nowMs: CLOSED_AT_MS, expectedVersion: 0,
    });
    expect(denied).toMatchObject({ ok: false, reason: 'drivers_cannot_correct' });
    expect(store.tickets.get(TICKET_20100_ID)?.truck).toBe('102');
    expect(store.reviewEvents.size).toBe(0);
  });
});

describe('domain bounds', () => {
  it('rejects BBL quantities above the WBM 20000 ceiling', () => {
    expect(validateTypedFields({ qty: 20001 })).toMatchObject({ ok: false, reason: 'invalid_field_value' });
    expect(validateTypedFields({ totalBBL: 20000 }).ok).toBe(true);
  });

  it('hours remain finite and nonnegative with no invented upper bound', () => {
    expect(validateTypedFields({ hours: 1000 }).ok).toBe(true);
    expect(validateTypedFields({ hours: -0.1 })).toMatchObject({ ok: false, reason: 'invalid_field_value' });
  });
});

describe('one correction still one revision after mirrored patch', () => {
  it('ticket+invoice truck reconciliation creates r2 only', async () => {
    const store = await closeStore();
    const invoiceStale = { ...store.invoices.get(INVOICE_20100_ID)!, truckNumber: '000' };
    store.invoices.set(INVOICE_20100_ID, invoiceStale);
    const review = await store.getWorkflow(TICKET_20100_ID);
    const ticketBefore = { ...(await store.getTicket(TICKET_20100_ID) as object) } as Record<string, unknown>;
    const invoiceBefore = { ...invoiceStale } as Record<string, unknown>;
    const corrected = await applyTicketReviewAction({
      store, caller: dispatchCap, ticketDocId: TICKET_20100_ID, action: 'correct',
      fields: { truck: '102' }, nowMs: CLOSED_AT_MS + 8, expectedVersion: review?.version ?? 1,
    });
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) return;
    const ticketAfter = await store.getTicket(TICKET_20100_ID);
    const invoiceAfter = await store.getInvoice(INVOICE_20100_ID);
    const [tLife, iLife] = await Promise.all([
      applyTicketPaperLifecycle({
        store, ticketId: TICKET_20100_ID,
        before: ticketBefore,
        after: { ...(ticketAfter as object) } as Record<string, unknown>,
        nowMs: CLOSED_AT_MS + 9,
      }),
      applyInvoicePaperLifecycle({
        store, invoiceId: INVOICE_20100_ID,
        before: invoiceBefore,
        after: { ...(invoiceAfter as object) } as Record<string, unknown>,
        nowMs: CLOSED_AT_MS + 9,
      }),
    ]);
    expect(tLife.class === 'success' || iLife.class === 'success').toBe(true);
    expect(await store.getRevision(waterTicketArtifactId(TICKET_20100_ID), 'r2')).toBeTruthy();
    expect(await store.getRevision(waterTicketArtifactId(TICKET_20100_ID), 'r3')).toBeNull();
  });
});
