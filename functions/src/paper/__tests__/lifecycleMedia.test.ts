import { formatDateDisplay, formatTimeDisplay } from '../format';
import { applyInvoicePaperLifecycle, applyTicketPaperLifecycle, classifyInvoicePaperChange, classifyTicketPaperChange } from '../lifecycle';
import { MAX_CANONICAL_HTML_BYTES, makeLargePhonePhotoFixture } from '../media';
import { parseGovernedStorageUri } from '../storageUri';
import { getWaterTicketPaper } from '../engine';
import { MemoryPaperStore } from '../store';
import {
  CLOSED_AT_MS,
  COMPANY_LG,
  DRIVER_ZFOLD,
  INVOICE_20100_ID,
  JSA_BYTES,
  TICKET_20100_ID,
  dispatchLg,
  invoice20100,
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
    const before = { ...ticket20100, bbls: '90' };
    const after = { ...ticket20100, bbls: '88', qty: '88', updatedAt: { toMillis: () => CLOSED_AT_MS + 5000 } };
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
  it('accepts project Storage paths', () => {
    const r = parseGovernedStorageUri(
      'https://storage.googleapis.com/wellbuilt-sync.appspot.com/photos/a.png',
      { projectBucket: 'wellbuilt-sync.appspot.com' },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.objectPath).toBe('photos/a.png');
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
