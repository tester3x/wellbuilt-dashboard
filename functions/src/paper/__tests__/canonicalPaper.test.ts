import { authorizePaperCompany } from '../access';
import { getWaterTicketPaper, materializeWaterTicketPaper } from '../engine';
import { asTrimmedString } from '../format';
import { contentHashForHtml } from '../hash';
import { buildWaterTicketHtml, htmlContainsForbiddenInvoice, normalizePaperHtml } from '../html';
import { resolveHumanAuditLabel } from '../identity';
import { splitPhotos } from '../photos';
import { isTicketOnlyWaterTicket, projectWaterTicket } from '../projection';
import { parseGetPaperRequest, parseMaterializeRequest } from '../requests';
import { MemoryPaperStore } from '../store';
import { paperStorageHtmlPath, waterTicketArtifactId } from '../types';
import {
  COMPANY_LG,
  INVOICE_20100_ID,
  TICKET_20100_ID,
  invoice20100,
  platformAdmin,
  staffLg,
  staffOther,
  ticket20100,
} from './fixture20100';

function seed(store = new MemoryPaperStore()) {
  store.tickets.set(TICKET_20100_ID, { ...ticket20100 });
  store.invoices.set(INVOICE_20100_ID, {
    ...invoice20100,
    timeline: [...(invoice20100.timeline as object[])],
    photos: [...(invoice20100.photos as object[])],
  });
  store.names.set('Mike ZFold7 Burger', {
    legalName: 'Mike ZFold7 Burger',
    displayName: 'Mikezfold',
  });
  return store;
}

function projectFixture() {
  const p = projectWaterTicket({
    ticket: ticket20100,
    invoice: invoice20100,
    legalName: 'Mike ZFold7 Burger',
  });
  if ('reason' in p) throw new Error(p.reason);
  return p;
}

describe('ticket-only classification', () => {
  it('empty invoiceNumber remains a Water Ticket', () => {
    expect(isTicketOnlyWaterTicket(ticket20100, invoice20100)).toBe(true);
    expect(isTicketOnlyWaterTicket(ticket20100, { id: 'x', invoiceNumber: '', invoicingMode: undefined })).toBe(true);
  });
  it('invoice_tickets is not this slice', () => {
    expect(isTicketOnlyWaterTicket(ticket20100, { id: 'x', invoicingMode: 'invoice_tickets', invoiceNumber: 'LG-1' })).toBe(false);
  });
});

describe('projection #20100-style', () => {
  const p = projectFixture();
  it('maps canonical pickup fields without guessing in the renderer', () => {
    expect(p.operator).toBe('Kraken Oil & Gas');
    expect(p.pickupLocation).toBe('KAHUNA 2');
    expect(p.dropoffLocation).toBe('HYDRO CLEAR SWD');
  });
  it('keeps pickup and drop-off BBL distinct', () => {
    const split = projectWaterTicket({
      ticket: { ...ticket20100, pickupBbls: 100, dropoffBbls: 0, qty: '100' },
      invoice: invoice20100,
      legalName: 'Mike ZFold7 Burger',
    });
    if ('reason' in split) throw new Error(split.reason);
    expect(split.pickupBbls).toBe('100');
    expect(split.dropoffBbls).toBe('0');
  });
  it('accepted time comes from invoiceStartedAt, never render time', () => {
    expect(p.acceptedTimeDisplay).toBe('6:17 PM');
    const later = projectWaterTicket({
      ticket: ticket20100,
      invoice: invoice20100,
      legalName: 'Mike ZFold7 Burger',
    });
    if ('reason' in later) throw new Error(later.reason);
    expect(later.acceptedTimeDisplay).toBe(p.acceptedTimeDisplay);
  });
  it('uses legal name and ignores submittedBy UUID', () => {
    expect(p.driverDisplayName).toBe('Mike ZFold7 Burger');
    expect(p.auditSubmittedBy).toBe('Mike ZFold7 Burger');
  });
});

describe('HTML generator', () => {
  const p = projectFixture();
  const html = normalizePaperHtml(buildWaterTicketHtml(p));

  it('titles WATER TICKET and Ticket #20100', () => {
    expect(html).toContain('WATER TICKET');
    expect(html).toContain('Ticket #20100');
  });
  it('contains no INVOICE and no Invoice # --', () => {
    expect(htmlContainsForbiddenInvoice(html)).toBe(false);
    expect(html).not.toMatch(/Invoice #/);
    expect(html).not.toContain('Invoice # --');
  });
  it('is deterministic', () => {
    const html2 = normalizePaperHtml(buildWaterTicketHtml(p));
    expect(contentHashForHtml(html)).toBe(contentHashForHtml(html2));
    expect(html).toBe(html2);
  });
  it('includes measurements, timeline, photos, totals, audit', () => {
    expect(html).toContain('Pickup BBL');
    expect(html).toContain('Drop-off BBL');
    expect(html).toContain('12′1″');
    expect(html).toContain('7′8″');
    expect(html).toContain('Job Timeline');
    expect(html).toContain('Pickup Arrival');
    expect(html).toContain('Photos (2)');
    expect(html).toContain('https://storage.example/a.jpg');
    expect(html).toContain('Signed JSA PDF');
    expect(html).toContain('Total BBL');
    expect(html).toContain('Submitted by: Mike ZFold7 Burger');
  });
  it('prints no raw UUID or hash as a human label', () => {
    expect(html).not.toContain('2cad521c-13ac-4b6c-b1ab-07843c6bf06f');
  });
  it('omits empty truck/trailer rows', () => {
    const missing = projectWaterTicket({
      ticket: { ...ticket20100, truck: '', trailer: '' },
      invoice: { ...invoice20100, truckNumber: '', trailer: '' },
      legalName: 'Mike ZFold7 Burger',
    });
    if ('reason' in missing) throw new Error(missing.reason);
    const h = buildWaterTicketHtml(missing);
    expect(h).not.toContain('Truck #');
    expect(h).not.toContain('Trailer #');
  });
  it('orders photos by takenAt then type', () => {
    const { photos } = splitPhotos(invoice20100.photos);
    expect(photos.map((x) => x.uri)).toEqual([
      'https://storage.example/a.jpg',
      'https://storage.example/b.jpg',
    ]);
    const idxA = html.indexOf('a.jpg');
    const idxB = html.indexOf('b.jpg');
    expect(idxA).toBeGreaterThan(0);
    expect(idxA).toBeLessThan(idxB);
  });
  it('orders timeline by timestamp', () => {
    expect(p.timeline.map((e) => e.type)).toEqual([
      'depart', 'arrive', 'depart_site', 'arrive', 'depart_site', 'close',
    ]);
  });
  it('uses letter page geometry, not 4-inch thermal', () => {
    expect(html).toContain('size: letter');
    expect(html).not.toContain('384px');
  });
});

describe('identity resolver', () => {
  it('never prints UUID, hash, or uid', () => {
    expect(resolveHumanAuditLabel({ submittedBy: '2cad521c-13ac-4b6c-b1ab-07843c6bf06f' })).toBe('Unknown driver');
    expect(resolveHumanAuditLabel({ submittedBy: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })).toBe('Unknown driver');
    expect(resolveHumanAuditLabel({ driverField: 'Mike ZFold7 Burger' })).toBe('Mike ZFold7 Burger');
  });
});

describe('requests reject client-supplied authority', () => {
  it('rejects companyId and ownership fields on get', () => {
    expect(parseGetPaperRequest({ ticketDocId: 't1', companyId: 'x' })).toMatchObject({ ok: false, reason: 'unexpected_field' });
    expect(parseGetPaperRequest({ ticketDocId: 't1', artifactId: 'wt:t1' })).toMatchObject({ ok: false, reason: 'unexpected_field' });
  });
  it('rejects companyId on materialize', () => {
    expect(parseMaterializeRequest({ ticketDocId: TICKET_20100_ID, sourceEventId: `close:${TICKET_20100_ID}:1`, companyId: COMPANY_LG }))
      .toMatchObject({ ok: false, reason: 'unexpected_field' });
  });
  it('requires sourceEventId to include ticketDocId', () => {
    expect(parseMaterializeRequest({ ticketDocId: TICKET_20100_ID, sourceEventId: 'close:other:1' }))
      .toMatchObject({ ok: false, reason: 'source_event_mismatch' });
  });
});

describe('materialize + get (Tickets vs Dispatch same bytes)', () => {
  const now = Date.parse('2026-08-24T00:00:00.000Z');

  it('Tickets ticketDocId and Dispatch invoiceDocId resolve identical artifact/revision/hash/bytes', async () => {
    const store = seed();
    const created = await materializeWaterTicketPaper({
      store, caller: staffLg, ticketDocId: TICKET_20100_ID,
      sourceEventId: `close:${TICKET_20100_ID}:2026-08-23T20:10:00.000Z`,
      nowMs: now,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.artifact.artifactId).toBe(waterTicketArtifactId(TICKET_20100_ID));
    expect(created.revision.revisionId).toBe('r1');
    expect(created.revision.storageHtmlPath).toBe(
      paperStorageHtmlPath(COMPANY_LG, created.artifact.artifactId, 'r1'),
    );

    const fromTickets = await getWaterTicketPaper({
      store, caller: staffLg, lookup: { ticketDocId: TICKET_20100_ID },
    });
    const fromDispatch = await getWaterTicketPaper({
      store, caller: staffLg, lookup: { invoiceDocId: INVOICE_20100_ID },
    });
    expect(fromTickets.ok && fromDispatch.ok).toBe(true);
    if (!fromTickets.ok || !fromDispatch.ok) return;
    expect(fromTickets.artifactId).toBe(fromDispatch.artifactId);
    expect(fromTickets.revisionId).toBe(fromDispatch.revisionId);
    expect(fromTickets.contentHash).toBe(fromDispatch.contentHash);
    expect(fromTickets.html).toBe(fromDispatch.html);
    expect(fromTickets.artifactType).toBe('water_ticket');
    expect(fromTickets.displayNumber).toBe('20100');
    expect(fromTickets.html).toContain('WATER TICKET');
    expect(fromTickets.html).toContain('Ticket #20100');
    expect(htmlContainsForbiddenInvoice(fromTickets.html)).toBe(false);
  });

  it('repeating the same governed event is idempotent', async () => {
    const store = seed();
    const event = `close:${TICKET_20100_ID}:2026-08-23T20:10:00.000Z`;
    const a = await materializeWaterTicketPaper({ store, caller: staffLg, ticketDocId: TICKET_20100_ID, sourceEventId: event, nowMs: now });
    const b = await materializeWaterTicketPaper({ store, caller: staffLg, ticketDocId: TICKET_20100_ID, sourceEventId: event, nowMs: now + 5000 });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.action).toBe('created');
    expect(b.action).toBe('idempotent');
    expect(b.revision.revisionId).toBe('r1');
    expect(b.revision.contentHash).toBe(a.revision.contentHash);
    expect(store.artifacts.get(a.artifact.artifactId)?.currentRevisionId).toBe('r1');
  });

  it('a changed governed edit produces r2 while r1 remains readable', async () => {
    const store = seed();
    const close = await materializeWaterTicketPaper({
      store, caller: staffLg, ticketDocId: TICKET_20100_ID,
      sourceEventId: `close:${TICKET_20100_ID}:t1`, nowMs: now,
    });
    expect(close.ok).toBe(true);
    if (!close.ok) return;
    const t = store.tickets.get(TICKET_20100_ID)!;
    t.qty = '88';
    t.dropoffBbls = 88;
    const edit = await materializeWaterTicketPaper({
      store, caller: staffLg, ticketDocId: TICKET_20100_ID,
      sourceEventId: `edit:${TICKET_20100_ID}:t2`, nowMs: now + 1,
    });
    expect(edit.ok).toBe(true);
    if (!edit.ok) return;
    expect(edit.revision.revisionId).toBe('r2');
    expect(store.artifacts.get(close.artifact.artifactId)?.currentRevisionId).toBe('r2');
    const r1 = await getWaterTicketPaper({
      store, caller: staffLg, lookup: { ticketDocId: TICKET_20100_ID }, revisionId: 'r1',
    });
    const current = await getWaterTicketPaper({
      store, caller: staffLg, lookup: { ticketDocId: TICKET_20100_ID },
    });
    expect(r1.ok && current.ok).toBe(true);
    if (!r1.ok || !current.ok) return;
    expect(r1.revisionId).toBe('r1');
    expect(current.revisionId).toBe('r2');
    expect(r1.html).toContain('>90<');
    expect(current.html).toContain('>88<');
    expect(r1.contentHash).not.toBe(current.contentHash);
  });

  it('currentRevisionId changes only after complete persistence', async () => {
    const store = seed();
    await materializeWaterTicketPaper({
      store, caller: staffLg, ticketDocId: TICKET_20100_ID,
      sourceEventId: `close:${TICKET_20100_ID}:t1`, nowMs: now,
    });
    store.tickets.get(TICKET_20100_ID)!.qty = '70';
    store.failAt = 'artifact';
    const failed = await materializeWaterTicketPaper({
      store, caller: staffLg, ticketDocId: TICKET_20100_ID,
      sourceEventId: `edit:${TICKET_20100_ID}:t2`, nowMs: now + 1,
    });
    expect(failed.ok).toBe(false);
    expect(store.artifacts.get(waterTicketArtifactId(TICKET_20100_ID))?.currentRevisionId).toBe('r1');
    const current = await getWaterTicketPaper({
      store, caller: staffLg, lookup: { ticketDocId: TICKET_20100_ID },
    });
    expect(current.ok).toBe(true);
    if (!current.ok) return;
    expect(current.revisionId).toBe('r1');
  });

  it('missing canonical document fails closed', async () => {
    const store = seed();
    const missing = await getWaterTicketPaper({
      store, caller: staffLg, lookup: { ticketDocId: TICKET_20100_ID },
    });
    expect(missing).toMatchObject({ ok: false, reason: 'document_unavailable', message: 'Document unavailable.' });
  });

  it('unauthorized users cannot resolve another company’s artifact', async () => {
    const store = seed();
    await materializeWaterTicketPaper({
      store, caller: staffLg, ticketDocId: TICKET_20100_ID,
      sourceEventId: `close:${TICKET_20100_ID}:t1`, nowMs: now,
    });
    const denied = await getWaterTicketPaper({
      store, caller: staffOther, lookup: { ticketDocId: TICKET_20100_ID },
    });
    expect(denied).toMatchObject({ ok: false, reason: 'wrong_company' });
    const otherMat = await materializeWaterTicketPaper({
      store, caller: staffOther, ticketDocId: TICKET_20100_ID,
      sourceEventId: `edit:${TICKET_20100_ID}:hack`, nowMs: now,
    });
    expect(otherMat).toMatchObject({ ok: false, reason: 'wrong_company' });
    expect(authorizePaperCompany(platformAdmin, COMPANY_LG).ok).toBe(true);
  });
});

describe('helpers', () => {
  it('asTrimmedString and artifact id', () => {
    expect(asTrimmedString('  20100 ')).toBe('20100');
    expect(waterTicketArtifactId('abc')).toBe('wt:abc');
  });
});
