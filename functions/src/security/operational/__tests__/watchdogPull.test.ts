import {
  validateWatchdogPull,
  buildWatchdogPullPacket,
  assertNoCommercialProjection,
  type WatchdogPullInput,
  type WatchdogPullContext,
} from '../watchdogPull';

const NOW_MS = Date.parse('2026-09-12T22:00:00.000Z');
const COMPANY = 'liquid-gold';
const ACTOR = 'watchdog-service-principal';

function validContext(): WatchdogPullContext {
  return {
    actorUid: ACTOR,
    companyId: COMPANY,
    nowMs: NOW_MS,
  };
}

function validKahuna457(): WatchdogPullInput {
  return {
    packetId: '20260912_165700_Kahuna5_1ab68c',
    wellName: 'Kahuna 5',
    dateTimeUTC: '2026-09-12T21:57:00.000Z',
    dateTime: '9/12/2026 4:57 PM',
    timezone: 'America/Chicago',
    tankLevelFeet: 7.5,
    bblsTaken: 150,
    chat: 'WhatsApp Water Group',
    sender: '+17015551234',
    eventTimeLocal: '4:57 PM',
    top: 7.5,
    bottom: 6.7,
    explicitBbl: 150,
    parserVersion: 'v2.1.0',
    digest: 'sha256_mock_hash_457',
  };
}

describe('watchdogPull unit validation', () => {
  it('validates a verified Kahuna 5 4:57 PM pull successfully', () => {
    const ctx = validContext();
    const input = validKahuna457();
    const verdict = validateWatchdogPull(input, ctx);

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;

    expect(verdict.value.wellName).toBe('Kahuna 5');
    expect(verdict.value.packetId).toBe('20260912_165700_Kahuna5_1ab68c');
    expect(verdict.value.tankLevelFeet).toBe(7.5);
    expect(verdict.value.bblsTaken).toBe(150);
    expect(verdict.value.dateTimeUTC).toBe('2026-09-12T21:57:00.000Z');
    expect(verdict.value.watchdogProvenance).toMatchObject({
      chat: 'WhatsApp Water Group',
      sender: '+17015551234',
      eventTimeLocal: '4:57 PM',
      top: 7.5,
      bottom: 6.7,
      explicitBbl: 150,
      parserVersion: 'v2.1.0',
      digest: 'sha256_mock_hash_457',
    });
  });

  it('validates a verified Kahuna 5 5:48 PM pull (stagnation interval preserved)', () => {
    const ctx = validContext();
    const input: WatchdogPullInput = {
      packetId: '20260912_174800_Kahuna5_2cd94e',
      wellName: 'Kahuna 5',
      dateTimeUTC: '2026-09-12T22:48:00.000Z',
      dateTime: '9/12/2026 5:48 PM',
      timezone: 'America/Chicago',
      tankLevelFeet: 6.7,
      bblsTaken: 140,
      chat: 'WhatsApp Water Group',
      sender: '+17015551234',
      eventTimeLocal: '5:48 PM',
      top: 6.7,
      bottom: 6.0,
      explicitBbl: 140,
    };
    // nowMs is 5:50 PM UTC
    const verdict = validateWatchdogPull(input, { ...ctx, nowMs: Date.parse('2026-09-12T22:50:00.000Z') });

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.value.tankLevelFeet).toBe(6.7);
    expect(verdict.value.bblsTaken).toBe(140);
  });

  it('rejects client-supplied companyId override', () => {
    const ctx = validContext();
    const input = { ...validKahuna457(), companyId: 'rogue-company' };
    const verdict = validateWatchdogPull(input, ctx);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('company_override_forbidden');
  });

  it('rejects commercial fields (ticket, invoice, dispatch, driverId)', () => {
    const ctx = validContext();
    for (const bad of ['ticketNumber', 'invoiceDocId', 'dispatchId', 'driverId', 'createTicket', 'jid']) {
      const input = { ...validKahuna457(), [bad]: 'bad-commercial-val' };
      const verdict = validateWatchdogPull(input, ctx);
      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      expect(verdict.reason).toBe('commercial_fields_forbidden');
    }
  });

  it('rejects AFR override fields (observations only)', () => {
    const ctx = validContext();
    for (const bad of ['afr', 'flowRate', 'timeTillPull', 'bbls24hrs', 'nextPullTime', 'currentLevel']) {
      const input = { ...validKahuna457(), [bad]: 123 };
      const verdict = validateWatchdogPull(input, ctx);
      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      expect(verdict.reason).toBe('afr_fields_forbidden');
    }
  });

  it('rejects missing or unauthenticated context', () => {
    expect(validateWatchdogPull(validKahuna457(), { actorUid: '', companyId: COMPANY, nowMs: NOW_MS }).ok).toBe(false);
    expect(validateWatchdogPull(validKahuna457(), { actorUid: ACTOR, companyId: '', nowMs: NOW_MS }).ok).toBe(false);
  });

  it('rejects future timestamps beyond skew and implausibly old timestamps', () => {
    const ctx = validContext();
    // 10 min in the future (> 5 min skew)
    const future = { ...validKahuna457(), dateTimeUTC: new Date(NOW_MS + 10 * 60 * 1000).toISOString() };
    const resFuture = validateWatchdogPull(future, ctx);
    expect(resFuture.ok).toBe(false);
    if (!resFuture.ok) expect(resFuture.reason).toBe('dateTimeUTC_future');

    // 40 days in the past (> 30 days ceiling)
    const old = { ...validKahuna457(), dateTimeUTC: new Date(NOW_MS - 40 * 24 * 60 * 60 * 1000).toISOString() };
    const resOld = validateWatchdogPull(old, ctx);
    expect(resOld.ok).toBe(false);
    if (!resOld.ok) expect(resOld.reason).toBe('dateTimeUTC_implausibly_old');
  });

  it('rejects packetId / wellName mismatch', () => {
    const ctx = validContext();
    const mismatch = { ...validKahuna457(), packetId: '20260912_165700_DifferentWell_1ab68c' };
    const verdict = validateWatchdogPull(mismatch, ctx);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('packetId_well_mismatch');
  });

  it('rejects malformed packetId shape', () => {
    const ctx = validContext();
    const badShape = { ...validKahuna457(), packetId: 'random_id_123' };
    const verdict = validateWatchdogPull(badShape, ctx);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('packetId_shape_invalid');
  });

  it('buildWatchdogPullPacket stamps canonical fields and enforces zero driver/commercial projection', () => {
    const ctx = validContext();
    const verdict = validateWatchdogPull(validKahuna457(), ctx);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;

    const { packetId, packet } = buildWatchdogPullPacket(verdict.value, ctx);
    expect(packetId).toBe('20260912_165700_Kahuna5_1ab68c');
    expect(packet.companyId).toBe(COMPANY);
    expect(packet.requestType).toBe('pull');
    expect(packet.source).toBe('watchdog');
    expect(packet.origin).toBe('watchdog-sidecar');
    expect(packet.driverName).toBe('WhatsApp Watchdog');
    expect('driverId' in packet).toBe(false);
    expect('ticketNumber' in packet).toBe(false);
    expect('invoiceDocId' in packet).toBe(false);

    expect(() => assertNoCommercialProjection(packet)).not.toThrow();
  });
});
