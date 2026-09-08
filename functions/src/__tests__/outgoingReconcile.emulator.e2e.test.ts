/**
 * Real RTDB-emulator proof for the owner-scoped packets/outgoing delete
 * reconciliation, plus combined agreement across companyWells + wells/status +
 * packets/outgoing + the row the Dashboard would actually select. Skips without
 * an emulator.
 *
 * Run: firebase emulators:exec --only database "npx jest outgoingReconcile.emulator"
 */
import * as admin from 'firebase-admin';
import {
  applyOutgoingAfterDelete, outgoingResponseKey, selectByMaxKey, type OutgoingDb,
} from '../outgoingReconcile';
import { reconcileWellAfterDelete, type ReconcileDb } from '../deleteReconcile';
import { namespacedWellStatePath } from '../packetGuards';

const EMULATOR = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const describeE2E = EMULATOR ? describe : describe.skip;

function getDb(): admin.database.Database {
  if (!admin.apps.length) {
    process.env.FIREBASE_DATABASE_EMULATOR_HOST = EMULATOR!;
    admin.initializeApp({ databaseURL: `http://${EMULATOR}?ns=demo-outgoing-reconcile` });
  }
  return admin.database();
}

const CO = 'liquid-gold';
const WELL = 'EmuOutWell';
const CLEAN = 'EmuOutWell';
const CW = namespacedWellStatePath(CO, WELL);
const STATUS = `wells/${WELL}/status`;
const T1 = '2026-09-07T01:00:00.000Z';
const T2 = '2026-09-07T02:00:00.000Z';
const T4 = '2026-09-07T04:00:00.000Z';
const row = (ownerId: string, ownerUtc: string, level = 0) => ({ wellName: WELL, lastPullPacketId: ownerId, lastPullDateTimeUTC: ownerUtc, currentLevel: `${level}"` });
const wkey = (stamp: string) => outgoingResponseKey(stamp, CLEAN);

async function outgoingRows(db: admin.database.Database) {
  const snap = await db.ref('packets/outgoing').orderByChild('wellName').equalTo(WELL).once('value');
  const rows: Array<{ key: string; lastPullPacketId: string; currentLevel: string }> = [];
  snap.forEach((c) => { const v = c.val() || {}; rows.push({ key: c.key || '', lastPullPacketId: v.lastPullPacketId, currentLevel: v.currentLevel }); });
  return rows;
}

describeE2E('owner-scoped outgoing delete reconcile — real RTDB emulator', () => {
  const db = getDb();
  const clean = async () => {
    await db.ref('packets/outgoing').remove();
    await db.ref(CW).remove();
    await db.ref(STATUS).remove();
  };
  beforeEach(clean);
  afterAll(async () => { await clean(); await Promise.all(admin.apps.map((a) => a?.delete())); });

  it('current delete with predecessor → survivor selected; only the deleted row removed', async () => {
    await db.ref(`packets/outgoing/${wkey(T2)}`).set(row('B', T2));
    const res = await applyOutgoingAfterDelete({ db: db as unknown as OutgoingDb, wellName: WELL, cleanName: CLEAN, deletedPacketId: 'B', survivorRow: row('A', T1, 42), survivorId: 'A', survivorUtc: T1 });
    expect(res.wroteSurvivor).toBe(true);
    const rows = await outgoingRows(db);
    expect(selectByMaxKey(rows)?.lastPullPacketId).toBe('A');
    expect(rows.find((r) => r.key === wkey(T2))).toBeUndefined();
  });

  it('historical delete does not disturb outgoing', async () => {
    await db.ref(`packets/outgoing/${wkey(T2)}`).set(row('A', T2, 9));
    const res = await applyOutgoingAfterDelete({ db: db as unknown as OutgoingDb, wellName: WELL, cleanName: CLEAN, deletedPacketId: 'X', survivorRow: row('A', T2), survivorId: 'A', survivorUtc: T2 });
    expect(res).toMatchObject({ removed: 0, wroteSurvivor: false });
    const rows = await outgoingRows(db);
    expect(selectByMaxKey(rows)?.currentLevel).toBe('9"');
  });

  it('only-pull delete clears outgoing', async () => {
    await db.ref(`packets/outgoing/${wkey(T2)}`).set(row('B', T2));
    await applyOutgoingAfterDelete({ db: db as unknown as OutgoingDb, wellName: WELL, cleanName: CLEAN, deletedPacketId: 'B', survivorRow: null, survivorId: null, survivorUtc: null });
    expect(await outgoingRows(db)).toHaveLength(0);
  });

  it('FORCED INTERLEAVING: newer pull materializes outgoing between removal and survivor write → reader selects newer', async () => {
    await db.ref(`packets/outgoing/${wkey(T2)}`).set(row('B', T2));
    const res = await applyOutgoingAfterDelete({
      db: db as unknown as OutgoingDb, wellName: WELL, cleanName: CLEAN, deletedPacketId: 'B',
      survivorRow: row('A', T1), survivorId: 'A', survivorUtc: T1,
      afterRemovalHook: async () => { await db.ref(`packets/outgoing/${wkey(T4)}`).set(row('D', T4, 88)); },
    });
    expect(res.wroteSurvivor).toBe(true); // survivor written (stale decision) …
    const rows = await outgoingRows(db);
    expect(selectByMaxKey(rows)?.lastPullPacketId).toBe('D'); // … but the reader selects the newer pull
    expect(selectByMaxKey(rows)?.currentLevel).toBe('88"');
  });

  it('idempotent replay + cross-well isolation', async () => {
    await db.ref(`packets/outgoing/${wkey(T2)}`).set(row('B', T2));
    await db.ref(`packets/outgoing/${outgoingResponseKey(T2, 'Other')}`).set({ wellName: 'Other', lastPullPacketId: 'O', lastPullDateTimeUTC: T2 });
    const args = { db: db as unknown as OutgoingDb, wellName: WELL, cleanName: CLEAN, deletedPacketId: 'B', survivorRow: row('A', T1), survivorId: 'A', survivorUtc: T1 };
    await applyOutgoingAfterDelete(args);
    await applyOutgoingAfterDelete(args);
    const rows = await outgoingRows(db);
    expect(rows.filter((r) => r.lastPullPacketId === 'A')).toHaveLength(1); // deterministic key → single row
    expect(selectByMaxKey(rows)?.lastPullPacketId).toBe('A');
    const other = (await db.ref('packets/outgoing').orderByChild('wellName').equalTo('Other').once('value')).val();
    expect(Object.values(other || {})[0]).toMatchObject({ lastPullPacketId: 'O' });
  });

  it('AGREEMENT: forced interleaving — a newer pull wins across companyWells + wells/status + outgoing + reader', async () => {
    // Deleted current pull B owns all three projections; survivor is predecessor A.
    await db.ref(CW).set({ companyId: CO, wellKey: WELL, pullHighWater: { packetId: 'B', dateTimeUTC: T2 }, materializedPacketId: 'B', current: { isDown: false, lastPull: { packetId: 'B' } } });
    await db.ref(STATUS).set({ isDown: false, config: { tanks: 1 }, lastPull: { packetId: 'B', dateTimeUTC: T2 } });
    await db.ref(`packets/outgoing/${wkey(T2)}`).set(row('B', T2));

    // 1) companyWells + wells/status reconcile; a strictly newer pull D lands mid-way and materializes ALL THREE.
    await reconcileWellAfterDelete({
      db: db as unknown as ReconcileDb, companyId: CO, wellKey: WELL, wellName: WELL,
      deletedPacketId: 'B', survivingLatestId: 'A', survivingLatestUtc: T1,
      pullOwned: { wellName: WELL, config: { tanks: 1, bottomLevel: 3, route: 'R', pullBbls: 140 }, current: { level: '1"', levelInches: 1, asOf: 'X' }, lastPull: { packetId: 'A', dateTimeUTC: T1 }, calculated: {} },
      afterCasHook: async () => {
        await db.ref(CW).set({ companyId: CO, wellKey: WELL, pullHighWater: { packetId: 'D', dateTimeUTC: T4 }, materializedPacketId: 'D', current: { isDown: false, lastPull: { packetId: 'D' } } });
        await db.ref(STATUS).set({ isDown: false, config: { tanks: 1 }, lastPull: { packetId: 'D', dateTimeUTC: T4 }, current: { levelInches: 88 } });
        await db.ref(`packets/outgoing/${wkey(T4)}`).set(row('D', T4, 88));
      },
    });
    // 2) outgoing reconcile (owner-scoped) runs next, as processDeleteRequest does.
    await applyOutgoingAfterDelete({ db: db as unknown as OutgoingDb, wellName: WELL, cleanName: CLEAN, deletedPacketId: 'B', survivorRow: row('A', T1), survivorId: 'A', survivorUtc: T1 });

    const cw = (await db.ref(CW).once('value')).val();
    const st = (await db.ref(STATUS).once('value')).val();
    const pick = selectByMaxKey(await outgoingRows(db));
    expect(cw.pullHighWater.packetId).toBe('D');
    expect(cw.materializedPacketId).toBe('D');
    expect(st.lastPull.packetId).toBe('D');
    expect(pick?.lastPullPacketId).toBe('D'); // all four agree on the newer pull
  });
});
