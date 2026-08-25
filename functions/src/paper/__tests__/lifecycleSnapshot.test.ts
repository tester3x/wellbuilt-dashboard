import { applyInvoicePaperLifecycle, applyTicketPaperLifecycle } from '../lifecycle';
import { getWaterTicketPaper, materializeWaterTicketPaper } from '../engine';
import { MemoryPaperStore } from '../store';
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
  invoice20100,
  staffLg,
  ticket20100,
} from './fixture20100';

function seed(store = new MemoryPaperStore()) {
  store.tickets.set(TICKET_20100_ID, { ...ticket20100 });
  store.invoices.set(INVOICE_20100_ID, {
    ...invoice20100,
    photos: [...(invoice20100.photos as object[])],
  });
  store.identities.set(DRIVER_ZFOLD, { driverId: DRIVER_ZFOLD, legalName: 'Mike ZFold7 Burger' });
  store.liveAssets.set('https://storage.example/a.jpg', PIXEL_A);
  store.liveAssets.set('https://storage.example/b.jpg', PIXEL_B);
  store.liveAssets.set('https://storage.example/jsa.pdf', JSA_BYTES);
  return store;
}

describe('immutable source-event snapshot resume', () => {
  it('retry of edit A after live edit B finalizes A then B as distinct revisions', async () => {
    const store = seed();
    const close = await applyInvoicePaperLifecycle({
      store,
      invoiceId: INVOICE_20100_ID,
      before: { status: 'open' },
      after: { ...invoice20100, status: 'closed', closedAtMs: CLOSED_AT_MS } as Record<string, unknown>,
      nowMs: CLOSED_AT_MS,
    });
    expect(close.class).toBe('success');

    const ticketA = {
      ...ticket20100,
      pickupBbls: 80,
      dropoffBbls: 80,
      qty: '80',
      bbls: '80',
      updatedAt: CLOSED_AT_MS + 5_000,
    };
    store.tickets.set(TICKET_20100_ID, ticketA);
    store.failAt = 'html';
    const failA = await applyTicketPaperLifecycle({
      store,
      ticketId: TICKET_20100_ID,
      before: { ...ticket20100 } as Record<string, unknown>,
      after: ticketA as Record<string, unknown>,
      nowMs: CLOSED_AT_MS + 5_000,
    });
    expect(failA.class).toBe('retriable');
    expect(store.artifacts.get(waterTicketArtifactId(TICKET_20100_ID))?.currentRevisionId).toBe('r1');

    const ticketB = {
      ...ticketA,
      pickupBbls: 70,
      dropoffBbls: 70,
      qty: '70',
      bbls: '70',
      updatedAt: CLOSED_AT_MS + 9_000,
    };
    store.tickets.set(TICKET_20100_ID, ticketB);

    const retryA = await applyTicketPaperLifecycle({
      store,
      ticketId: TICKET_20100_ID,
      before: { ...ticket20100 } as Record<string, unknown>,
      after: ticketA as Record<string, unknown>,
      nowMs: CLOSED_AT_MS + 10_000,
    });
    expect(retryA.class).toBe('success');

    const gotA = await getWaterTicketPaper({
      store, caller: dispatchLg, lookup: { ticketDocId: TICKET_20100_ID }, revisionId: 'r2',
    });
    expect(gotA.ok && gotA.html).toContain('>80<');
    expect(gotA.ok && gotA.html).not.toContain('>70<');

    const doneB = await applyTicketPaperLifecycle({
      store,
      ticketId: TICKET_20100_ID,
      before: ticketA as Record<string, unknown>,
      after: ticketB as Record<string, unknown>,
      nowMs: CLOSED_AT_MS + 11_000,
    });
    expect(doneB.class).toBe('success');
    const current = await getWaterTicketPaper({ store, caller: dispatchLg, lookup: { ticketDocId: TICKET_20100_ID } });
    const oldA = await getWaterTicketPaper({
      store, caller: dispatchLg, lookup: { ticketDocId: TICKET_20100_ID }, revisionId: 'r2',
    });
    expect(current.ok && current.revisionId).toBe('r3');
    expect(current.ok && current.html).toContain('>70<');
    expect(oldA.ok && oldA.html).toContain('>80<');
    expect(oldA.ok && oldA.contentHash).not.toBe(current.ok ? current.contentHash : '');
  });

  it('delayed close retry cannot absorb a later ticket edit into r1', async () => {
    const store = seed();
    store.failAt = 'finalize';
    const failClose = await applyInvoicePaperLifecycle({
      store,
      invoiceId: INVOICE_20100_ID,
      before: { status: 'open' },
      after: { ...invoice20100, status: 'closed', closedAtMs: CLOSED_AT_MS } as Record<string, unknown>,
      nowMs: CLOSED_AT_MS,
    });
    expect(failClose.class).toBe('retriable');
    expect(store.revisions.size).toBe(0);

    store.tickets.set(TICKET_20100_ID, {
      ...ticket20100,
      pickupBbls: 55,
      dropoffBbls: 55,
      qty: '55',
      updatedAt: CLOSED_AT_MS + 3_000,
    });

    const retryClose = await applyInvoicePaperLifecycle({
      store,
      invoiceId: INVOICE_20100_ID,
      before: { status: 'open' },
      after: { ...invoice20100, status: 'closed', closedAtMs: CLOSED_AT_MS } as Record<string, unknown>,
      nowMs: CLOSED_AT_MS + 4_000,
    });
    expect(retryClose.class).toBe('success');
    const r1 = await getWaterTicketPaper({ store, caller: dispatchLg, lookup: { ticketDocId: TICKET_20100_ID } });
    expect(r1.ok && r1.revisionId).toBe('r1');
    expect(r1.ok && r1.html).toContain('>90<');
    expect(r1.ok && r1.html).not.toContain('>55<');
  });
});

describe('media readiness', () => {
  it('does not finalize a photo-less revision when an owned photo is temporarily unavailable', async () => {
    const store = new MemoryPaperStore();
    const ownUri = `https://storage.googleapis.com/wellbuilt-sync.appspot.com/photos/${COMPANY_LG}/${INVOICE_20100_ID}/own.jpg`;
    store.tickets.set(TICKET_20100_ID, { ...ticket20100 });
    store.invoices.set(INVOICE_20100_ID, {
      ...invoice20100,
      photos: [{ uri: ownUri, type: 'pickup', location: 'KAHUNA 2', takenAt: '2026-08-23T18:50:00.000Z' }],
    });
    store.identities.set(DRIVER_ZFOLD, { driverId: DRIVER_ZFOLD, legalName: 'Mike ZFold7 Burger' });

    const first = await materializeWaterTicketPaper({
      store, caller: staffLg, ticketDocId: TICKET_20100_ID, op: 'close', nowMs: CLOSED_AT_MS,
    });
    expect(first).toMatchObject({ ok: false, reason: 'asset_unavailable' });
    expect(store.revisions.size).toBe(0);

    store.liveAssets.set(ownUri, PIXEL_A);
    const retry = await materializeWaterTicketPaper({
      store, caller: staffLg, ticketDocId: TICKET_20100_ID, op: 'close', nowMs: CLOSED_AT_MS + 1,
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.revision.revisionId).toBe('r1');
    expect(retry.revision.projection.photos).toHaveLength(1);
    const got = await getWaterTicketPaper({ store, caller: dispatchLg, lookup: { ticketDocId: TICKET_20100_ID } });
    expect(got.ok && got.html).toContain('data:image/png;base64,');
    expect(store.revisions.size).toBe(1);
  });
});
