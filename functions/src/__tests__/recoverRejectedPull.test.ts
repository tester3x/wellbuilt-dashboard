// Focused proofs for the governed rejected-pull recovery ladder (Mechanism A,
// Gabriel 5 incident 8/27/2026). Pure module — no emulator.
import {
  planRecovery,
  buildReplacementIncomingPacket,
  buildRecoveryAnnotation,
  isFirebaseKeySafe,
  type RecoveryInput,
  type RecoveryState,
  type RejectedRecord,
} from '../recoverRejectedPull';

// ── Incident constants ────────────────────────────────────────────────────
const REJECTED_ID = '20260827_062211_Gabriel5_lbuegt';
const REPLACEMENT_ID = '20260827_140000_Gabriel5_rcv001';
const WATERMARK = '2026-08-26T18:01:07.025Z';           // existing 1:01 PM pull
const CORRECTED_PM_UTC = '2026-08-27T00:39:00.000Z';    // 7:39 PM CDT
const DRIVER = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';
const COMPANY = 'liquid-gold';

const rejectedRecord = (over: Partial<RejectedRecord> = {}): RejectedRecord => ({
  packetId: REJECTED_ID,
  requestType: 'pull',
  reason: 'STALE_PULL_TIME',
  packet: {
    companyId: COMPANY,
    driverId: DRIVER,
    driverName: 'Mikezfold',
    wellName: 'Gabriel 5',
    requestType: 'pull',
    dateTimeUTC: '2026-08-26T12:39:00.000Z', // the mistaken AM time
    tankLevelFeet: 7,
    bblsTaken: 60,
    predictedLevelInches: 52,                // AM-relative — must NOT be carried
    timezone: 'America/Chicago',
    wellDownIsAuthoritative: true,
    wellDown: false,
  },
  ...over,
});

const input = (over: Partial<RecoveryInput> = {}): RecoveryInput => ({
  rejectedPacketId: REJECTED_ID,
  replacementPacketId: REPLACEMENT_ID,
  corrected: { dateTimeUTC: CORRECTED_PM_UTC, dateTime: '8/26/2026 7:39 PM', tankLevelFeet: 7, bblsTaken: 60, wellDown: false },
  caller: { companyId: COMPANY, driverId: DRIVER },
  ...over,
});

const state = (over: Partial<RecoveryState> = {}): RecoveryState => ({
  rejected: rejectedRecord(),
  replacementProcessed: null,
  watermarkDateTimeUTC: WATERMARK,
  nowMs: new Date('2026-08-27T13:00:00.000Z').getTime(),
  ...over,
});

describe('planRecovery — happy path (watermark passes → canonical submit)', () => {
  test('corrected PM pull is newer than watermark → process', () => {
    const p = planRecovery(input(), state());
    expect(p.action).toBe('process');
    if (p.action === 'process') {
      expect(p.code).toBe('SUBMIT_REPLACEMENT');
      expect(p.incomingPath).toBe(`packets/incoming/${REPLACEMENT_ID}`);
    }
  });
});

describe('planRecovery — ownership / company / well', () => {
  test('missing rejected record → REJECTED_RECORD_NOT_FOUND', () => {
    const p = planRecovery(input(), state({ rejected: null }));
    expect(p).toMatchObject({ action: 'reject', code: 'REJECTED_RECORD_NOT_FOUND' });
  });

  test('cross-company caller → CROSS_COMPANY', () => {
    const p = planRecovery(input({ caller: { companyId: 'other-co', driverId: DRIVER } }), state());
    expect(p).toMatchObject({ action: 'reject', code: 'CROSS_COMPANY' });
  });

  test('different driver → NOT_OWNER', () => {
    const p = planRecovery(input({ caller: { companyId: COMPANY, driverId: 'someone-else' } }), state());
    expect(p).toMatchObject({ action: 'reject', code: 'NOT_OWNER' });
  });

  test('non-pull rejected record → NOT_A_PULL', () => {
    const rec = rejectedRecord();
    (rec.packet as Record<string, unknown>).requestType = 'edit';
    const p = planRecovery(input(), state({ rejected: rec }));
    expect(p).toMatchObject({ action: 'reject', code: 'NOT_A_PULL' });
  });
});

describe('planRecovery — argument validation', () => {
  test('replacement id equal to rejected id → INVALID_ARGUMENT', () => {
    const p = planRecovery(input({ replacementPacketId: REJECTED_ID }), state());
    expect(p).toMatchObject({ action: 'reject', code: 'INVALID_ARGUMENT' });
  });

  test('firebase-unsafe replacement id → INVALID_ARGUMENT', () => {
    const p = planRecovery(input({ replacementPacketId: 'bad/id.key' }), state());
    expect(p).toMatchObject({ action: 'reject', code: 'INVALID_ARGUMENT' });
    expect(isFirebaseKeySafe('bad/id.key')).toBe(false);
    expect(isFirebaseKeySafe(REPLACEMENT_ID)).toBe(true);
  });

  test('malformed corrected time → MALFORMED_REPLACEMENT_TIME', () => {
    const p = planRecovery(input({ corrected: { dateTimeUTC: 'not-a-date', tankLevelFeet: 7, bblsTaken: 60, wellDown: false } }), state());
    expect(p).toMatchObject({ action: 'reject', code: 'MALFORMED_REPLACEMENT_TIME' });
  });
});

describe('planRecovery — newer-pull race stops safely', () => {
  test('a newer pull moved the watermark past the corrected time → REPLACEMENT_NOT_NEWER', () => {
    const p = planRecovery(input(), state({ watermarkDateTimeUTC: '2026-08-27T02:00:00.000Z' }));
    expect(p).toMatchObject({ action: 'reject', code: 'REPLACEMENT_NOT_NEWER' });
  });

  test('watermark exactly equal to corrected time is NOT newer → REPLACEMENT_NOT_NEWER', () => {
    const p = planRecovery(input(), state({ watermarkDateTimeUTC: CORRECTED_PM_UTC }));
    expect(p).toMatchObject({ action: 'reject', code: 'REPLACEMENT_NOT_NEWER' });
  });

  test('no watermark (well has no outgoing) → still processes', () => {
    const p = planRecovery(input(), state({ watermarkDateTimeUTC: null }));
    expect(p.action).toBe('process');
  });
});

describe('planRecovery — idempotency by processed receipt', () => {
  const ourProcessed = { recoveredFromPacketId: REJECTED_ID, wellName: 'Gabriel 5', bblsTaken: 60 };

  test('retry after full success (processed + annotated) → noop_complete', () => {
    const p = planRecovery(input(), state({
      replacementProcessed: ourProcessed,
      rejected: rejectedRecord({ recoveredByPacketId: REPLACEMENT_ID, recoveryStatus: 'recovered' }),
    }));
    expect(p).toMatchObject({ action: 'noop_complete', code: 'ALREADY_RECOVERED' });
  });

  test('processed but annotation missing (partial failure) → annotate_only, no reprocess', () => {
    const p = planRecovery(input(), state({ replacementProcessed: ourProcessed }));
    expect(p).toMatchObject({ action: 'annotate_only', code: 'PROCESSED_AWAIT_ANNOTATION' });
  });

  test('a processed row with our id but WITHOUT our provenance → REPLACEMENT_ID_CONFLICT (never overwrite / no 2nd row)', () => {
    const p = planRecovery(input(), state({ replacementProcessed: { wellName: 'Gabriel 5', bblsTaken: 99 } }));
    expect(p).toMatchObject({ action: 'reject', code: 'REPLACEMENT_ID_CONFLICT' });
  });

  test('already recovered under a DIFFERENT replacement id → RECOVERED_UNDER_DIFFERENT_ID', () => {
    const p = planRecovery(input(), state({ rejected: rejectedRecord({ recoveredByPacketId: 'some_other_id' }) }));
    expect(p).toMatchObject({ action: 'reject', code: 'RECOVERED_UNDER_DIFFERENT_ID' });
  });
});

describe('buildReplacementIncomingPacket — canonical replacement + provenance + prediction omission', () => {
  const packet = buildReplacementIncomingPacket(input(), rejectedRecord());

  test('carries the new stable id as both packetId and idempotencyKey', () => {
    expect(packet.packetId).toBe(REPLACEMENT_ID);
    expect(packet.idempotencyKey).toBe(REPLACEMENT_ID);
  });

  test('carries provenance recoveredFromPacketId → the rejected original', () => {
    expect(packet.recoveredFromPacketId).toBe(REJECTED_ID);
  });

  test('uses corrected PM time + confirmed material fields', () => {
    expect(packet.dateTimeUTC).toBe(CORRECTED_PM_UTC);
    expect(packet.tankLevelFeet).toBe(7);
    expect(packet.bblsTaken).toBe(60);
    expect(packet.requestType).toBe('pull');
    expect(packet.wellName).toBe('Gabriel 5');
    expect(packet.driverId).toBe(DRIVER);
    expect(packet.companyId).toBe(COMPANY);
  });

  test('OMITS the stale AM predictedLevelInches (server reconstructs the PM value)', () => {
    expect('predictedLevelInches' in packet).toBe(false);
  });
});

describe('buildRecoveryAnnotation — preserves the original rejected payload', () => {
  const annotation = buildRecoveryAnnotation(input(), '2026-08-27T13:00:00.000Z');

  test('writes only recovery sibling keys, never touches .../packet', () => {
    const keys = Object.keys(annotation);
    expect(keys).toEqual([
      `packets/rejected/${REJECTED_ID}/recoveredByPacketId`,
      `packets/rejected/${REJECTED_ID}/recoveredAt`,
      `packets/rejected/${REJECTED_ID}/recoveryStatus`,
      `packets/rejected/${REJECTED_ID}/recoveryReason`,
    ]);
    expect(keys.some((k) => k.includes('/packet'))).toBe(false);
    expect(annotation[`packets/rejected/${REJECTED_ID}/recoveredByPacketId`]).toBe(REPLACEMENT_ID);
    expect(annotation[`packets/rejected/${REJECTED_ID}/recoveryStatus`]).toBe('recovered');
  });
});
