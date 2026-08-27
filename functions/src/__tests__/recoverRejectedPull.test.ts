// Proofs for the governed rejected-pull recovery ladder + operational runner
// (Mechanism A, Gabriel 5 incident 8/27/2026). Pure module — no emulator.
import {
  planRecovery,
  planClaim,
  executeRecovery,
  buildReplacementIncomingPacket,
  buildRecoveryAnnotation,
  deriveLocalDateTime,
  isValidPacketKey,
  isCanonicalPacketId,
  type RecoveryInput,
  type RecoveryState,
  type RejectedRecord,
  type RecoveryIO,
  type ClaimResult,
} from '../recoverRejectedPull';

// ── Incident constants ────────────────────────────────────────────────────
const REJECTED_ID = '20260827_062211_Gabriel5_lbuegt';
const REPLACEMENT_ID = '20260827_140000_Gabriel5_rcv001';
const WATERMARK = '2026-08-26T18:01:07.025Z';
const CORRECTED_PM_UTC = '2026-08-27T00:39:00.000Z'; // 7:39 PM CDT
const DRIVER = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';
const COMPANY = 'liquid-gold';

const rejectedRecord = (over: Partial<RejectedRecord> = {}): RejectedRecord => ({
  packetId: REJECTED_ID,
  requestType: 'pull',
  reason: 'STALE_PULL_TIME',
  packet: {
    companyId: COMPANY, driverId: DRIVER, driverName: 'Mikezfold', wellName: 'Gabriel 5',
    requestType: 'pull', dateTimeUTC: '2026-08-26T12:39:00.000Z',
    tankLevelFeet: 7, bblsTaken: 60, predictedLevelInches: 52,
    timezone: 'America/Chicago', wellDownIsAuthoritative: true, wellDown: false,
  },
  ...over,
});

const input = (over: Partial<RecoveryInput> = {}): RecoveryInput => ({
  rejectedPacketId: REJECTED_ID,
  replacementPacketId: REPLACEMENT_ID,
  corrected: { dateTimeUTC: CORRECTED_PM_UTC, tankLevelFeet: 7, bblsTaken: 60, wellDown: false },
  caller: { companyId: COMPANY, driverId: DRIVER },
  ...over,
});

const state = (over: Partial<RecoveryState> = {}): RecoveryState => ({
  rejected: rejectedRecord(),
  replacementProcessed: null,
  replacementIncoming: false,
  replacementRejected: null,
  watermarkDateTimeUTC: WATERMARK,
  nowMs: new Date('2026-08-27T13:00:00.000Z').getTime(),
  ...over,
});

describe('planRecovery — happy path', () => {
  test('corrected PM pull is newer than watermark → process', () => {
    const p = planRecovery(input(), state());
    expect(p.action).toBe('process');
  });
});

describe('planRecovery — eligibility (STALE_PULL_TIME only)', () => {
  test.each([
    'FUTURE_PULL_TIME', 'MALFORMED_PULL_TIME', 'PACKET_ID_COLLISION',
    'ORIGINAL_PACKET_NOT_FOUND', 'STRANDED_INCOMING_PACKET', undefined,
  ])('reason %s is NOT recoverable', (reason) => {
    const p = planRecovery(input(), state({ rejected: rejectedRecord({ reason: reason as string }) }));
    expect(p).toMatchObject({ action: 'reject', code: 'REJECTION_NOT_RECOVERABLE' });
  });
});

describe('planRecovery — ownership / type', () => {
  test('missing rejected record → REJECTED_RECORD_NOT_FOUND', () => {
    expect(planRecovery(input(), state({ rejected: null }))).toMatchObject({ action: 'reject', code: 'REJECTED_RECORD_NOT_FOUND' });
  });
  test('cross-company → CROSS_COMPANY', () => {
    expect(planRecovery(input({ caller: { companyId: 'other', driverId: DRIVER } }), state())).toMatchObject({ action: 'reject', code: 'CROSS_COMPANY' });
  });
  test('different driver → NOT_OWNER', () => {
    expect(planRecovery(input({ caller: { companyId: COMPANY, driverId: 'x' } }), state())).toMatchObject({ action: 'reject', code: 'NOT_OWNER' });
  });
  test('non-pull → NOT_A_PULL', () => {
    const rec = rejectedRecord(); (rec.packet as Record<string, unknown>).requestType = 'edit';
    expect(planRecovery(input(), state({ rejected: rec }))).toMatchObject({ action: 'reject', code: 'NOT_A_PULL' });
  });
});

describe('planRecovery — key + time validation', () => {
  test('replacement id equal to rejected id → INVALID_ARGUMENT', () => {
    expect(planRecovery(input({ replacementPacketId: REJECTED_ID }), state())).toMatchObject({ action: 'reject', code: 'INVALID_ARGUMENT' });
  });
  test('path-changing / control keys rejected', () => {
    for (const bad of ['a/b', 'a.b', 'a#b', 'a$b', 'a[b', 'a]b', ' lead', 'trail ']) {
      expect(isValidPacketKey(bad)).toBe(false);
    }
    // dashes are legal (real ids like GABRIEL5-36-25TFH)
    expect(isValidPacketKey('20260730_124533_GABRIEL5-36-25TFH_h01ymv')).toBe(true);
    expect(isValidPacketKey(REPLACEMENT_ID)).toBe(true);
  });
  test('non-canonical replacement id → INVALID_ARGUMENT', () => {
    expect(planRecovery(input({ replacementPacketId: 'not_canonical' }), state())).toMatchObject({ action: 'reject', code: 'INVALID_ARGUMENT' });
    expect(isCanonicalPacketId('not_canonical')).toBe(false);
    expect(isCanonicalPacketId(REPLACEMENT_ID)).toBe(true);
  });
  test('malformed corrected time → MALFORMED_REPLACEMENT_TIME', () => {
    const p = planRecovery(input({ corrected: { dateTimeUTC: 'not-a-date', tankLevelFeet: 7, bblsTaken: 60, wellDown: false } }), state());
    expect(p).toMatchObject({ action: 'reject', code: 'MALFORMED_REPLACEMENT_TIME' });
  });
});

describe('planRecovery — race + idempotency states', () => {
  const ours = { recoveredFromPacketId: REJECTED_ID, wellName: 'Gabriel 5', bblsTaken: 60 };
  test('newer pull moved watermark past corrected time → REPLACEMENT_NOT_NEWER', () => {
    expect(planRecovery(input(), state({ watermarkDateTimeUTC: '2026-08-27T02:00:00.000Z' }))).toMatchObject({ action: 'reject', code: 'REPLACEMENT_NOT_NEWER' });
  });
  test('processed + annotated → noop_complete', () => {
    expect(planRecovery(input(), state({ replacementProcessed: ours, rejected: rejectedRecord({ recoveredByPacketId: REPLACEMENT_ID }) }))).toMatchObject({ action: 'noop_complete' });
  });
  test('processed, annotation missing → annotate_only', () => {
    expect(planRecovery(input(), state({ replacementProcessed: ours }))).toMatchObject({ action: 'annotate_only' });
  });
  test('processed WITHOUT our provenance → REPLACEMENT_ID_CONFLICT', () => {
    expect(planRecovery(input(), state({ replacementProcessed: { bblsTaken: 99 } }))).toMatchObject({ action: 'reject', code: 'REPLACEMENT_ID_CONFLICT' });
  });
  test('replacement rejected by processor → REPLACEMENT_REJECTED', () => {
    expect(planRecovery(input(), state({ replacementRejected: { reason: 'STALE_PULL_TIME' } }))).toMatchObject({ action: 'reject', code: 'REPLACEMENT_REJECTED' });
  });
  test('replacement already pending in incoming → already_in_flight', () => {
    expect(planRecovery(input(), state({ replacementIncoming: true }))).toMatchObject({ action: 'already_in_flight' });
  });
  test('claimed under a different id → RECOVERED_UNDER_DIFFERENT_ID', () => {
    expect(planRecovery(input(), state({ rejected: rejectedRecord({ recoveryClaim: { replacementPacketId: 'other_id' } }) }))).toMatchObject({ action: 'reject', code: 'RECOVERED_UNDER_DIFFERENT_ID' });
  });
});

describe('planClaim — single winner', () => {
  test('no existing claim → acquire', () => {
    expect(planClaim(null, REPLACEMENT_ID, 1)).toMatchObject({ decision: 'acquire' });
  });
  test('same id already claimed → matched', () => {
    expect(planClaim({ replacementPacketId: REPLACEMENT_ID }, REPLACEMENT_ID, 1)).toMatchObject({ decision: 'matched' });
  });
  test('different id already claimed → conflict', () => {
    expect(planClaim({ replacementPacketId: 'winner_id' }, REPLACEMENT_ID, 1)).toMatchObject({ decision: 'conflict', existingReplacementId: 'winner_id' });
  });
});

describe('buildReplacementIncomingPacket — immutables from record, derived time, omission', () => {
  const packet = buildReplacementIncomingPacket(input(), rejectedRecord());
  test('new stable id + provenance', () => {
    expect(packet.packetId).toBe(REPLACEMENT_ID);
    expect(packet.idempotencyKey).toBe(REPLACEMENT_ID);
    expect(packet.recoveredFromPacketId).toBe(REJECTED_ID);
  });
  test('immutable identity comes from the RECORD, not the caller', () => {
    // Even if a caller spoofs corrected with extra fields, they cannot reach the packet.
    const spoof = buildReplacementIncomingPacket(
      input({ corrected: { dateTimeUTC: CORRECTED_PM_UTC, tankLevelFeet: 7, bblsTaken: 60, wellDown: false, companyId: 'evil', driverId: 'evil', wellName: 'Evil 9' } as never }),
      rejectedRecord(),
    );
    expect(spoof.companyId).toBe(COMPANY);
    expect(spoof.driverId).toBe(DRIVER);
    expect(spoof.wellName).toBe('Gabriel 5');
  });
  test('display time DERIVED from dateTimeUTC + record timezone', () => {
    expect(packet.dateTime).toBe('8/26/2026 7:39 PM');
    expect(deriveLocalDateTime(CORRECTED_PM_UTC, 'America/Chicago')).toBe('8/26/2026 7:39 PM');
  });
  test('stale AM predictedLevelInches OMITTED', () => {
    expect('predictedLevelInches' in packet).toBe(false);
  });
});

describe('buildRecoveryAnnotation — never touches .packet', () => {
  test('only recovery sibling keys', () => {
    const a = buildRecoveryAnnotation(input(), '2026-08-27T13:00:00.000Z');
    expect(Object.keys(a).some((k) => k.includes('/packet'))).toBe(false);
    expect(a[`packets/rejected/${REJECTED_ID}/recoveredByPacketId`]).toBe(REPLACEMENT_ID);
  });
});

// ── Operational runner (executeRecovery) — scripted IO, deterministic ──────
type ScriptedIO = RecoveryIO & {
  calls: { claim: number; write: number; annotate: number };
  claimResult: ClaimResult;
};
const scriptedIO = (states: RecoveryState[], claimResult: ClaimResult = { ok: true }): ScriptedIO => {
  let i = 0;
  const calls = { claim: 0, write: 0, annotate: 0 };
  return {
    calls, claimResult,
    async readState() { return states[Math.min(i++, states.length - 1)]; },
    async claimRecovery() { calls.claim++; return claimResult; },
    async writeIncomingIfAbsent() { calls.write++; return 'written'; },
    async annotate() { calls.annotate++; },
    async sleep() { /* deterministic — no real timers */ },
    now() { return new Date('2026-08-27T13:00:00.000Z').getTime(); },
  };
};

describe('executeRecovery — race-state table', () => {
  test('process → processed with provenance → recovered (claim + write + annotate once)', async () => {
    const io = scriptedIO([
      state(),                                                   // plan: process
      state({ replacementProcessed: { recoveredFromPacketId: REJECTED_ID } }), // poll: processed
    ]);
    const out = await executeRecovery(io, input(), { maxAttempts: 3, backoffMs: 0 });
    expect(out).toMatchObject({ status: 'recovered' });
    expect(io.calls).toEqual({ claim: 1, write: 1, annotate: 1 });
  });

  test('process → replacement rejected by processor → replacement_rejected, NO annotate', async () => {
    const io = scriptedIO([
      state(),
      state({ replacementRejected: { reason: 'STALE_PULL_TIME' } }),
    ]);
    const out = await executeRecovery(io, input(), { maxAttempts: 3, backoffMs: 0 });
    expect(out).toMatchObject({ status: 'replacement_rejected' });
    expect(io.calls.annotate).toBe(0);
  });

  test('stall (never processes within budget) → processing_submitted (idempotent)', async () => {
    const io = scriptedIO([state(), state(), state()]);
    const out = await executeRecovery(io, input(), { maxAttempts: 2, backoffMs: 0 });
    expect(out).toMatchObject({ status: 'processing_submitted' });
    expect(io.calls.annotate).toBe(0);
  });

  test('claim conflict → conflict, incoming never written', async () => {
    const io = scriptedIO([state()], { ok: false, existingReplacementId: 'winner_id' });
    const out = await executeRecovery(io, input(), { maxAttempts: 2, backoffMs: 0 });
    expect(out).toMatchObject({ status: 'conflict', code: 'RECOVERED_UNDER_DIFFERENT_ID' });
    expect(io.calls.write).toBe(0);
  });

  test('annotate_only (already processed) → recovered, no claim/write', async () => {
    const io = scriptedIO([state({ replacementProcessed: { recoveredFromPacketId: REJECTED_ID } })]);
    const out = await executeRecovery(io, input(), { maxAttempts: 2, backoffMs: 0 });
    expect(out).toMatchObject({ status: 'recovered' });
    expect(io.calls).toMatchObject({ claim: 0, write: 0, annotate: 1 });
  });
});

// ── Integration: in-memory DB + simulated canonical processor ──────────────
describe('executeRecovery — integration with a simulated processIncomingPull', () => {
  test('preserves recoveredFromPacketId on processed, never mutates rejected .packet, idempotent replay', async () => {
    const originalPacket = rejectedRecord().packet as Record<string, unknown>;
    const db: {
      rejected: Record<string, RejectedRecord>;
      processed: Record<string, Record<string, unknown>>;
      incoming: Record<string, Record<string, unknown>>;
    } = {
      rejected: { [REJECTED_ID]: rejectedRecord({ packet: { ...originalPacket } }) },
      processed: {}, incoming: {},
    };
    const io: RecoveryIO = {
      async readState() {
        return {
          rejected: db.rejected[REJECTED_ID] ?? null,
          replacementProcessed: db.processed[REPLACEMENT_ID] ?? null,
          replacementIncoming: REPLACEMENT_ID in db.incoming,
          replacementRejected: null,
          watermarkDateTimeUTC: WATERMARK,
          nowMs: 0,
        };
      },
      async claimRecovery() {
        const rec = db.rejected[REJECTED_ID];
        const d = planClaim(rec.recoveryClaim ?? null, REPLACEMENT_ID, 1);
        if (d.decision === 'conflict') return { ok: false, existingReplacementId: d.existingReplacementId };
        rec.recoveryClaim = { replacementPacketId: REPLACEMENT_ID, claimedAt: 1 };
        return { ok: true };
      },
      async writeIncomingIfAbsent(replId, packet) {
        if (replId in db.incoming) return 'exists';
        db.incoming[replId] = packet;
        // Simulate the CANONICAL processor consuming incoming → processed,
        // preserving recoveredFromPacketId and NOT touching packets/rejected.
        db.processed[replId] = { ...packet, processedAt: '2026-08-27T00:39:05Z' };
        delete db.incoming[replId];
        return 'written';
      },
      async annotate(update) {
        for (const [path, value] of Object.entries(update)) {
          const key = path.split('/').pop() as string;
          (db.rejected[REJECTED_ID] as Record<string, unknown>)[key] = value;
        }
      },
      sleep: async () => {},
      now: () => 0,
    };

    const out = await executeRecovery(io, input(), { maxAttempts: 3, backoffMs: 0 });
    expect(out).toMatchObject({ status: 'recovered' });
    // Provenance preserved on the processed receipt.
    expect(db.processed[REPLACEMENT_ID].recoveredFromPacketId).toBe(REJECTED_ID);
    // Original rejected payload byte-for-byte unchanged.
    expect(db.rejected[REJECTED_ID].packet).toEqual(originalPacket);
    // Annotation applied on sibling keys.
    expect(db.rejected[REJECTED_ID].recoveredByPacketId).toBe(REPLACEMENT_ID);

    // Replay converges idempotently → already_recovered, no 2nd processed row.
    const before = Object.keys(db.processed).length;
    const replay = await executeRecovery(io, input(), { maxAttempts: 3, backoffMs: 0 });
    expect(replay).toMatchObject({ status: 'already_recovered' });
    expect(Object.keys(db.processed).length).toBe(before);
  });
});
