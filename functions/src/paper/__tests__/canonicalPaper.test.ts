import { authorizePaperMaterialize, authorizePaperRead, dashboardCanReadPaper } from '../access';
import { getWaterTicketPaper, materializeWaterTicketPaper } from '../engine';
import { formatTimeDisplay } from '../format';
import { hashExactBytes, utf8Bytes } from '../hash';
import { buildWaterTicketHtml, htmlContainsForbiddenInvoice, normalizePaperHtml } from '../html';
import { canonicalDriverIdFromRecords, resolveHumanAuditLabel } from '../identity';
import { splitLivePhotos } from '../photos';
import { isTicketOnlyWaterTicket, projectWaterTicket } from '../projection';
import { parseGetPaperRequest, parseMaterializeRequest } from '../requests';
import { deriveGovernedSourceEvent } from '../sourceEvent';
import { MemoryPaperStore } from '../store';
import { paperStorageHtmlPath, waterTicketArtifactId } from '../types';
import {
  CLOSED_AT_MS,
  COMPANY_LG,
  DRIVER_OTHER,
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
  store.identities.set(DRIVER_OTHER, {
    driverId: DRIVER_OTHER,
    legalName: 'Mike ZFold7 Burger',
    displayName: 'MikeS24',
  });
  store.liveAssets.set('https://storage.example/a.jpg', PIXEL_A);
  store.liveAssets.set('https://storage.example/b.jpg', PIXEL_B);
  store.liveAssets.set('https://storage.example/jsa.pdf', JSA_BYTES);
  return store;
}

function projectFixture() {
  const p = projectWaterTicket({
    ticket: ticket20100,
    invoice: invoice20100,
    legalName: 'Mike ZFold7 Burger',
    photos: [],
    paperTimeZone: 'America/Chicago',
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

describe('timezone policy', () => {
  it('formats UTC instants in America/Chicago with DST', () => {
    expect(formatTimeDisplay('2026-08-23T18:17:00.000Z', 'America/Chicago')).toBe('1:17 PM');
    expect(formatTimeDisplay('2026-01-15T18:17:00.000Z', 'America/Chicago')).toBe('12:17 PM');
  });
  it('uses explicit -05:00 wall clock, not UTC conversion', () => {
    expect(formatTimeDisplay('2026-08-23T18:17:00.000-05:00', 'America/Chicago')).toBe('6:17 PM');
  });
});

describe('projection #20100-style', () => {
  const p = projectFixture();
  it('maps canonical pickup fields without guessing in the renderer', () => {
    expect(p.operator).toBe('Kraken Oil & Gas');
    expect(p.pickupLocation).toBe('KAHUNA 2');
    expect(p.dropoffLocation).toBe('HYDRO CLEAR SWD');
    expect(p.invoiceDocId).toBe(INVOICE_20100_ID);
    expect(p.ownerDriverId).toBe(DRIVER_ZFOLD);
  });
  it('keeps pickup and drop-off BBL distinct', () => {
    const split = projectWaterTicket({
      ticket: { ...ticket20100, pickupBbls: 100, dropoffBbls: 0, qty: '100' },
      invoice: invoice20100,
      legalName: 'Mike ZFold7 Burger',
      photos: [],
    });
    if ('reason' in split) throw new Error(split.reason);
    expect(split.pickupBbls).toBe('100');
    expect(split.dropoffBbls).toBe('0');
  });
  it('accepted time uses governed timezone, never render time', () => {
    expect(p.acceptedTimeDisplay).toBe('1:17 PM');
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
  });
  it('prints no raw UUID or hash as a human label', () => {
    expect(html).not.toContain(DRIVER_ZFOLD);
  });
  it('omits empty truck/trailer rows', () => {
    const missing = projectWaterTicket({
      ticket: { ...ticket20100, truck: '', trailer: '' },
      invoice: { ...invoice20100, truckNumber: '', trailer: '' },
      legalName: 'Mike ZFold7 Burger',
      photos: [],
    });
    if ('reason' in missing) throw new Error(missing.reason);
    const h = buildWaterTicketHtml(missing);
    expect(h).not.toContain('Truck #');
    expect(h).not.toContain('Trailer #');
  });
  it('orders live photos by takenAt then type', () => {
    const { photos } = splitLivePhotos(invoice20100.photos);
    expect(photos.map((x) => x.uri)).toEqual([
      'https://storage.example/a.jpg',
      'https://storage.example/b.jpg',
    ]);
  });
  it('uses letter page geometry, not 4-inch thermal', () => {
    expect(html).toContain('size: letter');
    expect(html).not.toContain('384px');
  });
});

describe('identity resolver', () => {
  it('selects canonical UUID fields only, never names', () => {
    expect(canonicalDriverIdFromRecords({
      ownerDriverId: DRIVER_ZFOLD,
      submittedBy: DRIVER_OTHER,
    })).toBe(DRIVER_ZFOLD);
    expect(canonicalDriverIdFromRecords({ submittedBy: 'Mike ZFold7 Burger' })).toBe('');
  });
  it('never prints UUID, hash, or uid', () => {
    expect(resolveHumanAuditLabel({ historicalLabel: DRIVER_ZFOLD })).toBe('Unknown driver');
    expect(resolveHumanAuditLabel({ historicalLabel: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })).toBe('Unknown driver');
    expect(resolveHumanAuditLabel({ legalName: 'Mike ZFold7 Burger' })).toBe('Mike ZFold7 Burger');
  });
  it('duplicate legal names cannot select the wrong person', async () => {
    const store = seed();
    const created = await materializeWaterTicketPaper({
      store, caller: staffLg, ticketDocId: TICKET_20100_ID, op: 'close', nowMs: CLOSED_AT_MS,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.revision.ownerDriverId).toBe(DRIVER_ZFOLD);
    expect(created.revision.humanAuditLabel).toBe('Mike ZFold7 Burger');
    expect(created.revision.projection.driverDisplayName).not.toBe('MikeS24');
    const html = created.revision.projection.driverDisplayName;
    expect(html).toBe('Mike ZFold7 Burger');
  });
});

describe('authorization', () => {
  it('lets dispatch/viewer read without manageDrivers', () => {
    expect(dashboardCanReadPaper(dispatchLg)).toBe(true);
    expect(authorizePaperMaterialize(dispatchLg, COMPANY_LG).ok).toBe(false);
  });
  it('denies payroll read and driver materialize', () => {
    expect(dashboardCanReadPaper(payrollLg)).toBe(false);
    expect(authorizePaperMaterialize(driverOwner, COMPANY_LG)).toMatchObject({ ok: false, reason: 'drivers_cannot_materialize' });
  });
});

describe('requests reject client-authored events and authority', () => {
  it('rejects companyId and sourceEventId', () => {
    expect(parseGetPaperRequest({ ticketDocId: 't1', companyId: 'x' })).toMatchObject({ ok: false, reason: 'unexpected_field' });
    expect(parseMaterializeRequest({ ticketDocId: TICKET_20100_ID, op: 'close', sourceEventId: `edit:${TICKET_20100_ID}:x` }))
      .toMatchObject({ ok: false, reason: 'unexpected_field' });
  });
  it('requires close or edit op', () => {
    expect(parseMaterializeRequest({ ticketDocId: TICKET_20100_ID, op: 'close' }).ok).toBe(true);
    expect(parseMaterializeRequest({ ticketDocId: TICKET_20100_ID, op: 'hack' })).toMatchObject({ ok: false, reason: 'op_required' });
  });
  it('derives source events from persisted timestamps only', () => {
    const close = deriveGovernedSourceEvent({ ticket: ticket20100, invoice: invoice20100, op: 'close' });
    expect(close.ok).toBe(true);
    if (!close.ok) return;
    expect(close.sourceEventId).toBe(`close:${TICKET_20100_ID}:${CLOSED_AT_MS}`);
    const missing = deriveGovernedSourceEvent({ ticket: ticket20100, invoice: { ...invoice20100, closedAtMs: undefined, closedAt: undefined }, op: 'close' });
    expect(missing).toMatchObject({ ok: false, reason: 'event_not_found' });
    const noEdit = deriveGovernedSourceEvent({ ticket: ticket20100, invoice: invoice20100, op: 'edit' });
    expect(noEdit).toMatchObject({ ok: false, reason: 'event_not_found' });
  });
});

describe('materialize + get (Tickets vs Dispatch same bytes)', () => {
  const now = Date.parse('2026-08-24T00:00:00.000Z');

  it('Tickets ticketDocId and Dispatch invoiceDocId resolve identical artifact/revision/hash/bytes', async () => {
    const store = seed();
    const created = await materializeWaterTicketPaper({
      store, caller: staffLg, ticketDocId: TICKET_20100_ID, op: 'close', nowMs: now,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.artifact.artifactId).toBe(waterTicketArtifactId(TICKET_20100_ID));
    expect(created.artifact.invoiceDocId).toBe(INVOICE_20100_ID);
    expect(created.revision.revisionId).toBe('r1');
    expect(created.revision.storageHtmlPath).toBe(
      paperStorageHtmlPath(COMPANY_LG, created.artifact.artifactId, 'r1'),
    );

    const fromTickets = await getWaterTicketPaper({
      store, caller: dispatchLg, lookup: { ticketDocId: TICKET_20100_ID },
    });
    const fromDispatch = await getWaterTicketPaper({
      store, caller: dispatchLg, lookup: { invoiceDocId: INVOICE_20100_ID },
    });
    expect(fromTickets.ok && fromDispatch.ok).toBe(true);
    if (!fromTickets.ok || !fromDispatch.ok) return;
    expect(fromTickets.artifactId).toBe(fromDispatch.artifactId);
    expect(fromTickets.revisionId).toBe(fromDispatch.revisionId);
    expect(fromTickets.contentHash).toBe(fromDispatch.contentHash);
    expect(fromTickets.html).toBe(fromDispatch.html);
    expect(fromTickets.html).toContain('WATER TICKET');
    expect(fromTickets.html).toContain('Ticket #20100');
    expect(htmlContainsForbiddenInvoice(fromTickets.html)).toBe(false);
    expect(fromTickets.html).toContain('data:image/png;base64,');
    expect(fromTickets.html).toContain('paper-asset:');
    expect(fromTickets.html).not.toContain('https://storage.example/');
  });

  it('owner driver can read; other driver and payroll cannot', async () => {
    const store = seed();
    await materializeWaterTicketPaper({
      store, caller: staffLg, ticketDocId: TICKET_20100_ID, op: 'close', nowMs: now,
    });
    const own = await getWaterTicketPaper({ store, caller: driverOwner, lookup: { ticketDocId: TICKET_20100_ID } });
    const other = await getWaterTicketPaper({ store, caller: driverOther, lookup: { ticketDocId: TICKET_20100_ID } });
    const pay = await getWaterTicketPaper({ store, caller: payrollLg, lookup: { ticketDocId: TICKET_20100_ID } });
    expect(own.ok).toBe(true);
    expect(other).toMatchObject({ ok: false, reason: 'not_document_owner' });
    expect(pay).toMatchObject({ ok: false, reason: 'missing_capability' });
  });

  it('repeating the same governed close is idempotent', async () => {
    const store = seed();
    const a = await materializeWaterTicketPaper({ store, caller: staffLg, ticketDocId: TICKET_20100_ID, op: 'close', nowMs: now });
    const b = await materializeWaterTicketPaper({ store, caller: staffLg, ticketDocId: TICKET_20100_ID, op: 'close', nowMs: now + 5000 });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.action).toBe('created');
    expect(b.action).toBe('idempotent');
    expect(b.revision.revisionId).toBe('r1');
    expect(b.revision.contentHash).toBe(a.revision.contentHash);
  });

  it('a fabricated close without persisted close time fails closed', async () => {
    const store = seed();
    store.invoices.get(INVOICE_20100_ID)!.closedAtMs = undefined;
    store.invoices.get(INVOICE_20100_ID)!.closedAt = undefined;
    const missing = await materializeWaterTicketPaper({
      store, caller: staffLg, ticketDocId: TICKET_20100_ID, op: 'close', nowMs: now,
    });
    expect(missing).toMatchObject({ ok: false, reason: 'event_not_found' });
  });

  it('a changed governed edit produces r2 while r1 remains readable', async () => {
    const store = seed();
    const close = await materializeWaterTicketPaper({
      store, caller: staffLg, ticketDocId: TICKET_20100_ID, op: 'close', nowMs: now,
    });
    expect(close.ok).toBe(true);
    if (!close.ok) return;
    const t = store.tickets.get(TICKET_20100_ID)!;
    t.qty = '88';
    t.dropoffBbls = 88;
    t.updatedAt = { toMillis: () => now + 1 };
    const edit = await materializeWaterTicketPaper({
      store, caller: staffLg, ticketDocId: TICKET_20100_ID, op: 'edit', nowMs: now + 1,
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
      store, caller: staffLg, ticketDocId: TICKET_20100_ID, op: 'close', nowMs: now,
    });
    store.tickets.get(TICKET_20100_ID)!.qty = '70';
    store.tickets.get(TICKET_20100_ID)!.updatedAt = { toMillis: () => now + 2 };
    store.failAt = 'finalize';
    const failed = await materializeWaterTicketPaper({
      store, caller: staffLg, ticketDocId: TICKET_20100_ID, op: 'edit', nowMs: now + 2,
    });
    expect(failed.ok).toBe(false);
    expect(store.artifacts.get(waterTicketArtifactId(TICKET_20100_ID))?.currentRevisionId).toBe('r1');
  });

  it('stored revision remains readable after live ticket/invoice deletion', async () => {
    const store = seed();
    await materializeWaterTicketPaper({
      store, caller: staffLg, ticketDocId: TICKET_20100_ID, op: 'close', nowMs: now,
    });
    store.tickets.delete(TICKET_20100_ID);
    store.invoices.delete(INVOICE_20100_ID);
    const fromTicket = await getWaterTicketPaper({
      store, caller: dispatchLg, lookup: { ticketDocId: TICKET_20100_ID },
    });
    const fromInvoice = await getWaterTicketPaper({
      store, caller: dispatchLg, lookup: { invoiceDocId: INVOICE_20100_ID },
    });
    expect(fromTicket.ok && fromInvoice.ok).toBe(true);
    if (!fromTicket.ok || !fromInvoice.ok) return;
    expect(fromTicket.contentHash).toBe(fromInvoice.contentHash);
  });

  it('changing live photos does not change an existing revision', async () => {
    const store = seed();
    const created = await materializeWaterTicketPaper({
      store, caller: staffLg, ticketDocId: TICKET_20100_ID, op: 'close', nowMs: now,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    store.liveAssets.set('https://storage.example/a.jpg', PIXEL_B);
    const got = await getWaterTicketPaper({
      store, caller: staffLg, lookup: { ticketDocId: TICKET_20100_ID },
    });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.contentHash).toBe(created.revision.contentHash);
    expect(got.html).toContain('data:image/png;base64,');
    expect(JSON.stringify(created.revision.projection.photos).length).toBeLessThan(4000);
  });

  it('exact retrieved bytes are hashed without renormalizing', async () => {
    const store = seed();
    const created = await materializeWaterTicketPaper({
      store, caller: staffLg, ticketDocId: TICKET_20100_ID, op: 'close', nowMs: now,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const path = created.revision.storageHtmlPath;
    const original = await store.readHtmlBytes(path);
    expect(original).toBeTruthy();
    const crlf = Buffer.from(original!.toString('utf8').replace(/\n/g, '\r\n'), 'utf8');
    expect(hashExactBytes(crlf)).not.toBe(created.revision.contentHash);
    store.html.set(path, crlf);
    const failed = await getWaterTicketPaper({
      store, caller: staffLg, lookup: { ticketDocId: TICKET_20100_ID },
    });
    expect(failed).toMatchObject({ ok: false, reason: 'document_unavailable' });
    store.html.set(path, original!);
    const ok = await getWaterTicketPaper({
      store, caller: staffLg, lookup: { ticketDocId: TICKET_20100_ID },
    });
    expect(ok.ok).toBe(true);
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
      store, caller: staffLg, ticketDocId: TICKET_20100_ID, op: 'close', nowMs: now,
    });
    const denied = await getWaterTicketPaper({
      store, caller: staffOther, lookup: { ticketDocId: TICKET_20100_ID },
    });
    expect(denied).toMatchObject({ ok: false, reason: 'wrong_company' });
    const otherMat = await materializeWaterTicketPaper({
      store, caller: staffOther, ticketDocId: TICKET_20100_ID, op: 'close', nowMs: now,
    });
    expect(otherMat).toMatchObject({ ok: false, reason: 'wrong_company' });
    expect(authorizePaperRead(platformAdmin, {
      companyId: COMPANY_LG,
      ownerDriverId: DRIVER_ZFOLD,
    }).ok).toBe(true);
  });

  it('create-only HTML rejects different bytes at the same path', async () => {
    const store = seed();
    await store.createHtmlBytes('paper/x/document.html', utf8Bytes('a\n'));
    await expect(store.createHtmlBytes('paper/x/document.html', utf8Bytes('b\n'))).rejects.toThrow('immutable_overwrite');
    await store.createHtmlBytes('paper/x/document.html', utf8Bytes('a\n'));
  });
});

describe('concurrency: distinct events never share a revision identity', () => {
  const now = Date.parse('2026-08-24T00:00:00.000Z');

  it('concurrent close+edit allocate r1 and r2 without overwrite', async () => {
    const store = seed();
    store.tickets.get(TICKET_20100_ID)!.updatedAt = { toMillis: () => now + 9 };
    const [close, edit] = await Promise.all([
      materializeWaterTicketPaper({ store, caller: staffLg, ticketDocId: TICKET_20100_ID, op: 'close', nowMs: now }),
      materializeWaterTicketPaper({ store, caller: staffLg, ticketDocId: TICKET_20100_ID, op: 'edit', nowMs: now + 9 }),
    ]);
    expect(close.ok && edit.ok).toBe(true);
    if (!close.ok || !edit.ok) return;
    expect(new Set([close.revision.revisionId, edit.revision.revisionId]).size).toBe(2);
    const artifact = store.artifacts.get(close.artifact.artifactId);
    expect(artifact?.currentRevisionId).toBe(edit.revision.revisionId);
    const r1 = await store.getRevision(close.artifact.artifactId, close.revision.revisionId);
    const r2 = await store.getRevision(close.artifact.artifactId, edit.revision.revisionId);
    expect(r1 && r2).toBeTruthy();
    expect(r1!.sourceEventId).not.toBe(r2!.sourceEventId);
  });

  it('concurrent identical close events create exactly one revision', async () => {
    const store = seed();
    const [a, b] = await Promise.all([
      materializeWaterTicketPaper({ store, caller: staffLg, ticketDocId: TICKET_20100_ID, op: 'close', nowMs: now }),
      materializeWaterTicketPaper({ store, caller: staffLg, ticketDocId: TICKET_20100_ID, op: 'close', nowMs: now + 1 }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(new Set([a.revision.revisionId, b.revision.revisionId])).toEqual(new Set(['r1']));
    const created = [a, b].filter((x) => x.ok && x.action === 'created');
    const idempotent = [a, b].filter((x) => x.ok && x.action === 'idempotent');
    expect(created.length).toBe(1);
    expect(idempotent.length).toBe(1);
    expect(store.artifacts.get(waterTicketArtifactId(TICKET_20100_ID))?.currentRevisionId).toBe('r1');
  });
});
