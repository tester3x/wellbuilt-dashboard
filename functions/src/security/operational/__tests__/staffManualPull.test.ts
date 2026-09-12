/**
 * Unit contract for the governed Dashboard Dispatch MANUAL pull core.
 * Pure — no emulator. Proves: company derived from caller (never client),
 * the dispatcher is recorded via actorType/dispatchActorUid and is NEVER a
 * driver (no driverId), external driver is display-only metadata, no commercial
 * (ticket/invoice/dispatch-invoicing) projection, deterministic idempotency,
 * and fail-closed validation.
 */
import {
  validateManualPull,
  buildManualPullPacket,
  assertNoCommercialProjection,
  manualPacketId,
  deriveIdempotencyKey,
  MANUAL_PULL_SERVICE_CATEGORIES,
  MANUAL_PULL_ACTOR_TYPE,
  MANUAL_PULL_SOURCE,
  MANUAL_PULL_ENTRY_KIND,
} from '../staffManualPull';

const NOW = Date.parse('2026-09-12T18:00:00.000Z');
const ctx = (over: Partial<{ actorUid: string; companyId: string; nowMs: number }> = {}) => ({
  actorUid: 'dispatcher-1', companyId: 'liquid-gold', nowMs: NOW, ...over,
});
const good = () => ({
  wellName: 'Gabriel 3', tankLevelFeet: 9.5, bblsTaken: 140,
  dateTimeUTC: '2026-09-12T17:00:00.000Z', serviceCategory: 'hot_oiler',
  externalCompany: 'Acme Hot Oil', externalDriver: 'J. Ruiz', reason: 'washout recovery',
});

describe('validateManualPull — fail-closed, company from caller', () => {
  it('accepts a valid dispatch manual pull', () => {
    expect(validateManualPull(good(), ctx()).ok).toBe(true);
  });
  it('rejects a client-supplied companyId override', () => {
    expect(validateManualPull({ ...good(), companyId: 'evil-co' } as never, ctx())).toMatchObject({ ok: false, reason: 'company_override_forbidden' });
  });
  it('rejects the invoicing-trigger dispatchId field (only linkedDispatchId allowed)', () => {
    expect(validateManualPull({ ...good(), dispatchId: 'D1' } as never, ctx())).toMatchObject({ ok: false, reason: 'dispatchId_forbidden' });
  });
  it('rejects when the caller has no company', () => {
    expect(validateManualPull(good(), ctx({ companyId: '' }))).toMatchObject({ ok: false, reason: 'company_required' });
  });
  it('rejects missing/malformed well, level, barrels, time, category', () => {
    expect(validateManualPull({ ...good(), wellName: '' }, ctx())).toMatchObject({ ok: false, reason: 'wellName_invalid' });
    expect(validateManualPull({ ...good(), wellName: 'a/b' }, ctx())).toMatchObject({ ok: false, reason: 'wellName_malformed' });
    expect(validateManualPull({ ...good(), tankLevelFeet: -1 }, ctx())).toMatchObject({ ok: false, reason: 'tankLevelFeet_invalid' });
    expect(validateManualPull({ ...good(), bblsTaken: NaN }, ctx())).toMatchObject({ ok: false, reason: 'bblsTaken_invalid' });
    expect(validateManualPull({ ...good(), dateTimeUTC: 'x' }, ctx())).toMatchObject({ ok: false, reason: 'dateTimeUTC_invalid' });
    expect(validateManualPull({ ...good(), dateTimeUTC: new Date(NOW + 10 * 60000).toISOString() }, ctx())).toMatchObject({ ok: false, reason: 'dateTimeUTC_future' });
    expect(validateManualPull({ ...good(), serviceCategory: 'bogus' }, ctx())).toMatchObject({ ok: false, reason: 'serviceCategory_invalid' });
    for (const c of MANUAL_PULL_SERVICE_CATEGORIES) expect(validateManualPull({ ...good(), serviceCategory: c }, ctx()).ok).toBe(true);
  });
  it('accepts an optional linkedDispatchId; rejects a malformed one', () => {
    expect(validateManualPull({ ...good(), linkedDispatchId: 'dispatch_123' }, ctx()).ok).toBe(true);
    expect(validateManualPull({ ...good(), linkedDispatchId: 'a/b' }, ctx())).toMatchObject({ ok: false, reason: 'linkedDispatchId_malformed' });
  });
});

describe('buildManualPullPacket — dispatch actor, no driver, no commercial projection', () => {
  const built = (over: Record<string, unknown> = {}) => {
    const v = validateManualPull({ ...good(), ...over }, ctx());
    if (!v.ok) throw new Error('fixture invalid');
    return buildManualPullPacket(v.value, ctx());
  };
  it('company from caller ctx; requestType pull', () => {
    const p = built().packet;
    expect(p.companyId).toBe('liquid-gold');
    expect(p.requestType).toBe('pull');
  });
  it('records the DISPATCHER via actorType/source/dispatchActorUid — NEVER a driver', () => {
    const p = built().packet;
    expect(p.actorType).toBe(MANUAL_PULL_ACTOR_TYPE);
    expect(p.source).toBe(MANUAL_PULL_SOURCE);
    expect(p.entryKind).toBe(MANUAL_PULL_ENTRY_KIND);
    expect(p.dispatchActorUid).toBe('dispatcher-1');
    expect(p.manualEntry).toBe(true);
    // no driver-shaped identity at all
    expect('driverId' in p).toBe(false);
    expect(String(p.driverName)).not.toMatch(/manual:/);
  });
  it('external driver/company are display-only metadata (audited separately from the dispatcher)', () => {
    const p = built().packet;
    expect(p.externalDriver).toBe('J. Ruiz');
    expect(p.externalCompany).toBe('Acme Hot Oil');
    expect(String(p.driverName)).toBe('J. Ruiz (external)');
    // with no external driver, a clearly non-driver label
    expect(String(built({ externalDriver: '' }).packet.driverName)).toBe('Dispatch Manual Entry');
  });
  it('carries NO ticket/invoice/dispatch-invoicing context and NO driverId', () => {
    const p = built().packet;
    for (const k of ['invoiceDocId', 'dispatchId', 'invoicingMode', 'originAppContext', 'createTicket', 'ticketNumber', 'driverId']) {
      expect(k in p).toBe(false);
    }
    expect(() => assertNoCommercialProjection(p)).not.toThrow();
  });
  it('optional dispatch link is recorded as linkedDispatchId (never the invoicing dispatchId)', () => {
    const p = built({ linkedDispatchId: 'dispatch_123' }).packet;
    expect(p.linkedDispatchId).toBe('dispatch_123');
    expect('dispatchId' in p).toBe(false);
  });
  it('assertNoCommercialProjection throws on any forbidden field incl. driverId', () => {
    expect(() => assertNoCommercialProjection({ ...built().packet, invoiceDocId: 'x' })).toThrow(/invoiceDocId/);
    expect(() => assertNoCommercialProjection({ ...built().packet, driverId: 'someone' })).toThrow(/driverId/);
  });
  it('idempotent: identical input → identical packetId; key stable + RTDB-safe', () => {
    expect(built().packetId).toBe(built().packetId);
    const k = deriveIdempotencyKey({ wellName: 'Gabriel 3', dateTimeUTC: '2026-09-12T17:00:00.000Z', bblsTaken: 140, actorUid: 'dispatcher-1' });
    expect(k).not.toMatch(/[.$#[\]/]/);
    const v = validateManualPull(good(), ctx());
    if (v.ok) expect(manualPacketId(v.value)).toContain(k);
  });
});
