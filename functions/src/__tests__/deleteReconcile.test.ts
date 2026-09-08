import {
  decideDeleteReconcile,
  reconcileWellAfterDelete,
  type ReconcileDb,
} from '../deleteReconcile';
import { namespacedWellStatePath } from '../packetGuards';

const CO = 'liquid-gold';
const WELL = 'Gabriel 1';
const CW = namespacedWellStatePath(CO, WELL); // companyWells node path
const STATUS = `wells/${WELL}/status`;

const pullOwned = (packetId: string, levelInches: number, dt: string) => ({
  wellName: WELL,
  config: { tanks: 1, bottomLevel: 3, route: 'Gabriels', pullBbls: 140 },
  current: { level: `${levelInches}"`, levelInches, asOf: 'RECON' },
  lastPull: { packetId, dateTimeUTC: dt, bblsTaken: 100 },
  calculated: { flowRate: '1:00:00', bbls24hrs: 20 },
});

// In-memory fake RTDB honoring transaction (server value) + update (merge, null=delete).
function fakeDb(initial: Record<string, unknown> = {}): ReconcileDb & { store: Record<string, any> } {
  const store: Record<string, any> = JSON.parse(JSON.stringify(initial));
  return {
    store,
    ref(path: string) {
      return {
        async transaction(update: (n: unknown) => unknown) {
          const res = update(path in store ? store[path] : null);
          if (res === undefined) return { committed: false };
          store[path] = res;
          return { committed: true };
        },
        async update(val: Record<string, unknown>) {
          const cur = path in store && store[path] && typeof store[path] === 'object' ? store[path] : {};
          const next: Record<string, unknown> = { ...cur };
          for (const [k, v] of Object.entries(val)) { if (v === null) delete next[k]; else next[k] = v; }
          store[path] = next;
        },
      };
    },
  };
}

const cwNode = (ownerId: string, ownerUtc: string, isDown = false) => ({
  companyId: CO, wellKey: WELL,
  pullHighWater: { packetId: ownerId, dateTimeUTC: ownerUtc, companyId: CO, wellKey: WELL },
  materializedPacketId: ownerId,
  current: { isDown, lastPull: { packetId: ownerId }, level: 'x' },
});

describe('decideDeleteReconcile (pure ownership)', () => {
  const base = { storedOwnerId: 'B', storedOwnerUtc: '2026-09-07T02:00:00Z', deletedPacketId: 'B', survivingLatestId: 'A', survivingLatestUtc: '2026-09-07T01:00:00Z' };
  it('current-pull delete (owner deleted) → set to survivor', () => {
    expect(decideDeleteReconcile(base)).toBe('set');
  });
  it('historical delete (owner is the survivor) → set/refresh', () => {
    expect(decideDeleteReconcile({ ...base, deletedPacketId: 'X', storedOwnerId: 'A', storedOwnerUtc: '2026-09-07T01:00:00Z' })).toBe('set');
  });
  it('concurrent NEWER owner (not deleted, newer than survivor) → skip (never regress)', () => {
    expect(decideDeleteReconcile({ ...base, deletedPacketId: 'X', storedOwnerId: 'C', storedOwnerUtc: '2026-09-07T03:00:00Z' })).toBe('skip');
  });
  it('only pull deleted (no survivor, we owned it) → clear', () => {
    expect(decideDeleteReconcile({ ...base, survivingLatestId: null, survivingLatestUtc: null })).toBe('clear');
  });
  it('no survivor but a different owner exists → skip (do not touch)', () => {
    expect(decideDeleteReconcile({ ...base, deletedPacketId: 'X', storedOwnerId: 'C', storedOwnerUtc: '2026-09-07T03:00:00Z', survivingLatestId: null, survivingLatestUtc: null })).toBe('skip');
  });
});

describe('reconcileWellAfterDelete (applied, in-memory)', () => {
  it('current-pull delete → sets ownership to predecessor + updates wells/status, preserving isDown', async () => {
    const db = fakeDb({ [CW]: cwNode('B', '2026-09-07T02:00:00Z', /* isDown */ true), [STATUS]: { isDown: true, config: { tanks: 1 }, lastPull: { packetId: 'B' } } });
    const res = await reconcileWellAfterDelete({
      db, companyId: CO, wellKey: WELL, wellName: WELL,
      deletedPacketId: 'B', survivingLatestId: 'A', survivingLatestUtc: '2026-09-07T01:00:00Z',
      pullOwned: pullOwned('A', 42, '2026-09-07T01:00:00Z'), now: () => 'T',
    });
    expect(res.action).toBe('set');
    expect(db.store[CW].pullHighWater.packetId).toBe('A');
    expect(db.store[CW].materializedPacketId).toBe('A');
    expect(db.store[CW].current.isDown).toBe(true);              // authoritative well-down preserved
    expect(db.store[CW].current.lastPull.packetId).toBe('A');
    expect(db.store[STATUS].lastPull.packetId).toBe('A');        // wells/status pull-owned updated
    expect(db.store[STATUS].current.levelInches).toBe(42);
    expect(db.store[STATUS].isDown).toBe(true);                  // preserved (never written here)
    expect(db.store[STATUS].config.tanks).toBe(1);              // static config preserved
  });

  it('deleting the ONLY pull → clears pull-derived fields, preserves config + isDown', async () => {
    const db = fakeDb({ [CW]: cwNode('B', '2026-09-07T02:00:00Z'), [STATUS]: { isDown: true, config: { tanks: 2 }, current: { levelInches: 9 }, lastPull: { packetId: 'B' }, calculated: { bbls24hrs: 3 } } });
    const res = await reconcileWellAfterDelete({
      db, companyId: CO, wellKey: WELL, wellName: WELL,
      deletedPacketId: 'B', survivingLatestId: null, survivingLatestUtc: null, pullOwned: null, now: () => 'T',
    });
    expect(res.action).toBe('clear');
    expect(db.store[CW].pullHighWater).toBeUndefined();
    expect(db.store[CW].materializedPacketId).toBeUndefined();
    expect(db.store[CW].current).toBeUndefined();
    expect(db.store[STATUS].current).toBeUndefined();
    expect(db.store[STATUS].lastPull).toBeUndefined();
    expect(db.store[STATUS].isDown).toBe(true);                  // preserved
    expect(db.store[STATUS].config.tanks).toBe(2);              // preserved
  });

  it('concurrent NEWER owner → skip on BOTH nodes, nothing regressed', async () => {
    const before = cwNode('C', '2026-09-07T03:00:00Z');
    const status = { lastPull: { packetId: 'C', dateTimeUTC: '2026-09-07T03:00:00Z' }, isDown: false };
    const db = fakeDb({ [CW]: JSON.parse(JSON.stringify(before)), [STATUS]: JSON.parse(JSON.stringify(status)) });
    const res = await reconcileWellAfterDelete({
      db, companyId: CO, wellKey: WELL, wellName: WELL,
      deletedPacketId: 'X', survivingLatestId: 'A', survivingLatestUtc: '2026-09-07T01:00:00Z',
      pullOwned: pullOwned('A', 1, '2026-09-07T01:00:00Z'), now: () => 'T',
    });
    expect(res.action).toBe('skip');
    expect(res.statusAction).toBe('skip');
    expect(db.store[CW]).toEqual(before);                        // companyWells untouched
    expect(db.store[STATUS].lastPull.packetId).toBe('C');        // wells/status untouched
  });

  it('FORCED INTERLEAVING (predecessor): newer pull materializes BOTH after the companyWells CAS → status write skips', async () => {
    // companyWells starts owned by the deleted current pull 'B'.
    const db = fakeDb({ [CW]: cwNode('B', '2026-09-07T02:00:00Z'), [STATUS]: { isDown: false, config: { tanks: 1 }, lastPull: { packetId: 'B', dateTimeUTC: '2026-09-07T02:00:00Z' } } });
    const res = await reconcileWellAfterDelete({
      db, companyId: CO, wellKey: WELL, wellName: WELL,
      deletedPacketId: 'B', survivingLatestId: 'A', survivingLatestUtc: '2026-09-07T01:00:00Z',
      pullOwned: pullOwned('A', 42, '2026-09-07T01:00:00Z'), now: () => 'T',
      // AFTER the companyWells CAS commits the survivor, a strictly newer pull 'D'
      // lands and materializes BOTH projections (as processIncomingPull would).
      afterCasHook: async () => {
        db.store[CW] = cwNode('D', '2026-09-07T04:00:00Z');
        db.store[STATUS] = { isDown: false, config: { tanks: 1 }, lastPull: { packetId: 'D', dateTimeUTC: '2026-09-07T04:00:00Z' }, current: { levelInches: 88 } };
      },
    });
    expect(res.statusAction).toBe('skip'); // did NOT regress status to the survivor
    expect(db.store[STATUS].lastPull.packetId).toBe('D');
    expect(db.store[STATUS].current.levelInches).toBe(88);
    expect(db.store[CW].pullHighWater.packetId).toBe('D');       // both identify the newer pull
  });

  it('FORCED INTERLEAVING (only-pull clear): newer pull lands after the clear CAS → status clear skips', async () => {
    const db = fakeDb({ [CW]: cwNode('B', '2026-09-07T02:00:00Z'), [STATUS]: { isDown: false, config: { tanks: 1 }, lastPull: { packetId: 'B', dateTimeUTC: '2026-09-07T02:00:00Z' } } });
    const res = await reconcileWellAfterDelete({
      db, companyId: CO, wellKey: WELL, wellName: WELL,
      deletedPacketId: 'B', survivingLatestId: null, survivingLatestUtc: null, pullOwned: null, now: () => 'T',
      afterCasHook: async () => {
        db.store[CW] = cwNode('D', '2026-09-07T04:00:00Z');
        db.store[STATUS] = { isDown: false, config: { tanks: 1 }, lastPull: { packetId: 'D', dateTimeUTC: '2026-09-07T04:00:00Z' }, current: { levelInches: 5 } };
      },
    });
    expect(res.statusAction).toBe('skip'); // did NOT clear the new pull's status
    expect(db.store[STATUS].lastPull.packetId).toBe('D');
    expect(db.store[STATUS].current.levelInches).toBe(5);
  });

  it('equal-timestamp different packet → skip (canonical tie-break: existing owner wins)', () => {
    expect(decideDeleteReconcile({
      storedOwnerId: 'C', storedOwnerUtc: '2026-09-07T01:00:00Z', deletedPacketId: 'X',
      survivingLatestId: 'A', survivingLatestUtc: '2026-09-07T01:00:00Z',
    })).toBe('skip');
  });

  it('unreadable owner timestamp on a different packet → skip (fail closed)', () => {
    expect(decideDeleteReconcile({
      storedOwnerId: 'C', storedOwnerUtc: null, deletedPacketId: 'X',
      survivingLatestId: 'A', survivingLatestUtc: '2026-09-07T01:00:00Z',
    })).toBe('skip');
  });

  it('same well name in ANOTHER company is untouched (namespace isolation)', async () => {
    const otherCw = namespacedWellStatePath('acme', WELL);
    const db = fakeDb({ [CW]: cwNode('B', '2026-09-07T02:00:00Z'), [otherCw]: cwNode('Z', '2026-09-07T05:00:00Z') });
    await reconcileWellAfterDelete({
      db, companyId: CO, wellKey: WELL, wellName: WELL,
      deletedPacketId: 'B', survivingLatestId: 'A', survivingLatestUtc: '2026-09-07T01:00:00Z',
      pullOwned: pullOwned('A', 1, '2026-09-07T01:00:00Z'), now: () => 'T',
    });
    expect(db.store[otherCw].pullHighWater.packetId).toBe('Z');  // acme's node untouched
  });

  it('is idempotent: re-running the same reconcile is stable', async () => {
    const db = fakeDb({ [CW]: cwNode('B', '2026-09-07T02:00:00Z'), [STATUS]: {} });
    const args = {
      db, companyId: CO, wellKey: WELL, wellName: WELL,
      deletedPacketId: 'B', survivingLatestId: 'A', survivingLatestUtc: '2026-09-07T01:00:00Z',
      pullOwned: pullOwned('A', 7, '2026-09-07T01:00:00Z'), now: () => 'T',
    };
    await reconcileWellAfterDelete(args);
    const first = JSON.parse(JSON.stringify(db.store[CW]));
    await reconcileWellAfterDelete(args); // owner is now 'A'; deletedPacketId 'B' not owner; survivor 'A' == owner → set/refresh (stable)
    expect(db.store[CW].pullHighWater.packetId).toBe('A');
    expect(db.store[CW]).toEqual(first);
  });
});
