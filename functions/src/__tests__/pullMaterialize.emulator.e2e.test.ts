/**
 * Real RTDB-emulator proof for the P0 materialization fix. Runs the ACTUAL
 * production transaction runner (runOwnerMaterializeTxn) against a live emulator
 * so the Admin SDK's real optimistic-null-first transaction behavior is
 * exercised. Skips automatically when no emulator is present.
 *
 * Run: firebase emulators:exec --only database "npx jest pullMaterialize.emulator"
 */
import * as admin from 'firebase-admin';
import { runOwnerMaterializeTxn } from '../pullMaterialize';
import { namespacedWellStatePath } from '../packetGuards';

const EMULATOR = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const describeE2E = EMULATOR ? describe : describe.skip;

function getDb(): admin.database.Database {
  if (!admin.apps.length) {
    process.env.FIREBASE_DATABASE_EMULATOR_HOST = EMULATOR!;
    admin.initializeApp({ databaseURL: `http://${EMULATOR}?ns=demo-materialize` });
  }
  return admin.database();
}

describeE2E('pull materialization — real RTDB emulator', () => {
  const db = getDb();
  const path = namespacedWellStatePath('liquid-gold', 'EmuWell');
  const P = '20260907_emu_ownerA';

  beforeEach(async () => { await db.ref(path).remove(); });
  afterAll(async () => {
    await db.ref(path).remove();
    await Promise.all(admin.apps.map((a) => a?.delete()));
  });

  it('rightful owner materializes against a freshly-written server node (no local cache)', async () => {
    // Phase-1 equivalent: write the high-water node. Then run phase-2 with a
    // FRESH ref so the transaction's optimistic first callback sees null.
    await db.ref(path).set({
      companyId: 'liquid-gold', wellKey: 'EmuWell',
      pullHighWater: { dateTimeUTC: '2026-09-07T00:00:00.000Z', packetId: P },
    });
    const res = await runOwnerMaterializeTxn({ ref: db.ref(path), packetId: P, current: { levelInches: 42 } });
    expect(res.materialized).toBe(true);
    const node = (await db.ref(path).once('value')).val();
    expect(node.materializedPacketId).toBe(P);
    expect(node.pullHighWater.packetId).toBe(P); // high-water preserved
    expect(node.current.levelInches).toBe(42);
  });

  it('superseded packet does not materialize and does not regress high-water', async () => {
    await db.ref(path).set({ pullHighWater: { dateTimeUTC: '2026-09-07T01:00:00.000Z', packetId: 'NEWER' } });
    const res = await runOwnerMaterializeTxn({ ref: db.ref(path), packetId: 'OLDER', current: { levelInches: 9 } });
    expect(res.materialized).toBe(false);
    const node = (await db.ref(path).once('value')).val();
    expect(node.pullHighWater.packetId).toBe('NEWER');
    expect(node.materializedPacketId ?? null).toBeNull();
  });

  it('genuinely absent owner fails closed (no materialization)', async () => {
    const res = await runOwnerMaterializeTxn({ ref: db.ref(path), packetId: P, current: { levelInches: 1 } });
    expect(res.materialized).toBe(false);
  });

  it('idempotent re-run of the owner', async () => {
    await db.ref(path).set({ pullHighWater: { packetId: P }, materializedPacketId: P, current: { levelInches: 42 } });
    const res = await runOwnerMaterializeTxn({ ref: db.ref(path), packetId: P, current: { levelInches: 42 } });
    expect(res.materialized).toBe(true);
    expect(res.outcome).toBe('already');
  });
});
