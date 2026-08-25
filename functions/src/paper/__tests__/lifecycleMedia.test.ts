import { formatDateDisplay, formatTimeDisplay } from '../format';
import { applyInvoicePaperLifecycle, applyTicketPaperLifecycle, classifyInvoicePaperChange, classifyTicketPaperChange, settlePaperLifecycle } from '../lifecycle';
import { MAX_CANONICAL_HTML_BYTES, makeLargePhonePhotoFixture } from '../media';
import { parseGovernedStorageUri } from '../storageUri';
import { getWaterTicketPaper, materializeWaterTicketPaper } from '../engine';
import { MemoryPaperStore } from '../store';
import { paperSourceFingerprint } from '../projection';
import { waterTicketArtifactId } from '../types';
import {
  CLOSED_AT_MS,
  COMPANY_LG,
  DRIVER_ZFOLD,
  INVOICE_20100_ID,
  JSA_BYTES,
  PIXEL_A,
  TICKET_20100_ID,
  dispatchLg,
  invoice20100,
  staffLg,
  ticket20100,
} from './fixture20100';

function seed() {
  const store = new MemoryPaperStore();
  store.tickets.set(TICKET_20100_ID, { ...ticket20100 });
  store.invoices.set(INVOICE_20100_ID, { ...invoice20100, photos: [...(invoice20100.photos as object[])] });
  store.identities.set(DRIVER_ZFOLD, { driverId: DRIVER_ZFOLD, legalName: 'Mike ZFold7 Burger' });
  const large = makeLargePhonePhotoFixture(7, 1200, 900);
  store.liveAssets.set('https://storage.googleapis.com/wellbuilt-sync.appspot.com/photos/a.png', large);
  store.liveAssets.set('https://storage.example/a.jpg', large);
  store.liveAssets.set('https://storage.example/b.jpg', large);
  store.liveAssets.set('https://storage.example/jsa.pdf', JSA_BYTES);
  return { store, large };
}

describe('lifecycle classification', () => {
  it('invoice close creates paper without a manager callable', async () => {
    const { store } = seed();
    store.invoices.get(INVOICE_20100_ID)!.closedAtMs = undefined;
    const before = { status: 'open' };
    const after = { ...store.invoices.get(INVOICE_20100_ID)!, status: 'closed', closedAt: { toMillis: () => CLOSED_AT_MS } };
    store.invoices.set(INVOICE_20100_ID, after as typeof invoice20100);
    const ran = await applyInvoicePaperLifecycle({
      store, invoiceId: INVOICE_20100_ID, before, after: after as Record<string, unknown>, nowMs: CLOSED_AT_MS,
    });
    expect(ran.op).toBe('close');
    const got = await getWaterTicketPaper({ store, caller: dispatchLg, lookup: { ticketDocId: TICKET_20100_ID } });
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.revisionId).toBe('r1');
  });

  it('governed measurement edit creates the next revision', async () => {
    const { store } = seed();
    await applyInvoicePaperLifecycle({
      store,
      invoiceId: INVOICE_20100_ID,
      before: { status: 'open' },
      after: { ...invoice20100, status: 'closed', closedAtMs: CLOSED_AT_MS } as Record<string, unknown>,
      nowMs: CLOSED_AT_MS,
    });
    const before = { ...ticket20100, pickupBbls: 90, dropoffBbls: 90 };
    const after = {
      ...ticket20100,
      pickupBbls: 88,
      dropoffBbls: 88,
      qty: '88',
      bbls: '88',
      updatedAt: { toMillis: () => CLOSED_AT_MS + 5000 },
    };
    store.tickets.set(TICKET_20100_ID, after);
    const ran = await applyTicketPaperLifecycle({
      store, ticketId: TICKET_20100_ID, before: before as Record<string, unknown>, after: after as Record<string, unknown>, nowMs: CLOSED_AT_MS + 5000,
    });
    expect(ran.op).toBe('edit');
    const got = await getWaterTicketPaper({ store, caller: dispatchLg, lookup: { ticketDocId: TICKET_20100_ID } });
    expect(got.ok && got.ok && got.revisionId === 'r2').toBe(true);
  });

  it('unrelated packetId/notes updates do not create paper', () => {
    expect(classifyInvoicePaperChange(
      { status: 'closed', closedAtMs: CLOSED_AT_MS, notes: 'a' },
      { status: 'closed', closedAtMs: CLOSED_AT_MS, notes: 'b' },
    )).toBe('none');
    expect(classifyTicketPaperChange(
      { bbls: '90', packetId: 'p1', updatedAt: { toMillis: () => 1 } },
      { bbls: '90', packetId: 'p2', updatedAt: { toMillis: () => 2 } },
    )).toBe('none');
  });
});

describe('governed storage URIs', () => {
  it('rejects arbitrary external URLs without fetching', () => {
    const r = parseGovernedStorageUri('https://evil.example/secret.jpg', { projectBucket: 'wellbuilt-sync.appspot.com' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unknown_host');
  });
  it('accepts WB-T photos/{companyId}/{invoiceDocId}/{photoId} paths', () => {
    const r = parseGovernedStorageUri(
      `https://storage.googleapis.com/wellbuilt-sync.appspot.com/photos/${COMPANY_LG}/${INVOICE_20100_ID}/a.jpg`,
      { projectBucket: 'wellbuilt-sync.appspot.com', companyId: COMPANY_LG, invoiceDocId: INVOICE_20100_ID },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.objectPath).toBe(`photos/${COMPANY_LG}/${INVOICE_20100_ID}/a.jpg`);
  });
  it('accepts WB-T legacy photos/{companyId}/{date}/{invoiceDocId}_ts.jpg paths', () => {
    const r = parseGovernedStorageUri(
      `gs://wellbuilt-sync.appspot.com/photos/${COMPANY_LG}/2026-08-23/${INVOICE_20100_ID}_171000.jpg`,
      { projectBucket: 'wellbuilt-sync.appspot.com', companyId: COMPANY_LG, invoiceDocId: INVOICE_20100_ID },
    );
    expect(r.ok).toBe(true);
  });
  it('rejects a photos/ prefix without company ownership', () => {
    const r = parseGovernedStorageUri(
      'https://storage.googleapis.com/wellbuilt-sync.appspot.com/photos/a.png',
      { projectBucket: 'wellbuilt-sync.appspot.com', companyId: COMPANY_LG },
    );
    expect(r).toMatchObject({ ok: false, reason: 'path_not_owned' });
  });
  it('rejects another company’s project-bucket photo', () => {
    const r = parseGovernedStorageUri(
      'https://storage.googleapis.com/wellbuilt-sync.appspot.com/photos/other-co/inv-x/secret.jpg',
      { projectBucket: 'wellbuilt-sync.appspot.com', companyId: COMPANY_LG, invoiceDocId: INVOICE_20100_ID },
    );
    expect(r).toMatchObject({ ok: false, reason: 'path_not_owned' });
  });
  it('rejects data URIs', () => {
    const r = parseGovernedStorageUri('data:image/png;base64,aaa', { projectBucket: 'wellbuilt-sync.appspot.com' });
    expect(r).toMatchObject({ ok: false, reason: 'data_uri_forbidden' });
  });
});

describe('bounded media', () => {
  it('large phone-photo fixtures stay out of Firestore metadata and inside HTML cap', async () => {
    const { store, large } = seed();
    expect(large.length).toBeGreaterThan(20_000);
    const ran = await applyInvoicePaperLifecycle({
      store,
      invoiceId: INVOICE_20100_ID,
      before: { status: 'open' },
      after: { ...invoice20100, status: 'closed', closedAtMs: CLOSED_AT_MS } as Record<string, unknown>,
      nowMs: CLOSED_AT_MS,
    });
    expect(ran.op).toBe('close');
    const got = await getWaterTicketPaper({ store, caller: dispatchLg, lookup: { ticketDocId: TICKET_20100_ID } });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(Buffer.byteLength(got.html, 'utf8')).toBeLessThan(MAX_CANONICAL_HTML_BYTES);
    expect(got.html).toContain('data:image/png;base64,');
    const meta = JSON.stringify(store.revisions.get(`${got.artifactId}/r1`)?.projection.photos);
    expect(meta).not.toContain(large.toString('base64').slice(0, 40));
    expect(meta.length).toBeLessThan(8000);
  });
});

describe('zoned date/time near UTC midnight', () => {
  it('uses America/Chicago calendar date with the Central clock', () => {
    const instant = '2026-01-01T05:30:00.000Z';
    expect(formatDateDisplay(instant, 'America/Chicago')).toBe('12/31/2025');
    expect(formatTimeDisplay(instant, 'America/Chicago')).toBe('11:30 PM');
  });
});

async function completedRevisions(store: MemoryPaperStore, ticketId = TICKET_20100_ID) {
  const artifactId = waterTicketArtifactId(ticketId);
  return [...store.revisions.values()].filter((r) => r.artifactId === artifactId);
}

describe('durable retry and partial-failure recovery', () => {
  async function retryCase(failAt: 'html' | 'asset' | 'finalize', failAfterAssetWrites = 0) {
    const { store } = seed();
    store.failAt = failAt;
    store.failAfterAssetWrites = failAfterAssetWrites;
    const first = await applyInvoicePaperLifecycle({
      store,
      invoiceId: INVOICE_20100_ID,
      before: { status: 'open' },
      after: { ...invoice20100, status: 'closed', closedAtMs: CLOSED_AT_MS } as Record<string, unknown>,
      nowMs: CLOSED_AT_MS,
    });
    expect(first.class).toBe('retriable');
    await expect(settlePaperLifecycle(first)).rejects.toThrow('paper_lifecycle_retry');
    const retry = await applyInvoicePaperLifecycle({
      store,
      invoiceId: INVOICE_20100_ID,
      before: { status: 'open' },
      after: { ...invoice20100, status: 'closed', closedAtMs: CLOSED_AT_MS } as Record<string, unknown>,
      nowMs: CLOSED_AT_MS + 1,
    });
    expect(retry.class).toBe('success');
    const revs = await completedRevisions(store);
    expect(revs).toHaveLength(1);
    expect(revs[0].revisionId).toBe('r1');
    expect(store.sourceEvents.get(revs[0].sourceEventId)?.status).toBe('complete');
  }

  it('failure before HTML then successful retry yields one revision', async () => {
    await retryCase('html');
  });
  it('failure after HTML then successful retry yields one revision', async () => {
    await retryCase('asset', 0);
  });
  it('failure after one asset then successful retry yields one revision', async () => {
    await retryCase('asset', 1);
  });
  it('failure before revision finalize then successful retry yields one revision', async () => {
    await retryCase('finalize');
  });
  it('does not treat ticket-only close {ok:false} as trigger success', async () => {
    const { store } = seed();
    store.failAt = 'html';
    const outcome = await applyInvoicePaperLifecycle({
      store,
      invoiceId: INVOICE_20100_ID,
      before: { status: 'open' },
      after: { ...invoice20100, status: 'closed', closedAtMs: CLOSED_AT_MS } as Record<string, unknown>,
      nowMs: CLOSED_AT_MS,
    });
    expect(outcome.class).toBe('retriable');
    expect(outcome.op).toBe('close');
    await expect(settlePaperLifecycle(outcome)).rejects.toThrow('paper_lifecycle_retry');
  });
  it('ignores non-ticket-only Field Invoices', async () => {
    const store = new MemoryPaperStore();
    const outcome = await applyInvoicePaperLifecycle({
      store,
      invoiceId: 'fi-1',
      before: { status: 'open' },
      after: { invoicingMode: 'invoice_tickets', invoiceNumber: 'LG-1', status: 'closed', closedAtMs: CLOSED_AT_MS, companyId: COMPANY_LG },
      nowMs: CLOSED_AT_MS,
    });
    expect(outcome).toMatchObject({ class: 'ignored', reason: 'not_ticket_only' });
    await expect(settlePaperLifecycle(outcome)).resolves.toMatchObject({ class: 'ignored' });
  });
  it('audits permanent failures without UUIDs in the thrown path', async () => {
    const { store } = seed();
    store.tickets.get(TICKET_20100_ID)!.ticketNumber = '';
    const audits: unknown[] = [];
    const outcome = await applyInvoicePaperLifecycle({
      store,
      invoiceId: INVOICE_20100_ID,
      before: { status: 'open' },
      after: { ...invoice20100, status: 'closed', closedAtMs: CLOSED_AT_MS } as Record<string, unknown>,
      nowMs: CLOSED_AT_MS,
    });
    expect(outcome.class).toBe('permanent');
    expect(outcome.reason).toBe('ticket_number_required');
    await settlePaperLifecycle(outcome, async (entry) => { audits.push(entry); });
    expect(audits).toEqual([expect.objectContaining({
      action: 'paperLifecyclePermanentFailure',
      detail: expect.objectContaining({
        ticketDocId: TICKET_20100_ID,
        invoiceDocId: INVOICE_20100_ID,
        companyId: COMPANY_LG,
        reason: 'ticket_number_required',
      }),
    })]);
    expect(JSON.stringify(audits[0])).not.toContain(DRIVER_ZFOLD);
  });
});

describe('write-order reconciliation', () => {
  it('ticket first, invoice close second converges to one r1', async () => {
    const store = new MemoryPaperStore();
    store.identities.set(DRIVER_ZFOLD, { driverId: DRIVER_ZFOLD, legalName: 'Mike ZFold7 Burger' });
    store.tickets.set(TICKET_20100_ID, { ...ticket20100 });
    const create = await applyTicketPaperLifecycle({
      store,
      ticketId: TICKET_20100_ID,
      before: null,
      after: { ...ticket20100 } as Record<string, unknown>,
      nowMs: CLOSED_AT_MS - 10,
    });
    expect(create.class).toBe('ignored');
    store.invoices.set(INVOICE_20100_ID, { ...invoice20100, status: 'closed' });
    const close = await applyInvoicePaperLifecycle({
      store,
      invoiceId: INVOICE_20100_ID,
      before: { status: 'open' },
      after: { ...invoice20100, status: 'closed', closedAtMs: CLOSED_AT_MS } as Record<string, unknown>,
      nowMs: CLOSED_AT_MS,
    });
    expect(close.class).toBe('success');
    expect(await completedRevisions(store)).toHaveLength(1);
  });

  it('invoice close first, ticket second converges to one r1', async () => {
    const store = new MemoryPaperStore();
    store.identities.set(DRIVER_ZFOLD, { driverId: DRIVER_ZFOLD, legalName: 'Mike ZFold7 Burger' });
    store.invoices.set(INVOICE_20100_ID, { ...invoice20100, status: 'closed' });
    const closeFirst = await applyInvoicePaperLifecycle({
      store,
      invoiceId: INVOICE_20100_ID,
      before: { status: 'open' },
      after: { ...invoice20100, status: 'closed', closedAtMs: CLOSED_AT_MS } as Record<string, unknown>,
      nowMs: CLOSED_AT_MS,
    });
    expect(closeFirst.class).toBe('pending_reconciliation');
    expect(await completedRevisions(store)).toHaveLength(0);
    store.tickets.set(TICKET_20100_ID, { ...ticket20100 });
    const ticketSecond = await applyTicketPaperLifecycle({
      store,
      ticketId: TICKET_20100_ID,
      before: null,
      after: { ...ticket20100 } as Record<string, unknown>,
      nowMs: CLOSED_AT_MS + 5,
    });
    expect(ticketSecond.class).toBe('success');
    expect(ticketSecond.op).toBe('close');
    expect(await completedRevisions(store)).toHaveLength(1);
    expect(store.artifacts.get(waterTicketArtifactId(TICKET_20100_ID))?.currentRevisionId).toBe('r1');
  });

  it('same-batch concurrent close and ticket create converge to one r1', async () => {
    const store = new MemoryPaperStore();
    store.identities.set(DRIVER_ZFOLD, { driverId: DRIVER_ZFOLD, legalName: 'Mike ZFold7 Burger' });
    store.tickets.set(TICKET_20100_ID, { ...ticket20100 });
    store.invoices.set(INVOICE_20100_ID, { ...invoice20100, status: 'closed' });
    const [a, b] = await Promise.all([
      applyInvoicePaperLifecycle({
        store,
        invoiceId: INVOICE_20100_ID,
        before: { status: 'open' },
        after: { ...invoice20100, status: 'closed', closedAtMs: CLOSED_AT_MS } as Record<string, unknown>,
        nowMs: CLOSED_AT_MS,
      }),
      applyTicketPaperLifecycle({
        store,
        ticketId: TICKET_20100_ID,
        before: null,
        after: { ...ticket20100 } as Record<string, unknown>,
        nowMs: CLOSED_AT_MS,
      }),
    ]);
    expect([a.class, b.class].some((c) => c === 'success')).toBe(true);
    expect(await completedRevisions(store)).toHaveLength(1);
  });

  it('duplicated trigger delivery is idempotent at r1', async () => {
    const { store } = seed();
    const first = await applyInvoicePaperLifecycle({
      store,
      invoiceId: INVOICE_20100_ID,
      before: { status: 'open' },
      after: { ...invoice20100, status: 'closed', closedAtMs: CLOSED_AT_MS } as Record<string, unknown>,
      nowMs: CLOSED_AT_MS,
    });
    const dup = await applyInvoicePaperLifecycle({
      store,
      invoiceId: INVOICE_20100_ID,
      before: { status: 'open' },
      after: { ...invoice20100, status: 'closed', closedAtMs: CLOSED_AT_MS } as Record<string, unknown>,
      nowMs: CLOSED_AT_MS + 50,
    });
    expect(first.class).toBe('success');
    expect(dup.class).toBe('success');
    expect(await completedRevisions(store)).toHaveLength(1);
  });

  it('first invoiceDocId linkage after a prior close materializes r1', async () => {
    const store = new MemoryPaperStore();
    store.identities.set(DRIVER_ZFOLD, { driverId: DRIVER_ZFOLD, legalName: 'Mike ZFold7 Burger' });
    store.invoices.set(INVOICE_20100_ID, { ...invoice20100, status: 'closed' });
    const unlinked = { ...ticket20100, invoiceDocId: '' };
    store.tickets.set(TICKET_20100_ID, unlinked);
    await applyTicketPaperLifecycle({
      store,
      ticketId: TICKET_20100_ID,
      before: null,
      after: unlinked as Record<string, unknown>,
      nowMs: CLOSED_AT_MS,
    });
    expect(await completedRevisions(store)).toHaveLength(0);
    store.tickets.set(TICKET_20100_ID, { ...ticket20100 });
    const linked = await applyTicketPaperLifecycle({
      store,
      ticketId: TICKET_20100_ID,
      before: unlinked as Record<string, unknown>,
      after: { ...ticket20100 } as Record<string, unknown>,
      nowMs: CLOSED_AT_MS + 1,
    });
    expect(linked.class).toBe('success');
    expect(await completedRevisions(store)).toHaveLength(1);
  });
});

describe('paper-visible edit coverage', () => {
  async function closeFirst(store: MemoryPaperStore) {
    await applyInvoicePaperLifecycle({
      store,
      invoiceId: INVOICE_20100_ID,
      before: { status: 'open' },
      after: { ...invoice20100, status: 'closed', closedAtMs: CLOSED_AT_MS } as Record<string, unknown>,
      nowMs: CLOSED_AT_MS,
    });
  }

  it('representative ticket visible edits create r2 and leave r1 readable', async () => {
    const { store } = seed();
    await closeFirst(store);
    const r1 = await getWaterTicketPaper({ store, caller: dispatchLg, lookup: { ticketDocId: TICKET_20100_ID } });
    expect(r1.ok && r1.revisionId).toBe('r1');
    const cases: Array<Partial<typeof ticket20100>> = [
      { date: '08/24/2026' },
      { operator: 'Other Operator' },
      { location: 'NEW WELL' },
      { hauledTo: 'OTHER SWD' },
      { driver: 'Pat Driver' },
      { truck: '999' },
      { trailer: 'T99' },
      { hours: '3.5' },
      { top: '13′0″' },
    ];
    let seq = 0;
    for (const patch of cases) {
      seq += 1;
      const editMs = CLOSED_AT_MS + seq * 1000;
      const before = { ...store.tickets.get(TICKET_20100_ID)! };
      const after = { ...before, ...patch, updatedAt: { toMillis: () => editMs } };
      store.tickets.set(TICKET_20100_ID, after);
      const ran = await applyTicketPaperLifecycle({
        store,
        ticketId: TICKET_20100_ID,
        before: before as Record<string, unknown>,
        after: after as Record<string, unknown>,
        nowMs: editMs,
      });
      expect({ patch, op: ran.op, class: ran.class }).toEqual({ patch, op: 'edit', class: 'success' });
    }
    const current = await getWaterTicketPaper({ store, caller: dispatchLg, lookup: { ticketDocId: TICKET_20100_ID } });
    const old = await getWaterTicketPaper({ store, caller: dispatchLg, lookup: { ticketDocId: TICKET_20100_ID }, revisionId: 'r1' });
    expect(current.ok && old.ok).toBe(true);
    if (!current.ok || !old.ok) return;
    expect(current.revisionId).not.toBe('r1');
    expect(old.revisionId).toBe('r1');
    expect(old.contentHash).not.toBe(current.contentHash);
    expect(old.html).toContain('KAHUNA 2');
  });

  it('invoice-visible post-close edit uses invoice_edit and becomes current', async () => {
    const { store } = seed();
    await closeFirst(store);
    const before = { ...store.invoices.get(INVOICE_20100_ID)! };
    const after = {
      ...before,
      operator: 'Edited Operator',
      wellName: 'EDIT WELL',
      hauledTo: 'EDIT SWD',
      totalBBL: 77,
      totalHours: 4,
      editedAt: { toMillis: () => CLOSED_AT_MS + 8000 },
    };
    store.invoices.set(INVOICE_20100_ID, after);
    expect(paperSourceFingerprint(null, before)).not.toBe(paperSourceFingerprint(null, after));
    const ran = await applyInvoicePaperLifecycle({
      store,
      invoiceId: INVOICE_20100_ID,
      before: before as Record<string, unknown>,
      after: after as Record<string, unknown>,
      nowMs: CLOSED_AT_MS + 8000,
    });
    expect(ran.class).toBe('success');
    expect(ran.op).toBe('edit');
    const current = await getWaterTicketPaper({ store, caller: dispatchLg, lookup: { ticketDocId: TICKET_20100_ID } });
    expect(current.ok && current.revisionId).toBe('r2');
    if (!current.ok) return;
    expect(current.html).toContain('>77<');
    expect(current.html).toContain('Total Hours');
    const event = [...store.sourceEvents.values()].find((e) => e.revisionId === 'r2');
    expect(event?.sourceEventId).toBe(`invoice_edit:${TICKET_20100_ID}:${CLOSED_AT_MS + 8000}`);
    const r1 = await getWaterTicketPaper({
      store, caller: dispatchLg, lookup: { ticketDocId: TICKET_20100_ID }, revisionId: 'r1',
    });
    expect(r1.ok && r1.html).toContain('>90<');
    expect(r1.ok && r1.contentHash).not.toBe(current.contentHash);
  });

  it('packetId still does not create a paper revision', () => {
    expect(classifyTicketPaperChange(
      { operator: 'A', packetId: 'p1', updatedAt: { toMillis: () => 1 } },
      { operator: 'A', packetId: 'p2', updatedAt: { toMillis: () => 2 } },
    )).toBe('none');
    expect(classifyInvoicePaperChange(
      { status: 'closed', closedAtMs: CLOSED_AT_MS, notes: 'a', packetId: 'p1' },
      { status: 'closed', closedAtMs: CLOSED_AT_MS, notes: 'b', packetId: 'p2' },
    )).toBe('none');
  });
});

describe('tenant asset ownership', () => {
  it('does not snapshot another company’s Storage photo', async () => {
    const store = new MemoryPaperStore();
    const otherUri = 'https://storage.googleapis.com/wellbuilt-sync.appspot.com/photos/other-co/inv-x/secret.jpg';
    const ownUri = `https://storage.googleapis.com/wellbuilt-sync.appspot.com/photos/${COMPANY_LG}/${INVOICE_20100_ID}/own.jpg`;
    store.tickets.set(TICKET_20100_ID, { ...ticket20100 });
    store.invoices.set(INVOICE_20100_ID, {
      ...invoice20100,
      photos: [
        { uri: otherUri, type: 'pickup', location: 'X', takenAt: '2026-08-23T18:50:00.000Z' },
        { uri: ownUri, type: 'dropoff', location: 'Y', takenAt: '2026-08-23T19:50:00.000Z' },
      ],
    });
    store.identities.set(DRIVER_ZFOLD, { driverId: DRIVER_ZFOLD, legalName: 'Mike ZFold7 Burger' });
    store.liveAssets.set(otherUri, PIXEL_A);
    store.liveAssets.set(ownUri, PIXEL_A);
    const created = await materializeWaterTicketPaper({
      store, caller: staffLg, ticketDocId: TICKET_20100_ID, op: 'close', nowMs: CLOSED_AT_MS,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.revision.projection.photos).toHaveLength(1);
    expect(JSON.stringify(created.revision.projection.photos)).not.toContain('other-co');
  });
});

