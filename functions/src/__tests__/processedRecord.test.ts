// Proof that the REAL production construct-and-strip step (extracted verbatim
// from processIncomingPull and now called by it) preserves recovery provenance.
import { buildProcessedRecord, type ProcessedComputedFields } from '../processedRecord';

const computed: ProcessedComputedFields = {
  packetId: '20260827_140000_Gabriel5_rcv001',
  tankTopInches: 84, tankAfterInches: 48, tankAfterFeet: "4'0\"",
  timeDif: '6:37', timeDifDays: 0.2763, recoveryInches: 13,
  flowRate: '6:07:17', flowRateDays: 0.255, recoveryNeeded: 12,
  estTimeToPull: '5:00', estDateTimePull: '2026-08-27T05:39:00.000Z',
  processedAt: '2026-08-27T00:39:05.000Z',
};

const incoming = () => ({
  packetId: '20260827_140000_Gabriel5_rcv001',
  requestType: 'pull',
  wellName: 'Gabriel 5',
  driverId: '2cad521c-13ac-4b6c-b1ab-07843c6bf06f',
  companyId: 'liquid-gold',
  dateTimeUTC: '2026-08-27T00:39:00.000Z',
  tankLevelFeet: 7,
  bblsTaken: 60,
  wellDown: false,
  timezone: 'America/Chicago',
  recoveredFromPacketId: '20260827_062211_Gabriel5_lbuegt', // provenance
});

describe('buildProcessedRecord — the real processed-record construction', () => {
  test('PRESERVES recoveredFromPacketId provenance onto the processed record', () => {
    const rec = buildProcessedRecord(incoming(), computed);
    expect(rec.recoveredFromPacketId).toBe('20260827_062211_Gabriel5_lbuegt');
  });

  test('preserves other passthrough identity fields', () => {
    const rec = buildProcessedRecord(incoming(), computed);
    expect(rec.driverId).toBe('2cad521c-13ac-4b6c-b1ab-07843c6bf06f');
    expect(rec.companyId).toBe('liquid-gold');
    expect(rec.wellName).toBe('Gabriel 5');
    expect(rec.timezone).toBe('America/Chicago');
    expect(rec.requestType).toBe('pull');
  });

  test('computed fields overlay the incoming values', () => {
    const rec = buildProcessedRecord(incoming(), computed);
    expect(rec.tankTopInches).toBe(84);
    expect(rec.tankAfterInches).toBe(48);
    expect(rec.recoveryInches).toBe(13);
    expect(rec.processedAt).toBe('2026-08-27T00:39:05.000Z');
  });

  test('strips client trail-only helper keys', () => {
    const withTrail = { ...incoming(), pendingEditEvents: [1], originalSubmittedValues: { x: 1 }, hasQueuedCorrection: true };
    const rec = buildProcessedRecord(withTrail, computed);
    expect('pendingEditEvents' in rec).toBe(false);
    expect('originalSubmittedValues' in rec).toBe(false);
    expect('hasQueuedCorrection' in rec).toBe(false);
    // provenance still survives the strip
    expect(rec.recoveredFromPacketId).toBe('20260827_062211_Gabriel5_lbuegt');
  });

  test('retains originalSubmittedAt when a queued correction froze it', () => {
    const rec = buildProcessedRecord({ ...incoming(), originalSubmittedAt: 12345 }, computed);
    expect(rec.originalSubmittedAt).toBe(12345);
  });
});
