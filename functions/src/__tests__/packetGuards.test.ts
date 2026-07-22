// Focused proofs for the future-time guards + lossless quarantine
// (GS3 incident 7/21–22/2026).
import {
  FUTURE_TOLERANCE_MS,
  RootRefLike,
  buildQuarantineUpdate,
  evaluateIncomingPull,
  orphanEditVerdict,
  quarantineIncomingPacket,
  strandedPacketVerdict,
} from '../packetGuards';

// ── Incident constants ────────────────────────────────────────────────────
const POISONED_WATERMARK = '2026-07-22T04:07:00.000Z'; // 11:07 PM CDT entered for 11:07 AM
const VALID_WATERMARK = '2026-07-21T16:07:00.000Z';    // the real 11:07 AM pull

const ms = (iso: string) => new Date(iso).getTime();

describe('evaluateIncomingPull — validation ladder', () => {
  test('1. past valid pull processes normally', () => {
    const v = evaluateIncomingPull({
      incomingDateTimeUTC: '2026-07-21T17:06:00.000Z',
      hasOutgoingResponse: true,
      watermarkDateTimeUTC: VALID_WATERMARK,
      nowMs: ms('2026-07-21T17:30:00.000Z'),
    });
    expect(v).toEqual({ action: 'process' });
  });

  test('2. exactly 5 minutes ahead is allowed (clock-skew tolerance)', () => {
    const nowMs = ms('2026-07-21T17:30:00.000Z');
    const v = evaluateIncomingPull({
      incomingDateTimeUTC: new Date(nowMs + FUTURE_TOLERANCE_MS).toISOString(),
      hasOutgoingResponse: true,
      watermarkDateTimeUTC: VALID_WATERMARK,
      nowMs,
    });
    expect(v.action).toBe('process');
  });

  test('3. more than 5 minutes ahead is quarantined as FUTURE_PULL_TIME', () => {
    const nowMs = ms('2026-07-21T17:30:00.000Z');
    const v = evaluateIncomingPull({
      incomingDateTimeUTC: new Date(nowMs + FUTURE_TOLERANCE_MS + 1).toISOString(),
      hasOutgoingResponse: true,
      watermarkDateTimeUTC: VALID_WATERMARK,
      nowMs,
    });
    expect(v.action).toBe('quarantine');
    expect(v.reason).toBe('FUTURE_PULL_TIME');
  });

  test('4. GS3 regression: 11:07 PM entered while the evening clock reads 9:41 PM → quarantined, never processed', () => {
    // The exact poisoning moment: the driver's entry says 11:07 PM CDT
    // (2026-07-22T04:07:00Z) but server time is 9:41 PM CDT.
    const v = evaluateIncomingPull({
      incomingDateTimeUTC: POISONED_WATERMARK,
      hasOutgoingResponse: true,
      watermarkDateTimeUTC: VALID_WATERMARK,
      nowMs: ms('2026-07-22T02:41:35.000Z'),
    });
    expect(v.action).toBe('quarantine');
    expect(v.reason).toBe('FUTURE_PULL_TIME');
    // Quarantined ⇒ processing returns before any outgoing write, so the
    // poisoned value can never become the well watermark. The atomic update
    // is the ONLY write, and it touches no outgoing path:
    const update = buildQuarantineUpdate({ packetId: 'p1', packet: { dateTimeUTC: POISONED_WATERMARK }, verdict: v, nowMs: ms('2026-07-22T02:41:35.000Z') });
    expect(Object.keys(update).some((k) => k.includes('outgoing'))).toBe(false);
  });

  test('5. valid pull vs future-poisoned watermark → FUTURE_WELL_WATERMARK, not stale-deleted', () => {
    // 10:30 PM CDT: a legitimate 10:00 PM pull arrives while the watermark
    // still claims 11:07 PM (37 min in the future). The old code would have
    // judged it stale and deleted it; the watermark must not be trusted.
    const v = evaluateIncomingPull({
      incomingDateTimeUTC: '2026-07-22T03:00:00.000Z',
      hasOutgoingResponse: true,
      watermarkDateTimeUTC: POISONED_WATERMARK,
      nowMs: ms('2026-07-22T03:30:00.000Z'),
    });
    expect(v.action).toBe('quarantine');
    expect(v.reason).toBe('FUTURE_WELL_WATERMARK');
    expect(v.comparedWatermarkUTC).toBe(POISONED_WATERMARK);
  });

  test('6. a genuinely stale pull is quarantined as STALE_PULL_TIME', () => {
    const v = evaluateIncomingPull({
      incomingDateTimeUTC: VALID_WATERMARK, // duplicate of the processed pull
      hasOutgoingResponse: true,
      watermarkDateTimeUTC: VALID_WATERMARK,
      nowMs: ms('2026-07-21T17:30:00.000Z'),
    });
    expect(v.action).toBe('quarantine');
    expect(v.reason).toBe('STALE_PULL_TIME');
  });

  test('12. a normal current-time pull is unchanged by the guards', () => {
    const nowMs = ms('2026-07-22T15:00:00.000Z');
    const v = evaluateIncomingPull({
      incomingDateTimeUTC: new Date(nowMs - 2 * 60 * 1000).toISOString(),
      hasOutgoingResponse: true,
      watermarkDateTimeUTC: new Date(nowMs - 3 * 60 * 60 * 1000).toISOString(),
      nowMs,
    });
    expect(v).toEqual({ action: 'process' });
  });

  test('a well with no outgoing response processes normally', () => {
    const v = evaluateIncomingPull({
      incomingDateTimeUTC: '2026-07-21T17:06:00.000Z',
      hasOutgoingResponse: false,
      watermarkDateTimeUTC: undefined,
      nowMs: ms('2026-07-21T17:30:00.000Z'),
    });
    expect(v.action).toBe('process');
  });

  test('a malformed incoming timestamp is quarantined as MALFORMED_PULL_TIME, raw value preserved', () => {
    const nowMs = ms('2026-07-21T17:30:00.000Z');
    for (const bad of ['garbage', undefined, null, 12345]) {
      const v = evaluateIncomingPull({
        incomingDateTimeUTC: bad,
        hasOutgoingResponse: true,
        watermarkDateTimeUTC: VALID_WATERMARK,
        nowMs,
      });
      expect(v.action).toBe('quarantine');
      expect(v.reason).toBe('MALFORMED_PULL_TIME');
      expect(v.readableReason).toContain(String(JSON.stringify(bad)));
    }
    // The complete packet — raw timestamp included — survives in the record.
    const v = evaluateIncomingPull({ incomingDateTimeUTC: 'garbage', hasOutgoingResponse: true, watermarkDateTimeUTC: VALID_WATERMARK, nowMs });
    const packet = { packetId: 'm1', dateTimeUTC: 'garbage', wellName: 'Gunslinger 3', bblsTaken: 170 };
    const update = buildQuarantineUpdate({ packetId: 'm1', packet, verdict: v, nowMs });
    const record = update['packets/rejected/m1'] as any;
    expect(record.packet).toEqual(packet);
    expect((record.packet as any).dateTimeUTC).toBe('garbage');
  });

  test('a malformed stored watermark quarantines the incoming packet as MALFORMED_WELL_WATERMARK', () => {
    const nowMs = ms('2026-07-21T17:30:00.000Z');
    for (const bad of ['garbage', undefined, null]) {
      const v = evaluateIncomingPull({
        incomingDateTimeUTC: '2026-07-21T17:06:00.000Z',
        hasOutgoingResponse: true, // outgoing EXISTS but its watermark is unreadable
        watermarkDateTimeUTC: bad,
        nowMs,
      });
      expect(v.action).toBe('quarantine');
      expect(v.reason).toBe('MALFORMED_WELL_WATERMARK');
      expect(v.readableReason).toContain(String(JSON.stringify(bad)));
    }
    // The malformed watermark VALUE is carried on the verdict when present.
    const v = evaluateIncomingPull({
      incomingDateTimeUTC: '2026-07-21T17:06:00.000Z',
      hasOutgoingResponse: true,
      watermarkDateTimeUTC: 'not-a-date',
      nowMs,
    });
    expect(v.comparedWatermarkUTC).toBe('not-a-date');
  });
});

describe('orphan edits', () => {
  test('7. an edit targeting a missing original is quarantined as ORIGINAL_PACKET_NOT_FOUND', () => {
    const v = orphanEditVerdict('20260722_034135_Gunslinger3_cxzbcn');
    expect(v.action).toBe('quarantine');
    expect(v.reason).toBe('ORIGINAL_PACKET_NOT_FOUND');
    expect(v.readableReason).toContain('20260722_034135_Gunslinger3_cxzbcn');

    const noId = orphanEditVerdict(null);
    expect(noId.reason).toBe('ORIGINAL_PACKET_NOT_FOUND');
    expect(noId.readableReason).toContain('no originalPacketId');
  });
});

describe('quarantine record + atomicity', () => {
  const verdict = evaluateIncomingPull({
    incomingDateTimeUTC: VALID_WATERMARK,
    hasOutgoingResponse: true,
    watermarkDateTimeUTC: VALID_WATERMARK,
    nowMs: ms('2026-07-21T17:30:00.000Z'),
  });
  const packet = {
    packetId: '20260721_123000_Gunslinger3_abc123',
    requestType: 'pull',
    wellName: 'Gunslinger 3',
    dateTimeUTC: VALID_WATERMARK,
    dateTime: '7/21/2026 11:07 AM',
    timezone: 'America/Chicago',
    tankLevelFeet: 11.583333333333334,
    bblsTaken: 170,
    driverId: 'fd5e1e99',
    driverName: 'Mikezfold',
    someUnknownFutureField: { nested: true }, // must survive verbatim
  };

  test('8. quarantine preserves the complete original payload and all context fields', () => {
    const nowMs = ms('2026-07-21T17:30:00.000Z');
    const update = buildQuarantineUpdate({ packetId: packet.packetId, packet, verdict, nowMs });
    const record = update[`packets/rejected/${packet.packetId}`] as any;
    expect(record.packet).toEqual(packet); // complete, unmodified
    expect(record.packetId).toBe(packet.packetId);
    expect(record.reason).toBe('STALE_PULL_TIME');
    expect(typeof record.readableReason).toBe('string');
    expect(record.readableReason.length).toBeGreaterThan(0);
    expect(record.rejectedAt).toBe(new Date(nowMs).toISOString());
    expect(record.incomingDateTimeUTC).toBe(VALID_WATERMARK);
    expect(record.comparedWatermarkUTC).toBe(VALID_WATERMARK);
    expect(record.serverNowUTC).toBe(new Date(nowMs).toISOString());
    expect(record.wellName).toBe('Gunslinger 3');
    expect(record.requestType).toBe('pull');
  });

  test('9. rejected-creation and incoming-removal are one atomic multi-location update', async () => {
    const calls: Record<string, unknown>[] = [];
    const rootRef: RootRefLike = { update: async (v) => { calls.push(v); } };
    const ok = await quarantineIncomingPacket(rootRef, {
      packetId: packet.packetId, packet, verdict, nowMs: ms('2026-07-21T17:30:00.000Z'),
    });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1); // exactly one update — both writes or neither
    expect(Object.keys(calls[0]).sort()).toEqual([
      `packets/incoming/${packet.packetId}`,
      `packets/rejected/${packet.packetId}`,
    ]);
    expect(calls[0][`packets/incoming/${packet.packetId}`]).toBeNull();
  });

  test('10. a failed quarantine write leaves incoming intact (no fallback deletion)', async () => {
    const update = jest.fn().mockRejectedValue(new Error('rtdb unavailable'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const ok = await quarantineIncomingPacket({ update }, {
      packetId: packet.packetId, packet, verdict, nowMs: ms('2026-07-21T17:30:00.000Z'),
    });
    consoleError.mockRestore();
    expect(ok).toBe(false);
    // One attempted atomic update and nothing else — there is no separate
    // remove/set surface at all, so incoming cannot have been touched.
    expect(update).toHaveBeenCalledTimes(1);
  });

  test('11. rejected packets touch no processed/outgoing/performance/production/wellStatus paths', () => {
    const update = buildQuarantineUpdate({ packetId: packet.packetId, packet, verdict, nowMs: ms('2026-07-21T17:30:00.000Z') });
    const keys = Object.keys(update);
    expect(keys).toHaveLength(2);
    for (const k of keys) {
      expect(k).toMatch(/^packets\/(rejected|incoming)\//);
      expect(k).not.toMatch(/processed|outgoing|performance|production|wells\//);
    }
  });
});

describe('GS3 five-replay regression — nothing disappears against the poisoned watermark', () => {
  // The five real replay packets of 7/22/2026 (3:41–3:43 AM CDT), exactly as
  // they hit the CF, compared against the poisoned 04:07Z watermark. At the
  // replay clock the watermark was in the (recent) past, so each replay is
  // judged stale — but every one must SURVIVE in packets/rejected instead of
  // being deleted as they were in the incident.
  const replays = [
    { id: '20260722_034135_Gunslinger3_cxzbcn', pullUTC: '2026-07-21T17:06:00.000Z', clock: '2026-07-22T08:41:35.533Z' },
    { id: '20260722_034214_Gunslinger3_4po7r7', pullUTC: '2026-07-21T18:01:00.000Z', clock: '2026-07-22T08:42:14.834Z' },
    { id: '20260722_034243_Gunslinger3_4fua6d', pullUTC: '2026-07-21T19:17:00.000Z', clock: '2026-07-22T08:42:43.472Z' },
    { id: '20260722_034312_Gunslinger3_tygcsf', pullUTC: '2026-07-22T01:32:00.000Z', clock: '2026-07-22T08:43:20.527Z' },
    { id: '20260722_034317_Gunslinger3_33bnyw', pullUTC: '2026-07-22T01:32:00.000Z', clock: '2026-07-22T08:43:21.063Z' },
  ];

  test('all five are quarantined losslessly with distinct rejected keys', async () => {
    const written: Record<string, unknown> = {};
    const rootRef: RootRefLike = {
      update: async (v) => { Object.assign(written, v); },
    };
    for (const r of replays) {
      const verdict = evaluateIncomingPull({
        incomingDateTimeUTC: r.pullUTC,
        hasOutgoingResponse: true,
        watermarkDateTimeUTC: POISONED_WATERMARK,
        nowMs: ms(r.clock),
      });
      expect(verdict.action).toBe('quarantine'); // never processed against poison
      const ok = await quarantineIncomingPacket(rootRef, {
        packetId: r.id,
        packet: { packetId: r.id, requestType: 'pull', wellName: 'Gunslinger 3', dateTimeUTC: r.pullUTC, bblsTaken: 170 },
        verdict,
        nowMs: ms(r.clock),
      });
      expect(ok).toBe(true);
    }
    // All five survive — including BOTH 8:32 PM twins under distinct ids.
    const rejectedKeys = Object.keys(written).filter((k) => k.startsWith('packets/rejected/'));
    expect(rejectedKeys).toHaveLength(5);
    for (const r of replays) {
      const rec = written[`packets/rejected/${r.id}`] as any;
      expect(rec.packet.dateTimeUTC).toBe(r.pullUTC);
      expect(rec.packet.bblsTaken).toBe(170);
      expect(rec.comparedWatermarkUTC).toBe(POISONED_WATERMARK);
    }
  });
});

describe('watchdog stranded-packet quarantine', () => {
  const strandedEdit = {
    packetId: 'edit_20260721_122813_Gunslinger3',
    requestType: 'edit',
    wellName: 'Gunslinger 3',
    dateTimeUTC: '2026-07-21T16:07:00.000Z',
    bblsTaken: 165,
  };

  test('a stranded incoming packet is atomically quarantined with age and watchdog context', async () => {
    const verdict = strandedPacketVerdict({
      ageMs: 11 * 60 * 1000,
      context: 'stranded edit packet - handled by its own function and never watchdog-retriggered; its handler did not consume it',
    });
    expect(verdict.action).toBe('quarantine');
    expect(verdict.reason).toBe('STRANDED_INCOMING_PACKET');
    expect(verdict.readableReason).toContain('11 min old');
    expect(verdict.readableReason).toContain('Watchdog:');
    expect(verdict.readableReason).toContain('stranded edit packet');

    const calls: Record<string, unknown>[] = [];
    const rootRef: RootRefLike = { update: async (v) => { calls.push(v); } };
    const ok = await quarantineIncomingPacket(rootRef, {
      packetId: strandedEdit.packetId, packet: strandedEdit, verdict, nowMs: 1753142400000,
    });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1); // one atomic rejected+incoming update
    expect(Object.keys(calls[0]).sort()).toEqual([
      `packets/incoming/${strandedEdit.packetId}`,
      `packets/rejected/${strandedEdit.packetId}`,
    ]);
    const rec = calls[0][`packets/rejected/${strandedEdit.packetId}`] as any;
    expect(rec.packet).toEqual(strandedEdit); // complete payload preserved
    expect(rec.reason).toBe('STRANDED_INCOMING_PACKET');
  });

  test('unknown packet age is stated, not invented', () => {
    const verdict = strandedPacketVerdict({ ageMs: null, context: 'duplicate-grouped incoming packet' });
    expect(verdict.readableReason).toContain('unknown age');
  });

  test('a failed watchdog quarantine leaves the incoming packet intact', async () => {
    const update = jest.fn().mockRejectedValue(new Error('rtdb write denied'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const ok = await quarantineIncomingPacket({ update }, {
      packetId: strandedEdit.packetId,
      packet: strandedEdit,
      verdict: strandedPacketVerdict({ ageMs: 600000, context: 'stranded edit packet' }),
      nowMs: 1753142400000,
    });
    consoleError.mockRestore();
    expect(ok).toBe(false);
    expect(update).toHaveBeenCalledTimes(1); // the atomic attempt and nothing else
  });

  test('quarantine never touches packets/rejected except to CREATE the record (no deletions of evidence)', () => {
    const update = buildQuarantineUpdate({
      packetId: strandedEdit.packetId,
      packet: strandedEdit,
      verdict: strandedPacketVerdict({ ageMs: 600000, context: 'stranded edit packet' }),
      nowMs: 1753142400000,
    });
    // The ONLY null (deletion) in the update is the incoming path; the
    // rejected path is a creation. Nothing else is addressed at all.
    const entries = Object.entries(update);
    expect(entries).toHaveLength(2);
    for (const [path, value] of entries) {
      if (path.startsWith('packets/rejected/')) expect(value).not.toBeNull();
      else expect([path, value]).toEqual([`packets/incoming/${strandedEdit.packetId}`, null]);
    }
  });
});
