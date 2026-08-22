/**
 * RTDB emulator join: ingest writes packets/incoming/{canonicalPacketId}
 * and that child key is the processor trigger id.
 *
 * Requires FIREBASE_DATABASE_EMULATOR_HOST (firebase emulators:exec --only database).
 * Functions emulator is attempted separately; this file never talks to production.
 */
import * as admin from 'firebase-admin';
import {
  decideWbmPullTransaction,
  evaluateWbmPull,
  wbmIncomingPath,
  wbmPullStorageKey,
} from '../wbmPullAuthorize';

const EMULATOR = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const PROJECT = process.env.GCLOUD_PROJECT || 'wellbuilt-sync';
const hasEmulator = Boolean(EMULATOR);
const hasFunctionsTrigger = hasEmulator && process.env.WBM_FUNCTIONS_E2E === '1';
const describeE2E = hasEmulator && !hasFunctionsTrigger ? describe : describe.skip;
const describeFunctionsE2E = hasFunctionsTrigger ? describe : describe.skip;

const PID = '20260820_124211_Gabriel1_frr2t3';
const DRIVER = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';
const COMPANY = 'liquid-gold';

function getDb(): admin.database.Database {
  if (!admin.apps.length) {
    process.env.FIREBASE_DATABASE_EMULATOR_HOST = EMULATOR!;
    admin.initializeApp({
      projectId: PROJECT,
      databaseURL: `http://${EMULATOR}?ns=${PROJECT}-default-rtdb`,
    });
  }
  return admin.database();
}

describeE2E('emulator: canonical packet ID is the incoming child key', () => {
  let db: admin.database.Database;

  beforeAll(() => {
    db = getDb();
  });

  afterAll(async () => {
    await Promise.all(admin.apps.filter((app): app is admin.app.App => app != null).map((app) => app.delete()));
  });

  beforeEach(async () => {
    await db.ref('packets').set(null);
    await db.ref('wells').set(null);
  });

  it('writes packets/incoming/20260820_124211_Gabriel1_frr2t3 and processor trigger id matches', async () => {
    const decided = evaluateWbmPull({
      packet: {
        requestType: 'pull',
        wellName: 'Gabriel 1',
        dateTimeUTC: '2026-08-20T17:42:02.991Z',
        tankLevelFeet: 9.583333333333334,
        bblsTaken: 140,
        packetId: PID,
        idempotencyKey: PID,
      },
      companyId: COMPANY,
      assignedRoutes: ['Gabriels'],
      assignedWells: [],
      wellConfig: { 'Gabriel 1': { route: 'Gabriels', companyId: COMPANY } },
    });
    expect(decided.ok).toBe(true);
    if (!decided.ok) return;

    const key = wbmPullStorageKey(decided.idempotencyKey);
    const path = wbmIncomingPath(decided.idempotencyKey);
    expect(key).toBe(PID);
    expect(path).toBe(`packets/incoming/${PID}`);

    const stamped = {
      ...decided.payload,
      driverId: DRIVER,
      companyId: COMPANY,
      payloadDigest: decided.payloadDigest,
    };
    const ref = db.ref(path);
    const tx = await ref.transaction((current) => {
      const existing = current && typeof current === 'object'
        ? current as Record<string, unknown>
        : null;
      const gate = decideWbmPullTransaction({
        existing,
        driverId: DRIVER,
        payloadDigest: decided.payloadDigest,
      });
      if (gate.action === 'write') return stamped;
      if (gate.action === 'duplicate') return current;
      return;
    });
    expect(tx.committed).toBe(true);

    const incoming = await db.ref('packets/incoming').once('value');
    const children = incoming.val() || {};
    expect(Object.keys(children)).toEqual([PID]);
    expect(children[PID].packetId).toBe(PID);

    // Mirrors processIncomingPull: context.params.packetId = child key.
    const triggerPacketId = Object.keys(children)[0];
    expect(triggerPacketId).toBe(PID);

    await db.ref(`packets/processed/${triggerPacketId}`).set({
      ...children[PID],
      packetId: triggerPacketId,
      processedAt: new Date().toISOString(),
    });
    await db.ref(`packets/outgoing/response_${triggerPacketId}`).set({
      wellName: 'Gabriel 1',
      lastPullPacketId: triggerPacketId,
    });
    await db.ref('wells/Gabriel 1/status').set({
      lastPull: { packetId: triggerPacketId },
    });
    await db.ref(`packets/incoming/${triggerPacketId}`).remove();

    const processed = await db.ref(`packets/processed/${PID}`).once('value');
    expect(processed.exists()).toBe(true);
    expect(processed.val().packetId).toBe(PID);
    const outgoing = await db.ref(`packets/outgoing/response_${PID}`).once('value');
    expect(outgoing.val().lastPullPacketId).toBe(PID);
    const well = await db.ref('wells/Gabriel 1/status').once('value');
    expect(well.val().lastPull.packetId).toBe(PID);

    // Offline replay of the same canonical id: incoming child is the same key.
    const replayTx = await db.ref(path).transaction((current) => {
      const existing = current && typeof current === 'object'
        ? current as Record<string, unknown>
        : null;
      const gate = decideWbmPullTransaction({
        existing,
        driverId: DRIVER,
        payloadDigest: decided.payloadDigest,
      });
      if (gate.action === 'write') return stamped;
      if (gate.action === 'duplicate') return current;
      return;
    });
    expect(replayTx.committed).toBe(true);
    const replayIncoming = await db.ref('packets/incoming').once('value');
    expect(Object.keys(replayIncoming.val() || {})).toEqual([PID]);
    const already = await db.ref(`packets/processed/${PID}`).once('value');
    expect(already.exists()).toBe(true);
    await db.ref(`packets/incoming/${PID}`).remove();
    const processedAgain = await db.ref('packets/processed').once('value');
    expect(Object.keys(processedAgain.val() || {})).toEqual([PID]);
  });
});

describeFunctionsE2E('functions emulator: processIncomingPull keeps the ingest child key', () => {
  let db: admin.database.Database;

  beforeAll(() => {
    if (!process.env.FIRESTORE_EMULATOR_HOST) {
      throw new Error('Refuse to trigger processIncomingPull without FIRESTORE_EMULATOR_HOST');
    }
    db = getDb();
  });

  afterAll(async () => {
    await Promise.all(admin.apps.filter((app): app is admin.app.App => app != null).map((app) => app.delete()));
  });

  beforeEach(async () => {
    await db.ref('packets').set(null);
    await db.ref('wells').set(null);
    await db.ref('well_config/Gabriel 1').set({
      route: 'Gabriels',
      companyId: COMPANY,
      tanks: 1,
      bottomLevel: 3,
      pullBbls: 140,
    });
  });

  async function waitForProcessed(packetId: string, timeoutMs = 20000): Promise<Record<string, unknown>> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const snap = await db.ref(`packets/processed/${packetId}`).once('value');
      if (snap.exists()) return snap.val() as Record<string, unknown>;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`processIncomingPull did not write packets/processed/${packetId}`);
  }

  it('live trigger writes processed/outgoing/well status under 20260820_124211_Gabriel1_frr2t3', async () => {
    const decided = evaluateWbmPull({
      packet: {
        requestType: 'pull',
        wellName: 'Gabriel 1',
        dateTimeUTC: '2026-08-20T17:42:02.991Z',
        tankLevelFeet: 9.583333333333334,
        bblsTaken: 140,
        packetId: PID,
        idempotencyKey: PID,
      },
      companyId: COMPANY,
      assignedRoutes: ['Gabriels'],
      assignedWells: [],
      wellConfig: { 'Gabriel 1': { route: 'Gabriels', companyId: COMPANY } },
    });
    expect(decided.ok).toBe(true);
    if (!decided.ok) return;

    const path = wbmIncomingPath(decided.idempotencyKey);
    expect(path).toBe(`packets/incoming/${PID}`);
    await db.ref(path).set({
      ...decided.payload,
      driverId: DRIVER,
      driverName: 'Mikezfold',
      companyId: COMPANY,
      payloadDigest: decided.payloadDigest,
    });

    const processed = await waitForProcessed(PID);
    expect(processed.packetId).toBe(PID);
    expect(processed.wellName).toBe('Gabriel 1');

    const outgoingSnap = await db.ref('packets/outgoing').orderByChild('wellName').equalTo('Gabriel 1').once('value');
    const outgoingRows = outgoingSnap.val() || {};
    const outgoingIds = Object.values(outgoingRows).map((row) => (row as { lastPullPacketId?: string }).lastPullPacketId);
    expect(outgoingIds).toContain(PID);

    const well = await db.ref('wells/Gabriel 1/status').once('value');
    expect(well.val()?.lastPull?.packetId).toBe(PID);

    const incomingGone = await db.ref(`packets/incoming/${PID}`).once('value');
    expect(incomingGone.exists()).toBe(false);

    // Offline replay of the same canonical id: processor exact-ID path, no second processed child.
    await db.ref(path).set({
      ...decided.payload,
      driverId: DRIVER,
      driverName: 'Mikezfold',
      companyId: COMPANY,
      payloadDigest: decided.payloadDigest,
    });
    const start = Date.now();
    while (Date.now() - start < 15000) {
      const incoming = await db.ref(`packets/incoming/${PID}`).once('value');
      if (!incoming.exists()) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const processedAll = await db.ref('packets/processed').once('value');
    expect(Object.keys(processedAll.val() || {})).toEqual([PID]);
  });
});
