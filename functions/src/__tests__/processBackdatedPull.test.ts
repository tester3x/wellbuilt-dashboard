// Backdated-insertion orchestrator (injected IO) — insertion, duplicate no-op,
// revision fence + retry, single atomic commit, no outgoing/current write.
import { runBackdatedInsertion, type BackdatedIO } from '../processBackdatedPull';
import { type ChronoPullInput, type WellChronoConfig } from '../chronoRecompute';

const CFG: WellChronoConfig = { bblPerFoot: 20, tanks: 1, allowedBottomInches: 36, avgFlowRateDays: 0.1443 };
const WELL = 'Gabriel 5';

const PRED = { packetId: 'pred', dateTimeUTC: '2026-08-25T18:54:00.000Z', tankTopInches: 0, bblsTaken: 0, knownBottomInches: 66 } as ChronoPullInput;
const P101 = { packetId: 'p101', dateTimeUTC: '2026-08-26T18:01:07.025Z', tankTopInches: 158, bblsTaken: 145 } as ChronoPullInput;

const amData = {
  packetId: 'am', wellName: WELL, dateTimeUTC: '2026-08-26T12:39:00.000Z',
  tankLevelFeet: 7, bblsTaken: 60, wellDown: false, driverId: 'd1', requestType: 'pull',
};

function mockIO(over: Partial<BackdatedIO> & { revision?: number; pulls?: ChronoPullInput[] } = {}) {
  const state = { revision: over.revision ?? 5, pulls: over.pulls ?? [PRED, P101], committed: null as Record<string, unknown> | null, commits: 0 };
  const io: BackdatedIO = {
    loadWellPulls: over.loadWellPulls ?? (async () => state.pulls),
    readWellRevision: over.readWellRevision ?? (async () => state.revision),
    commitFenced: over.commitFenced ?? (async (_w, expected, updates) => {
      state.commits++;
      if (expected !== state.revision) return 'stale_revision';
      state.revision += 1; state.committed = updates; return 'committed';
    }),
  };
  return { io, state };
}

describe('runBackdatedInsertion', () => {
  const args = { wellName: WELL, packetId: 'am', data: amData, tankTopInches: 84, cfg: CFG, nowIso: '2026-08-27T13:00:00Z' };

  test('inserts the older pull, tags Late Entry, recomputes the successor, keeps current', async () => {
    const { io, state } = mockIO();
    const out = await runBackdatedInsertion(io, args);
    expect(out.status).toBe('inserted');
    if (out.status === 'inserted') {
      expect(out.lateEntry).toBe(true);
      expect(out.current).toBe('p101');          // current pointer unchanged (newest)
      expect(out.changedPacketIds).toEqual(['p101']);
    }
    const u = state.committed!;
    // new row material + derived created via child updates
    expect(u['packets/processed/am/bblsTaken']).toBe(60);
    expect(u['packets/processed/am/recoveryInches']).toBe(18);
    expect(u['packets/processed/am/lateEntry']).toBe(true);
    // successor 1:01 PM recomputed against inserted predecessor (92→110)
    expect(u['packets/processed/p101/recoveryInches']).toBe(110);
    // fence revision stamped
    expect(u['packets/processed/am/chronoRevision']).toBe(6);
    // NEVER writes outgoing/current
    expect(Object.keys(u).some((k) => k.startsWith('packets/outgoing'))).toBe(false);
    expect(state.commits).toBe(1);
  });

  test('logical duplicate → no-op, no commit', async () => {
    const dupPulls = [PRED, P101, { packetId: 'existing_am', dateTimeUTC: amData.dateTimeUTC, tankTopInches: 84, bblsTaken: 60 } as ChronoPullInput];
    const { io, state } = mockIO({ pulls: dupPulls });
    const out = await runBackdatedInsertion(io, args);
    expect(out.status).toBe('duplicate_noop');
    expect(state.committed).toBeNull();
  });

  test('stale revision → retries against fresh state, then commits', async () => {
    let calls = 0;
    const state = { revision: 5, pulls: [PRED, P101] as ChronoPullInput[] };
    const io: BackdatedIO = {
      loadWellPulls: async () => state.pulls,
      readWellRevision: async () => state.revision,
      commitFenced: async (_w, expected) => {
        calls++;
        if (calls === 1) { state.revision = 6; return 'stale_revision'; } // a newer pull won mid-flight
        return expected === state.revision ? 'committed' : 'stale_revision';
      },
    };
    const out = await runBackdatedInsertion(io, args, );
    expect(out.status).toBe('inserted');
    expect(calls).toBe(2); // retried once after the stale revision
  });

  test('persistent stale revision (stale worker) → never overwrites; returns stale_revision', async () => {
    const io: BackdatedIO = {
      loadWellPulls: async () => [PRED, P101],
      readWellRevision: async () => 5,
      commitFenced: async () => 'stale_revision', // always superseded
    };
    const out = await runBackdatedInsertion(io, { ...args, maxAttempts: 3 });
    expect(out.status).toBe('stale_revision');
  });
});
