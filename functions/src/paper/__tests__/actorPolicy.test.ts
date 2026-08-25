import {
  DRIVER_EDIT_WINDOW_MS,
  PAPER_ACTOR_POLICY_VERSION,
  assertActorMayMutateTicket,
  evaluatePaperPresentation,
} from '../actorPolicy';
import { MemoryPaperStore } from '../store';
import { resolvePaperPresentation } from '../presentation';
import { waterTicketArtifactId } from '../types';
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

describe('actor paper presentation — governed driver window', () => {
  it('closed job during driver 24h window is edit_form with optional preview', () => {
    const r = evaluatePaperPresentation({
      caller: driverOwner,
      ticket: ticket20100,
      invoice: closedInvoice,
      nowMs: CLOSED_AT_MS + 60 * 60 * 1000,
      artifact: { artifactId: waterTicketArtifactId(TICKET_20100_ID), currentRevisionId: 'r1' },
    });
    expect(r).toMatchObject({
      ok: true,
      mode: 'edit_form',
      canEdit: true,
      reason: 'driver_correction_window',
      previewAvailable: true,
      policyVersion: PAPER_ACTOR_POLICY_VERSION,
      revisionId: 'r1',
    });
  });

  it('same job after driver expiration is canonical_paper', () => {
    const r = evaluatePaperPresentation({
      caller: driverOwner,
      ticket: ticket20100,
      invoice: closedInvoice,
      nowMs: CLOSED_AT_MS + DRIVER_EDIT_WINDOW_MS,
      artifact: { artifactId: waterTicketArtifactId(TICKET_20100_ID), currentRevisionId: 'r1' },
    });
    expect(r).toMatchObject({
      ok: true,
      mode: 'canonical_paper',
      canEdit: false,
      reason: 'edit_window_expired',
      revisionId: 'r1',
    });
  });

  it('server nowMs, not a client clock, controls expiration', () => {
    const clientWouldSayOpen = CLOSED_AT_MS + 1000;
    const serverNow = CLOSED_AT_MS + DRIVER_EDIT_WINDOW_MS;
    const r = evaluatePaperPresentation({
      caller: driverOwner,
      ticket: ticket20100,
      invoice: closedInvoice,
      nowMs: serverNow,
    });
    expect(r.ok && r.mode).toBe('canonical_paper');
    expect(clientWouldSayOpen < serverNow).toBe(true);
  });

  it('open job the driver owns stays edit_form, not closed paper', () => {
    const r = evaluatePaperPresentation({
      caller: driverOwner,
      ticket: ticket20100,
      invoice: { ...invoice20100, closedAtMs: undefined, closedAt: undefined, status: 'open' },
      nowMs: CLOSED_AT_MS,
    });
    expect(r).toMatchObject({ ok: true, mode: 'edit_form', canEdit: true, reason: 'driver_open_job', previewAvailable: false });
  });

  it('read-only open job is read_only_detail', () => {
    const r = evaluatePaperPresentation({
      caller: { ...driverOther, driverId: DRIVER_OTHER },
      ticket: ticket20100,
      invoice: { ...invoice20100, closedAtMs: undefined, closedAt: undefined, status: 'open' },
      nowMs: CLOSED_AT_MS,
    });
    expect(r).toMatchObject({ ok: false, reason: 'not_document_owner', canEdit: false });
    const dashOpen = evaluatePaperPresentation({
      caller: dispatchLg,
      ticket: ticket20100,
      invoice: { ...invoice20100, closedAtMs: undefined, closedAt: undefined, status: 'open' },
      nowMs: CLOSED_AT_MS,
    });
    expect(dashOpen).toMatchObject({ ok: true, mode: 'read_only_detail', canEdit: false });
  });

  it('optional paper preview does not remove the editor during the driver window', () => {
    const r = evaluatePaperPresentation({
      caller: driverOwner,
      ticket: ticket20100,
      invoice: closedInvoice,
      nowMs: CLOSED_AT_MS + 1000,
      artifact: { artifactId: waterTicketArtifactId(TICKET_20100_ID), currentRevisionId: 'r1' },
    });
    expect(r.ok && r.mode).toBe('edit_form');
    expect(r.ok && r.canEdit).toBe(true);
    expect(r.ok && r.previewAvailable).toBe(true);
  });

  it('direct mutation is rejected after the driver window even if a client bypasses routing', () => {
    const allowed = assertActorMayMutateTicket({
      caller: driverOwner,
      ticket: ticket20100,
      invoice: closedInvoice,
      nowMs: CLOSED_AT_MS + 1000,
    });
    expect(allowed).toMatchObject({ ok: true, via: 'owner' });
    const denied = assertActorMayMutateTicket({
      caller: driverOwner,
      ticket: ticket20100,
      invoice: closedInvoice,
      nowMs: CLOSED_AT_MS + DRIVER_EDIT_WINDOW_MS,
    });
    expect(denied).toMatchObject({ ok: false, reason: 'edit_window_expired' });
  });
});

describe('actor paper presentation — missing later-stage policy', () => {
  it('does not invent a dispatch edit window after driver expiration', () => {
    const r = evaluatePaperPresentation({
      caller: dispatchLg,
      ticket: ticket20100,
      invoice: closedInvoice,
      nowMs: CLOSED_AT_MS + DRIVER_EDIT_WINDOW_MS + 1000,
      artifact: { artifactId: waterTicketArtifactId(TICKET_20100_ID), currentRevisionId: 'r1' },
    });
    expect(r).toMatchObject({
      ok: false,
      reason: 'policy_undefined',
      canEdit: false,
      gap: 'dispatch_ticket_edit_window',
    });
  });

  it('does not invent a payroll edit window after dispatch', () => {
    const r = evaluatePaperPresentation({
      caller: payrollLg,
      ticket: ticket20100,
      invoice: closedInvoice,
      nowMs: CLOSED_AT_MS + DRIVER_EDIT_WINDOW_MS + 1000,
    });
    expect(r).toMatchObject({
      ok: false,
      reason: 'policy_undefined',
      canEdit: false,
      gap: 'payroll_ticket_edit_window',
    });
  });

  it('dispatch mutation is denied until Mike decides a governed window', () => {
    expect(assertActorMayMutateTicket({
      caller: dispatchLg,
      ticket: ticket20100,
      invoice: closedInvoice,
      nowMs: CLOSED_AT_MS + DRIVER_EDIT_WINDOW_MS + 1000,
    })).toMatchObject({ ok: false, reason: 'policy_undefined' });
  });

  it('platform admin privileged correction remains edit_form (WB-T admin bypass)', () => {
    const r = evaluatePaperPresentation({
      caller: platformAdmin,
      ticket: ticket20100,
      invoice: closedInvoice,
      nowMs: CLOSED_AT_MS + DRIVER_EDIT_WINDOW_MS + 1000,
    });
    expect(r).toMatchObject({ ok: true, mode: 'edit_form', canEdit: true, reason: 'privileged_admin' });
  });
});

describe('resolvePaperPresentation uses server store + nowMs', () => {
  it('returns revision identity when paper applies after driver expiry', async () => {
    const store = new MemoryPaperStore();
    store.tickets.set(TICKET_20100_ID, { ...ticket20100 });
    store.invoices.set(INVOICE_20100_ID, closedInvoice);
    store.artifacts.set(waterTicketArtifactId(TICKET_20100_ID), {
      artifactId: waterTicketArtifactId(TICKET_20100_ID),
      artifactType: 'water_ticket',
      currentRevisionId: 'r1',
      nextRevisionSeq: 1,
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
    expect(r).toMatchObject({
      ok: true,
      mode: 'canonical_paper',
      revisionId: 'r1',
      canEdit: false,
    });
  });
});
