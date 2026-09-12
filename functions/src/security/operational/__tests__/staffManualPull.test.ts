/**
 * Unit contract for the governed dispatcher/admin MANUAL pull core.
 * Pure — no emulator. Proves: company derived from caller (never client),
 * no driver impersonation, no commercial (ticket/invoice) projection context,
 * deterministic idempotency, and fail-closed validation.
 */
import {
  validateManualPull,
  buildManualPullPacket,
  assertNoCommercialProjection,
  manualPacketId,
  deriveIdempotencyKey,
  MANUAL_PULL_SERVICE_CATEGORIES,
} from '../staffManualPull';

const NOW = Date.parse('2026-09-12T18:00:00.000Z');
const ctx = (over: Partial<{ actorUid: string; companyId: string; nowMs: number }> = {}) => ({
  actorUid: 'staff-uid-1', companyId: 'liquid-gold', nowMs: NOW, ...over,
});
const good = () => ({
  wellName: 'Gabriel 3', tankLevelFeet: 9.5, bblsTaken: 140,
  dateTimeUTC: '2026-09-12T17:00:00.000Z', serviceCategory: 'hot_oiler',
  externalCompany: 'Acme Hot Oil', externalDriver: 'J. Ruiz', reason: 'washout recovery',
});

describe('validateManualPull — fail-closed, company from caller', () => {
  it('accepts a valid dispatcher manual pull', () => {
    const v = validateManualPull(good(), ctx());
    expect(v.ok).toBe(true);
  });
  it('rejects a client-supplied companyId override', () => {
    const v = validateManualPull({ ...good(), companyId: 'evil-co' } as never, ctx());
    expect(v).toMatchObject({ ok: false, reason: 'company_override_forbidden' });
  });
  it('rejects when the caller has no company', () => {
    expect(validateManualPull(good(), ctx({ companyId: '' }))).toMatchObject({ ok: false, reason: 'company_required' });
  });
  it('rejects missing/malformed well', () => {
    expect(validateManualPull({ ...good(), wellName: '' }, ctx())).toMatchObject({ ok: false, reason: 'wellName_invalid' });
    expect(validateManualPull({ ...good(), wellName: 'a/b' }, ctx())).toMatchObject({ ok: false, reason: 'wellName_malformed' });
  });
  it('rejects invalid level and barrels', () => {
    expect(validateManualPull({ ...good(), tankLevelFeet: -1 }, ctx())).toMatchObject({ ok: false, reason: 'tankLevelFeet_invalid' });
    expect(validateManualPull({ ...good(), bblsTaken: NaN }, ctx())).toMatchObject({ ok: false, reason: 'bblsTaken_invalid' });
  });
  it('rejects invalid and future event times (5-min skew)', () => {
    expect(validateManualPull({ ...good(), dateTimeUTC: 'not-a-date' }, ctx())).toMatchObject({ ok: false, reason: 'dateTimeUTC_invalid' });
    const future = new Date(NOW + 10 * 60 * 1000).toISOString();
    expect(validateManualPull({ ...good(), dateTimeUTC: future }, ctx())).toMatchObject({ ok: false, reason: 'dateTimeUTC_future' });
  });
  it('rejects an unknown service category; accepts each known one', () => {
    expect(validateManualPull({ ...good(), serviceCategory: 'bogus' }, ctx())).toMatchObject({ ok: false, reason: 'serviceCategory_invalid' });
    for (const c of MANUAL_PULL_SERVICE_CATEGORIES) {
      expect(validateManualPull({ ...good(), serviceCategory: c }, ctx()).ok).toBe(true);
    }
  });
});

describe('buildManualPullPacket — WB-M only, no impersonation, no commercial projection', () => {
  const built = () => {
    const v = validateManualPull(good(), ctx());
    if (!v.ok) throw new Error('fixture invalid');
    return buildManualPullPacket(v.value, ctx());
  };
  it('company comes from caller ctx, not client', () => {
    expect(built().packet.companyId).toBe('liquid-gold');
  });
  it('driver identity is a synthetic staff marker — never a real driver', () => {
    const p = built().packet;
    expect(p.driverId).toBe('manual:staff-uid-1');
    expect(String(p.driverName)).toMatch(/J\. Ruiz|Manual Entry/);
    expect(p.manualEntry).toBe(true);
    expect(p.staffActorUid).toBe('staff-uid-1');
  });
  it('is an ordinary pull with NO ticket/invoice/dispatch context', () => {
    const p = built().packet;
    expect(p.requestType).toBe('pull');
    for (const k of ['invoiceDocId', 'dispatchId', 'invoicingMode', 'originAppContext', 'createTicket', 'ticketNumber']) {
      expect(k in p).toBe(false);
    }
    expect(() => assertNoCommercialProjection(p)).not.toThrow();
  });
  it('preserves external company/driver/reason + service category', () => {
    const p = built().packet;
    expect(p.serviceCategory).toBe('hot_oiler');
    expect(p.externalCompany).toBe('Acme Hot Oil');
    expect(p.reason).toBe('washout recovery');
  });
  it('assertNoCommercialProjection throws if a forbidden field is injected', () => {
    const p = { ...built().packet, invoiceDocId: 'x' };
    expect(() => assertNoCommercialProjection(p)).toThrow(/manual_pull_forbidden_field:invoiceDocId/);
  });
  it('idempotent: identical input → identical packetId (retry safe)', () => {
    const a = built().packetId;
    const b = built().packetId;
    expect(a).toBe(b);
    expect(a.startsWith('manual_')).toBe(true);
  });
  it('deriveIdempotencyKey is stable + RTDB-safe', () => {
    const k = deriveIdempotencyKey({ wellName: 'Gabriel 3', dateTimeUTC: '2026-09-12T17:00:00.000Z', bblsTaken: 140, actorUid: 'staff-uid-1' });
    expect(k).toBe(deriveIdempotencyKey({ wellName: 'Gabriel 3', dateTimeUTC: '2026-09-12T17:00:00.000Z', bblsTaken: 140, actorUid: 'staff-uid-1' }));
    expect(k).not.toMatch(/[.$#[\]/]/);
    const v = validateManualPull(good(), ctx());
    expect(v.ok).toBe(true);
    if (v.ok) expect(manualPacketId(v.value)).toContain(k);
  });
});
