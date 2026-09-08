import {
  outgoingResponseKey,
  selectByMaxKey,
  decideOutgoingWrite,
  applyOutgoingAfterDelete,
  type OutgoingDb,
} from '../outgoingReconcile';

const WELL = 'Gabriel 1';
const CLEAN = 'Gabriel1';
const T1 = '2026-09-07T01:00:00.000Z'; // survivor (predecessor)
const T2 = '2026-09-07T02:00:00.000Z'; // deleted current
const T4 = '2026-09-07T04:00:00.000Z'; // concurrent newer

// Response row keyed by a WRITE timestamp; ownership carried by lastPull* fields.
const row = (ownerId: string, ownerUtc: string | null, level = 0) => ({
  wellName: WELL, lastPullPacketId: ownerId, lastPullDateTimeUTC: ownerUtc, currentLevel: `${level}"`,
});
const wkey = (writeStamp: string) => outgoingResponseKey(writeStamp, CLEAN);

function fakeOutgoingDb(initial: Record<string, unknown> = {}): OutgoingDb & { store: Record<string, any> } {
  const store: Record<string, any> = JSON.parse(JSON.stringify(initial));
  return {
    store,
    ref(path: string) {
      if (path === 'packets/outgoing') {
        return {
          orderByChild() {
            return {
              equalTo(well: string) {
                return {
                  async once() {
                    const entries = Object.entries(store).filter(([, v]) => v && (v as any).wellName === well);
                    return { forEach(cb: (c: { key: string; val(): unknown }) => void) { for (const [k, v] of entries) cb({ key: k, val: () => v }); } };
                  },
                };
              },
            };
          },
        } as never;
      }
      const key = path.slice('packets/outgoing/'.length);
      return { async remove() { delete store[key]; }, async set(v: unknown) { store[key] = v; } } as never;
    },
  };
}

/** What the Dashboard/guard would actually select for the well. */
const dashboardPick = (store: Record<string, any>) =>
  selectByMaxKey(Object.entries(store).filter(([, v]) => v.wellName === WELL).map(([key, v]) => ({ key, ...v })));

describe('decideOutgoingWrite (fail-closed ownership)', () => {
  it('writes when nothing current-or-newer remains', () => {
    expect(decideOutgoingWrite({ remaining: [], survivorId: 'A', survivorUtc: T1 })).toBe(true);
    expect(decideOutgoingWrite({ remaining: [{ ownerId: 'Z', ownerUtc: '2026-09-06T00:00:00Z' }], survivorId: 'A', survivorUtc: T1 })).toBe(true);
  });
  it('skips when a current-or-newer, equal-time, or unreadable owner remains', () => {
    expect(decideOutgoingWrite({ remaining: [{ ownerId: 'D', ownerUtc: T4 }], survivorId: 'A', survivorUtc: T1 })).toBe(false); // newer
    expect(decideOutgoingWrite({ remaining: [{ ownerId: 'C', ownerUtc: T1 }], survivorId: 'A', survivorUtc: T1 })).toBe(false); // equal-time other
    expect(decideOutgoingWrite({ remaining: [{ ownerId: 'C', ownerUtc: null }], survivorId: 'A', survivorUtc: T1 })).toBe(false); // unreadable
    expect(decideOutgoingWrite({ remaining: [], survivorId: null, survivorUtc: null })).toBe(false); // no survivor
  });
});

describe('applyOutgoingAfterDelete (owner-scoped)', () => {
  it('current delete with predecessor: removes only the deleted row, writes backdated survivor; reader selects survivor', async () => {
    const db = fakeOutgoingDb({ [wkey(T2)]: row('B', T2) }); // only the deleted pull's row
    const res = await applyOutgoingAfterDelete({
      db, wellName: WELL, cleanName: CLEAN, deletedPacketId: 'B',
      survivorRow: row('A', T1, 42), survivorId: 'A', survivorUtc: T1,
    });
    expect(res.removed).toBe(1);
    expect(res.wroteSurvivor).toBe(true);
    expect(db.store[wkey(T2)]).toBeUndefined();             // deleted row gone
    expect(dashboardPick(db.store)?.lastPullPacketId).toBe('A'); // reader selects survivor
  });

  it('historical delete: no deleted-owned row → nothing removed, survivor not rewritten (does not disturb)', async () => {
    const db = fakeOutgoingDb({ [wkey(T2)]: row('A', T2) }); // current row owned by the actual latest A
    const res = await applyOutgoingAfterDelete({
      db, wellName: WELL, cleanName: CLEAN, deletedPacketId: 'X', // a historical pull, not current
      survivorRow: row('A', T2), survivorId: 'A', survivorUtc: T2,
    });
    expect(res.removed).toBe(0);
    expect(res.wroteSurvivor).toBe(false);
    expect(dashboardPick(db.store)?.lastPullPacketId).toBe('A'); // untouched
  });

  it('only-pull delete: removes the deleted row, writes nothing (cleared)', async () => {
    const db = fakeOutgoingDb({ [wkey(T2)]: row('B', T2) });
    const res = await applyOutgoingAfterDelete({
      db, wellName: WELL, cleanName: CLEAN, deletedPacketId: 'B',
      survivorRow: null, survivorId: null, survivorUtc: null,
    });
    expect(res.removed).toBe(1);
    expect(res.wroteSurvivor).toBe(false);
    expect(dashboardPick(db.store)).toBeNull();
  });

  it('concurrent newer owner already present: deleted row removed, survivor NOT written, newer kept', async () => {
    const db = fakeOutgoingDb({ [wkey(T2)]: row('B', T2), [wkey(T4)]: row('D', T4, 88) });
    const res = await applyOutgoingAfterDelete({
      db, wellName: WELL, cleanName: CLEAN, deletedPacketId: 'B',
      survivorRow: row('A', T1), survivorId: 'A', survivorUtc: T1,
    });
    expect(res.wroteSurvivor).toBe(false);
    expect(db.store[wkey(T2)]).toBeUndefined();
    expect(dashboardPick(db.store)?.lastPullPacketId).toBe('D');
  });

  it('FORCED INTERLEAVING: newer pull lands between removal and survivor write → reader still selects the newer pull', async () => {
    const db = fakeOutgoingDb({ [wkey(T2)]: row('B', T2) });
    const res = await applyOutgoingAfterDelete({
      db, wellName: WELL, cleanName: CLEAN, deletedPacketId: 'B',
      survivorRow: row('A', T1), survivorId: 'A', survivorUtc: T1,
      // After the deleted row is removed, a newer pull D materializes its outgoing.
      afterRemovalHook: async () => { db.store[wkey(T4)] = row('D', T4, 88); },
    });
    // The survivor IS written (decision used the pre-hook state), but its backdated
    // key (T1) sorts below D's write-time key (T4), so the reader selects D.
    expect(res.wroteSurvivor).toBe(true);
    expect(res.survivorKey! < wkey(T4)).toBe(true);
    expect(dashboardPick(db.store)?.lastPullPacketId).toBe('D');
    expect(dashboardPick(db.store)?.currentLevel).toBe('88"');
  });

  it('cross-well isolation + idempotent replay', async () => {
    const other = outgoingResponseKey(T2, 'Gabriel7');
    const db = fakeOutgoingDb({ [wkey(T2)]: row('B', T2), [other]: { wellName: 'Gabriel 7', lastPullPacketId: 'G7', lastPullDateTimeUTC: T2 } });
    const args = { db, wellName: WELL, cleanName: CLEAN, deletedPacketId: 'B', survivorRow: row('A', T1), survivorId: 'A', survivorUtc: T1 };
    await applyOutgoingAfterDelete(args);
    const after1 = JSON.parse(JSON.stringify(db.store));
    await applyOutgoingAfterDelete(args); // replay
    expect(db.store).toEqual(after1);                 // idempotent (deterministic key)
    expect(db.store[other].lastPullPacketId).toBe('G7'); // other well untouched
    expect(dashboardPick(db.store)?.lastPullPacketId).toBe('A');
  });
});
