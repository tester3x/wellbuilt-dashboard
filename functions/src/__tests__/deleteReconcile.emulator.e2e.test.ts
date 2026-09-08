/**
 * Real RTDB-emulator proof for the governed-delete current-state reconciliation.
 * Runs reconcileWellAfterDelete against a live emulator so the Admin SDK's real
 * transaction (optimistic null-first) + update semantics are exercised. Skips
 * when no emulator is present.
 *
 * Run: firebase emulators:exec --only database "npx jest deleteReconcile.emulator"
 */
import * as admin from 'firebase-admin';
import { reconcileWellAfterDelete, type ReconcileDb } from '../deleteReconcile';
import { namespacedWellStatePath } from '../packetGuards';

const EMULATOR = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const describeE2E = EMULATOR ? describe : describe.skip;

function getDb(): admin.database.Database {
  if (!admin.apps.length) {
    process.env.FIREBASE_DATABASE_EMULATOR_HOST = EMULATOR!;
    admin.initializeApp({ databaseURL: `http://${EMULATOR}?ns=demo-delete-reconcile` });
  }
  return admin.database();
}

const CO = 'liquid-gold';
const WELL = 'EmuDelWell';
const CW = namespacedWellStatePath(CO, WELL);
const STATUS = `wells/${WELL}/status`;

const pullOwned = (packetId: string, levelInches: number, dt: string) => ({
  wellName: WELL,
  config: { tanks: 1, bottomLevel: 3, route: 'R', pullBbls: 140 },
  current: { level: `${levelInches}"`, levelInches, asOf: 'RECON' },
  lastPull: { packetId, dateTimeUTC: dt, bblsTaken: 100 },
  calculated: { flowRate: '1:00:00', bbls24hrs: 20 },
});

describeE2E('governed delete reconciliation — real RTDB emulator', () => {
  const db = getDb();

  beforeEach(async () => {
    await db.ref(CW).remove();
    await db.ref(STATUS).remove();
    await db.ref(namespacedWellStatePath('acme', WELL)).remove();
  });
  afterAll(async () => {
    await db.ref(CW).remove();
    await db.ref(STATUS).remove();
    await db.ref(namespacedWellStatePath('acme', WELL)).remove();
    await Promise.all(admin.apps.map((a) => a?.delete()));
  });

  it('current-pull delete: fresh ref (null-first) reconciles ownership to the predecessor; isDown + config preserved', async () => {
    await db.ref(CW).set({ companyId: CO, wellKey: WELL, pullHighWater: { packetId: 'B', dateTimeUTC: '2026-09-07T02:00:00Z' }, materializedPacketId: 'B', current: { isDown: true, lastPull: { packetId: 'B' } } });
    await db.ref(STATUS).set({ isDown: true, config: { tanks: 1 }, lastPull: { packetId: 'B' }, current: { levelInches: 99 } });
    const res = await reconcileWellAfterDelete({
      db: db as unknown as ReconcileDb, companyId: CO, wellKey: WELL, wellName: WELL,
      deletedPacketId: 'B', survivingLatestId: 'A', survivingLatestUtc: '2026-09-07T01:00:00Z',
      pullOwned: pullOwned('A', 42, '2026-09-07T01:00:00Z'),
    });
    expect(res.action).toBe('set');
    const cw = (await db.ref(CW).once('value')).val();
    const st = (await db.ref(STATUS).once('value')).val();
    // Agreement across projections + preservation.
    expect(cw.pullHighWater.packetId).toBe('A');
    expect(cw.materializedPacketId).toBe('A');
    expect(cw.current.isDown).toBe(true);
    expect(st.lastPull.packetId).toBe('A');
    expect(st.current.levelInches).toBe(42);
    expect(st.isDown).toBe(true);      // authoritative well-down preserved
    expect(st.config.tanks).toBe(1);   // static config preserved
  });

  it('deleting the only pull clears pull-derived fields, preserves config + isDown', async () => {
    await db.ref(CW).set({ companyId: CO, wellKey: WELL, pullHighWater: { packetId: 'B', dateTimeUTC: '2026-09-07T02:00:00Z' }, materializedPacketId: 'B', current: { isDown: false } });
    await db.ref(STATUS).set({ isDown: true, config: { tanks: 2 }, current: { levelInches: 9 }, lastPull: { packetId: 'B' } });
    const res = await reconcileWellAfterDelete({
      db: db as unknown as ReconcileDb, companyId: CO, wellKey: WELL, wellName: WELL,
      deletedPacketId: 'B', survivingLatestId: null, survivingLatestUtc: null, pullOwned: null,
    });
    expect(res.action).toBe('clear');
    const cw = (await db.ref(CW).once('value')).val();
    const st = (await db.ref(STATUS).once('value')).val();
    expect(cw.pullHighWater ?? null).toBeNull();
    expect(cw.materializedPacketId ?? null).toBeNull();
    expect(st.current ?? null).toBeNull();
    expect(st.lastPull ?? null).toBeNull();
    expect(st.isDown).toBe(true);
    expect(st.config.tanks).toBe(2);
  });

  it('concurrent newer owner wins: reconcile skips and regresses nothing', async () => {
    const node = { companyId: CO, wellKey: WELL, pullHighWater: { packetId: 'C', dateTimeUTC: '2026-09-07T03:00:00Z' }, materializedPacketId: 'C', current: { lastPull: { packetId: 'C' } } };
    await db.ref(CW).set(node);
    const res = await reconcileWellAfterDelete({
      db: db as unknown as ReconcileDb, companyId: CO, wellKey: WELL, wellName: WELL,
      deletedPacketId: 'X', survivingLatestId: 'A', survivingLatestUtc: '2026-09-07T01:00:00Z',
      pullOwned: pullOwned('A', 1, '2026-09-07T01:00:00Z'),
    });
    expect(res.action).toBe('skip');
    const cw = (await db.ref(CW).once('value')).val();
    expect(cw.pullHighWater.packetId).toBe('C'); // newer owner untouched
    expect(cw.materializedPacketId).toBe('C');
  });

  it('FORCED INTERLEAVING (predecessor): newer pull materializes BOTH after the companyWells CAS → status write skips', async () => {
    await db.ref(CW).set({ companyId: CO, wellKey: WELL, pullHighWater: { packetId: 'B', dateTimeUTC: '2026-09-07T02:00:00Z' }, materializedPacketId: 'B', current: { isDown: false } });
    await db.ref(STATUS).set({ isDown: false, config: { tanks: 1 }, lastPull: { packetId: 'B', dateTimeUTC: '2026-09-07T02:00:00Z' } });
    const res = await reconcileWellAfterDelete({
      db: db as unknown as ReconcileDb, companyId: CO, wellKey: WELL, wellName: WELL,
      deletedPacketId: 'B', survivingLatestId: 'A', survivingLatestUtc: '2026-09-07T01:00:00Z',
      pullOwned: pullOwned('A', 42, '2026-09-07T01:00:00Z'),
      // After the delete's companyWells CAS commits the predecessor, a strictly
      // newer pull D lands and materializes BOTH projections (as processIncomingPull would).
      afterCasHook: async () => {
        await db.ref(CW).set({ companyId: CO, wellKey: WELL, pullHighWater: { packetId: 'D', dateTimeUTC: '2026-09-07T04:00:00Z' }, materializedPacketId: 'D', current: { isDown: false } });
        await db.ref(STATUS).set({ isDown: false, config: { tanks: 1 }, lastPull: { packetId: 'D', dateTimeUTC: '2026-09-07T04:00:00Z' }, current: { levelInches: 88 } });
      },
    });
    expect(res.statusAction).toBe('skip'); // the delayed status write did NOT regress to the survivor
    const st = (await db.ref(STATUS).once('value')).val();
    const cw = (await db.ref(CW).once('value')).val();
    expect(st.lastPull.packetId).toBe('D');
    expect(st.current.levelInches).toBe(88);
    expect(cw.pullHighWater.packetId).toBe('D'); // both projections identify the newer pull
  });

  it('FORCED INTERLEAVING (only-pull clear): newer pull lands after the clear CAS → status clear skips', async () => {
    await db.ref(CW).set({ companyId: CO, wellKey: WELL, pullHighWater: { packetId: 'B', dateTimeUTC: '2026-09-07T02:00:00Z' }, materializedPacketId: 'B', current: { isDown: false } });
    await db.ref(STATUS).set({ isDown: false, config: { tanks: 1 }, lastPull: { packetId: 'B', dateTimeUTC: '2026-09-07T02:00:00Z' } });
    const res = await reconcileWellAfterDelete({
      db: db as unknown as ReconcileDb, companyId: CO, wellKey: WELL, wellName: WELL,
      deletedPacketId: 'B', survivingLatestId: null, survivingLatestUtc: null, pullOwned: null,
      afterCasHook: async () => {
        await db.ref(CW).set({ companyId: CO, wellKey: WELL, pullHighWater: { packetId: 'D', dateTimeUTC: '2026-09-07T04:00:00Z' }, materializedPacketId: 'D', current: { isDown: false } });
        await db.ref(STATUS).set({ isDown: false, config: { tanks: 1 }, lastPull: { packetId: 'D', dateTimeUTC: '2026-09-07T04:00:00Z' }, current: { levelInches: 5 } });
      },
    });
    expect(res.statusAction).toBe('skip'); // did NOT clear the new pull's status
    const st = (await db.ref(STATUS).once('value')).val();
    expect(st.lastPull.packetId).toBe('D');
    expect(st.current.levelInches).toBe(5);
  });

  it('another company with the same well name is untouched', async () => {
    const otherCw = namespacedWellStatePath('acme', WELL);
    await db.ref(CW).set({ pullHighWater: { packetId: 'B', dateTimeUTC: '2026-09-07T02:00:00Z' }, materializedPacketId: 'B', current: {} });
    await db.ref(otherCw).set({ pullHighWater: { packetId: 'Z', dateTimeUTC: '2026-09-07T05:00:00Z' }, materializedPacketId: 'Z', current: {} });
    await reconcileWellAfterDelete({
      db: db as unknown as ReconcileDb, companyId: CO, wellKey: WELL, wellName: WELL,
      deletedPacketId: 'B', survivingLatestId: 'A', survivingLatestUtc: '2026-09-07T01:00:00Z',
      pullOwned: pullOwned('A', 1, '2026-09-07T01:00:00Z'),
    });
    const other = (await db.ref(otherCw).once('value')).val();
    expect(other.pullHighWater.packetId).toBe('Z');
    expect(other.materializedPacketId).toBe('Z');
  });

  it('idempotent: re-running the reconcile is stable', async () => {
    await db.ref(CW).set({ pullHighWater: { packetId: 'B', dateTimeUTC: '2026-09-07T02:00:00Z' }, materializedPacketId: 'B', current: {} });
    const args = {
      db: db as unknown as ReconcileDb, companyId: CO, wellKey: WELL, wellName: WELL,
      deletedPacketId: 'B', survivingLatestId: 'A', survivingLatestUtc: '2026-09-07T01:00:00Z',
      pullOwned: pullOwned('A', 7, '2026-09-07T01:00:00Z'),
    };
    await reconcileWellAfterDelete(args);
    await reconcileWellAfterDelete(args);
    const cw = (await db.ref(CW).once('value')).val();
    expect(cw.pullHighWater.packetId).toBe('A');
    expect(cw.materializedPacketId).toBe('A');
  });
});
