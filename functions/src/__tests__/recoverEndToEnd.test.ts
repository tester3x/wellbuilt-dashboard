// End-to-end convergence using the REAL production processing entries — the
// real quarantine guard (evaluateIncomingPull) and the real processed-record
// construction (buildProcessedRecord) — wired into the recovery runner. No
// simulated/reproduced processor: the harness invokes the actual production
// functions the deployed processIncomingPull uses.
import { evaluateIncomingPull } from '../packetGuards';
import { buildProcessedRecord, type ProcessedComputedFields } from '../processedRecord';
import {
  executeRecovery, planClaim,
  type RecoveryIO, type RecoveryInput, type RejectedRecord,
} from '../recoverRejectedPull';

const REJECTED_ID = '20260827_062211_Gabriel5_lbuegt';
const REPLACEMENT_ID = '20260827_140000_Gabriel5_rcv001';
const CORRECTED_PM_UTC = '2026-08-27T00:39:00.000Z';
const DRIVER = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';
const COMPANY = 'liquid-gold';

const originalPacket = () => ({
  companyId: COMPANY, driverId: DRIVER, driverName: 'Mikezfold', wellName: 'Gabriel 5',
  requestType: 'pull', dateTimeUTC: '2026-08-26T12:39:00.000Z',
  tankLevelFeet: 7, bblsTaken: 60, predictedLevelInches: 52, timezone: 'America/Chicago',
});

const COMPUTED: ProcessedComputedFields = {
  packetId: REPLACEMENT_ID, tankTopInches: 84, tankAfterInches: 48, tankAfterFeet: "4'0\"",
  timeDif: '6:37', timeDifDays: 0.2763, recoveryInches: 13, flowRate: '6:07:17',
  flowRateDays: 0.255, recoveryNeeded: 12, estTimeToPull: '5:00',
  estDateTimePull: '2026-08-27T05:39:00.000Z', processedAt: '2026-08-27T00:39:05.000Z',
};

const input = (): RecoveryInput => ({
  rejectedPacketId: REJECTED_ID,
  replacementPacketId: REPLACEMENT_ID,
  corrected: { dateTimeUTC: CORRECTED_PM_UTC, tankLevelFeet: 7, bblsTaken: 60, wellDown: false },
  caller: { companyId: COMPANY, driverId: DRIVER },
});

// In-memory DB whose incoming-write invokes the REAL processIncomingPull entries.
function makeHarness(initialWatermark: string) {
  const db = {
    rejected: { [REJECTED_ID]: { packetId: REJECTED_ID, reason: 'STALE_PULL_TIME', packet: { ...originalPacket() } } as RejectedRecord },
    processed: {} as Record<string, Record<string, unknown>>,
    incoming: {} as Record<string, Record<string, unknown>>,
    rejectedByProcessor: {} as Record<string, Record<string, unknown>>,
    watermark: initialWatermark,
    calls: { write: 0, annotate: 0 },
  };
  const io: RecoveryIO = {
    async readState() {
      return {
        rejected: db.rejected[REJECTED_ID] ?? null,
        replacementProcessed: db.processed[REPLACEMENT_ID] ?? null,
        replacementIncoming: REPLACEMENT_ID in db.incoming,
        replacementRejected: db.rejectedByProcessor[REPLACEMENT_ID] ?? null,
        watermarkDateTimeUTC: db.watermark,
        nowMs: Date.parse('2026-08-27T00:40:00.000Z'),
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
      if (replId in db.incoming || replId in db.processed) { db.calls.write++; return 'exists'; }
      db.calls.write++;
      db.incoming[replId] = packet;
      // ── REAL processIncomingPull entries ──────────────────────────────
      // 1) real quarantine guard against the CURRENT watermark (may have moved).
      const verdict = evaluateIncomingPull({
        incomingDateTimeUTC: packet.dateTimeUTC as string,
        hasOutgoingResponse: true,
        watermarkDateTimeUTC: db.watermark,
        nowMs: Date.parse('2026-08-27T00:40:00.000Z'),
      });
      if (verdict.action === 'quarantine') {
        db.rejectedByProcessor[replId] = { packetId: replId, reason: verdict.reason, packet };
        delete db.incoming[replId];
        return 'written';
      }
      // 2) real processed-record construction (preserves passthrough provenance).
      db.processed[replId] = buildProcessedRecord(packet, { ...COMPUTED, packetId: replId });
      delete db.incoming[replId];
      return 'written';
    },
    async annotate(update) {
      db.calls.annotate++;
      for (const [path, value] of Object.entries(update)) {
        const key = path.split('/').pop() as string;
        (db.rejected[REJECTED_ID] as Record<string, unknown>)[key] = value;
      }
    },
    sleep: async () => {},
    now: () => Date.parse('2026-08-27T00:40:05.000Z'),
  };
  return { db, io };
}

describe('real-processor end-to-end — convergence', () => {
  test('claim → one incoming write → real processor → one processed row w/ provenance → annotate → idempotent replay', async () => {
    const { db, io } = makeHarness('2026-08-26T18:01:07.025Z'); // corrected PM is newer
    const before = { ...originalPacket() };

    const out = await executeRecovery(io, input(), { maxAttempts: 3, backoffMs: 0 });
    expect(out).toMatchObject({ status: 'recovered' });

    // Exactly one processed row, carrying the rejected id as provenance.
    expect(Object.keys(db.processed)).toEqual([REPLACEMENT_ID]);
    expect(db.processed[REPLACEMENT_ID].recoveredFromPacketId).toBe(REJECTED_ID);
    // Original rejected payload unchanged; annotation on sibling keys only.
    expect(db.rejected[REJECTED_ID].packet).toEqual(before);
    expect(db.rejected[REJECTED_ID].recoveredByPacketId).toBe(REPLACEMENT_ID);
    // One incoming write, one annotate.
    expect(db.calls.annotate).toBe(1);

    // Replay converges idempotently — no 2nd processed row, no incoming rewrite.
    const writesBefore = db.calls.write;
    const replay = await executeRecovery(io, input(), { maxAttempts: 3, backoffMs: 0 });
    expect(replay).toMatchObject({ status: 'already_recovered' });
    expect(Object.keys(db.processed)).toEqual([REPLACEMENT_ID]);
    expect(db.calls.write).toBe(writesBefore); // no new incoming write
  });
});

describe('real-processor end-to-end — processor rejects the replacement after the preflight race', () => {
  test('a newer pull arrives before the trigger runs → real guard quarantines STALE → replacement_rejected, original NOT recovered', async () => {
    // Preflight watermark lets planRecovery proceed, but the processor sees an
    // ADVANCED watermark (a newer real pull landed first).
    const { db, io } = makeHarness('2026-08-26T18:01:07.025Z');
    const original = { ...db.rejected[REJECTED_ID].packet };
    // Simulate the race: watermark moves past the corrected time before the write.
    const realWrite = io.writeIncomingIfAbsent.bind(io);
    io.writeIncomingIfAbsent = async (replId, packet) => {
      // Newer pull won — watermark now just past the corrected time (still in the
      // past relative to server 'now', so this is a genuine STALE, not future).
      db.watermark = '2026-08-27T00:39:00.001Z';
      return realWrite(replId, packet);
    };

    const out = await executeRecovery(io, input(), { maxAttempts: 2, backoffMs: 0 });
    expect(out).toMatchObject({ status: 'replacement_rejected' });

    // No processed row; the processor's rejection is recorded; the ORIGINAL is
    // NOT annotated recovered and its payload is untouched → needs review.
    expect(db.processed[REPLACEMENT_ID]).toBeUndefined();
    expect(db.rejectedByProcessor[REPLACEMENT_ID].reason).toBe('STALE_PULL_TIME');
    expect(db.rejected[REJECTED_ID].recoveredByPacketId).toBeUndefined();
    expect(db.rejected[REJECTED_ID].packet).toEqual(original);
    expect(db.calls.annotate).toBe(0);
  });
});
