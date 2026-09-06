/**
 * RTDB emulator join: WB-T ingest writes packets/incoming/{mintedPacketId}.
 * Never talks to production.
 */
import * as admin from 'firebase-admin';
import {
  decideWbtPullTransaction,
  evaluateWbtDriverPacket,
  wbtIncomingPath,
  wbtPullStorageKey,
} from '../wbtPacketAuthorize';

const EMULATOR = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const PROJECT = process.env.GCLOUD_PROJECT || 'wellbuilt-sync';
const hasEmulator = Boolean(EMULATOR);
const describeE2E = hasEmulator ? describe : describe.skip;

const PID = '20260906_120000_Gabriel1_abc123';
const DRIVER = 'wbt-driver-1';
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

describeE2E('emulator: WB-T canonical packet ID is the incoming child key', () => {
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

  it('writes packets/incoming/{packetId} then processed/outgoing with the same id', async () => {
    const decided = evaluateWbtDriverPacket({
      packet: {
        requestType: 'pull',
        wellName: 'Gabriel 1',
        dateTimeUTC: '2026-09-06T17:00:00.000Z',
        tankLevelFeet: 9.5,
        bblsTaken: 140,
        packetId: PID,
        idempotencyKey: PID,
        invoiceDocId: 'inv-1',
        originAppContext: 'wbt',
      },
      companyId: COMPANY,
      wellConfig: { 'Gabriel 1': { route: 'Gabriels', companyId: COMPANY } },
    });
    expect(decided.ok).toBe(true);
    if (!decided.ok) return;

    const key = wbtPullStorageKey(decided.packetId);
    const path = wbtIncomingPath(decided.packetId);
    expect(key).toBe(PID);
    expect(path).toBe(`packets/incoming/${PID}`);
    expect(path).not.toContain('idem_');

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
      const gate = decideWbtPullTransaction({
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
    expect(children[PID].invoiceDocId).toBe('inv-1');
    expect(children[PID].originAppContext).toBe('wbt');

    const triggerPacketId = Object.keys(children)[0];
    expect(triggerPacketId).toBe(PID);

    await db.ref(`packets/processed/${triggerPacketId}`).set({
      ...children[PID],
      packetId: triggerPacketId,
    });
    await db.ref(`packets/outgoing/response_${triggerPacketId}`).set({
      wellName: 'Gabriel 1',
      lastPullPacketId: triggerPacketId,
      lastPullBbls: '140',
      lastPullDateTimeUTC: '2026-09-06T17:00:00.000Z',
    });

    const processed = await db.ref(`packets/processed/${PID}`).once('value');
    expect(processed.exists()).toBe(true);
    expect(processed.val().packetId).toBe(PID);
    const outgoing = await db.ref(`packets/outgoing/response_${PID}`).once('value');
    expect(outgoing.val().lastPullPacketId).toBe(PID);

    const replay = await db.ref(path).transaction((current) => {
      const existing = current && typeof current === 'object'
        ? current as Record<string, unknown>
        : null;
      const gate = decideWbtPullTransaction({
        existing,
        driverId: DRIVER,
        payloadDigest: decided.payloadDigest,
      });
      if (gate.action === 'write') return stamped;
      if (gate.action === 'duplicate') return current;
      return;
    });
    expect(replay.committed).toBe(true);
  });
});
