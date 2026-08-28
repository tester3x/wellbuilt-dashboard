// Backdated-insertion orchestrator under an EXCLUSIVE per-well lock — insertion,
// duplicate no-op, and an adversarial interleaving proving no lost-update.
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

// A simple in-memory "server": a per-well lock + processed store + revision.
function makeServer(initialPulls: ChronoPullInput[]) {
  const store = { pulls: [...initialPulls], revision: 5, locked: false, commits: 0, lastUpdate: null as Record<string, unknown> | null };
  const io = (): BackdatedIO => ({
    async withWellLock(_well, fn) {
      if (store.locked) return { ran: false };          // exclusive — refuse concurrent entry
      store.locked = true;
      try { return { ran: true, value: await fn() }; }
      finally { store.locked = false; }
    },
    async loadWellPulls() { return store.pulls; },
    async readWellRevision() { return store.revision; },
    async commit(updates) {
      store.commits++; store.lastUpdate = updates;
      store.revision = Number(updates[`wells/${WELL}/status/chronoRevision`]);
      // materialize the new 'am' row into the store so a later read sees it
      if (updates['packets/processed/am/bblsTaken'] !== undefined) {
        store.pulls = [...store.pulls, { packetId: 'am', dateTimeUTC: amData.dateTimeUTC, tankTopInches: 84, bblsTaken: 60 }];
      }
    },
  });
  return { store, io };
}

const args = { wellName: WELL, packetId: 'am', data: amData, tankTopInches: 84, cfg: CFG, nowIso: '2026-08-27T13:00:00Z' };

describe('runBackdatedInsertion — under exclusive well lock', () => {
  test('inserts older pull, tags Late Entry, recomputes successor, never writes outgoing', async () => {
    const { store, io } = makeServer([PRED, P101]);
    const out = await runBackdatedInsertion(io(), args);
    expect(out.status).toBe('inserted');
    if (out.status === 'inserted') { expect(out.lateEntry).toBe(true); expect(out.current).toBe('p101'); expect(out.changedPacketIds).toEqual(['p101']); }
    const u = store.lastUpdate!;
    expect(u['packets/processed/am/recoveryInches']).toBe(18);
    expect(u['packets/processed/p101/recoveryInches']).toBe(110);
    expect(u[`wells/${WELL}/status/chronoRevision`]).toBe(6);
    expect(Object.keys(u).some((k) => k.startsWith('packets/outgoing'))).toBe(false);
  });

  test('logical duplicate → no-op, no commit', async () => {
    const existingAm = { packetId: 'existing_am', dateTimeUTC: amData.dateTimeUTC, tankTopInches: 84, bblsTaken: 60 } as ChronoPullInput;
    const { store, io } = makeServer([PRED, P101, existingAm]);
    const out = await runBackdatedInsertion(io(), args);
    expect(out.status).toBe('duplicate_noop');
    expect(store.commits).toBe(0);
  });
});

describe('adversarial interleaving — Worker A and Worker B, no lost update', () => {
  test('A holds the lock; B cannot enter until A commits; final state contains BOTH inserts', async () => {
    // Two DISTINCT backdated pulls for the same well.
    const server = makeServer([PRED, P101]);
    // Instrument the lock so we can force B to attempt while A is inside.
    let aInside = false; let bAttemptedWhileAInside = false;
    const baseIO = server.io();
    const io: BackdatedIO = {
      ...baseIO,
      async withWellLock(well, fn) {
        return baseIO.withWellLock(well, async () => {
          aInside = true;
          // While A is inside, B tries to acquire → must be refused (ran:false).
          const bTry = await baseIO.withWellLock(well, async () => 'B-should-not-run');
          if (!bTry.ran) bAttemptedWhileAInside = true;
          const r = await fn();
          aInside = false;
          return r;
        });
      },
      async commit(u) {
        // A commits an SECOND distinct pull 'am2' as part of its update set too?
        // No — keep A's commit as 'am'; then run B separately AFTER A releases.
        return baseIO.commit(u);
      },
    };

    // Worker A inserts 'am'. During A's critical section, B is proven refused.
    const a = await runBackdatedInsertion(io, args);
    expect(a.status).toBe('inserted');
    expect(bAttemptedWhileAInside).toBe(true);   // B was refused entry while A held the lock
    expect(aInside).toBe(false);

    // Now Worker B inserts a DIFFERENT older pull AFTER A released. It reads A's
    // committed state (which already contains 'am') and adds itself — no overwrite.
    const bData = { ...amData, packetId: 'am2', dateTimeUTC: '2026-08-26T06:00:00.000Z' };
    const bServerIO = server.io(); // same underlying store
    // teach commit to materialize am2 too
    const bIO: BackdatedIO = {
      ...bServerIO,
      async commit(u) {
        server.store.commits++; server.store.lastUpdate = u;
        server.store.revision = Number(u[`wells/${WELL}/status/chronoRevision`]);
        if (u['packets/processed/am2/bblsTaken'] !== undefined) {
          server.store.pulls = [...server.store.pulls, { packetId: 'am2', dateTimeUTC: bData.dateTimeUTC, tankTopInches: 84, bblsTaken: 60 }];
        }
      },
    };
    const b = await runBackdatedInsertion(bIO, { ...args, packetId: 'am2', data: bData });
    expect(b.status).toBe('inserted');

    // Final store contains BOTH am and am2 (A's insert was not lost).
    const ids = server.store.pulls.map((p) => p.packetId).sort();
    expect(ids).toContain('am');
    expect(ids).toContain('am2');
    // revision advanced monotonically by each committed writer (no reuse).
    expect(server.store.revision).toBe(7); // 5 → 6 (A) → 7 (B)
  });

  test('persistent contention → lock_contended (never a blind overwrite)', async () => {
    const io: BackdatedIO = {
      async withWellLock() { return { ran: false }; }, // always held by someone else
      async loadWellPulls() { return [PRED, P101]; },
      async readWellRevision() { return 5; },
      async commit() { /* unreachable */ },
    };
    const out = await runBackdatedInsertion(io, { ...args, maxAttempts: 3 });
    expect(out.status).toBe('lock_contended');
  });
});
