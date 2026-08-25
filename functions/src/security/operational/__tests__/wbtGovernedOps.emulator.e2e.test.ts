/**
 * RTDB emulator: governed WB-T edit ingest through the REAL processIncomingEdit
 * production handler. Requires FIREBASE_DATABASE_EMULATOR_HOST.
 * Never talks to production. Never replays a live packet.
 *
 * Observed production Gabriel 5 pull: 20260823_112404_Gabriel5_seexdp
 * This fixture is NOT that packet and is not an eligibility claim.
 */
import * as admin from 'firebase-admin';
import { evaluateGovernedWellConfig } from '../governedWellConfig';
import {
  digestGovernedEditIncoming,
  wbmEditIncomingPath,
  wbmEditReceiptPath,
} from '../wbmEditAuthorize';
import { runIngestWbmEdit } from '../ingestWbmEdit';

const EMULATOR = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const PROJECT = process.env.GCLOUD_PROJECT || 'wellbuilt-sync';
const describeE2E = EMULATOR ? describe : describe.skip;

const OBSERVED_LIVE_GABRIEL5 = '20260823_112404_Gabriel5_seexdp';
const PID = '20260823_112300_Gabriel5_fx0001';
const EVENT_A = 'editevt_fx0001_corr_a';
const EVENT_B = 'editevt_fx0001_corr_b';
const DRIVER = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';
const COMPANY = 'liquid-gold';
const ORIGINAL_UTC = '2026-08-23T16:23:00.000Z';
const PREV_UTC = '2026-08-20T16:00:00.000Z';
const PREV_PID = '20260820_160000_Gabriel5_prev01';

type ProcessIncomingEdit = (
  snapshot: admin.database.DataSnapshot,
  context: { params: { packetId: string } },
) => Promise<null>;

describeE2E('emulator: real processIncomingEdit governed edit path', () => {
  jest.setTimeout(30000);
  let db: admin.database.Database;
  let processIncomingEdit: ProcessIncomingEdit;

  beforeAll(() => {
    process.env.FIREBASE_DATABASE_EMULATOR_HOST = EMULATOR!;
    if (!process.env.FIRESTORE_EMULATOR_HOST) {
      process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
    }
    process.env.GCLOUD_PROJECT = PROJECT;
    process.env.FIREBASE_CONFIG = JSON.stringify({
      projectId: PROJECT,
      databaseURL: `http://${EMULATOR}?ns=${PROJECT}-default-rtdb`,
    });
    // Production handler — not a mirrored apply. Import after emulator env is set.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    processIncomingEdit = require('../../../index').processIncomingEdit as ProcessIncomingEdit;
    if (!admin.apps.length) {
      admin.initializeApp({
        projectId: PROJECT,
        databaseURL: `http://${EMULATOR}?ns=${PROJECT}-default-rtdb`,
      });
    }
    db = admin.database();
  });

  beforeEach(async () => {
    await db.ref('packets').set(null);
    await db.ref('well_config').set(null);
    await db.ref('wells').set(null);
    await db.ref('packets/incoming_version').set(0);
    await db.ref(`drivers/profiles/${DRIVER}`).set(null);
  });

  async function version(): Promise<number> {
    const n = (await db.ref('packets/incoming_version').once('value')).val();
    return typeof n === 'number' ? n : Number(n) || 0;
  }

  async function seedOriginal(): Promise<void> {
    await db.ref(`packets/processed/${PREV_PID}`).set({
      packetId: PREV_PID,
      wellName: 'Gabriel 5',
      driverId: DRIVER,
      companyId: COMPANY,
      dateTimeUTC: PREV_UTC,
      tankLevelFeet: 8,
      tankTopInches: 96,
      tankAfterInches: 60,
      bblsTaken: 140,
      flowRateDays: 1.5,
    });
    await db.ref(`packets/processed/${PID}`).set({
      packetId: PID,
      wellName: 'Gabriel 5',
      driverId: DRIVER,
      companyId: COMPANY,
      dateTimeUTC: ORIGINAL_UTC,
      dateTime: '8/23/2026 11:23 AM',
      tankLevelFeet: 10.5,
      tankTopInches: 126,
      tankAfterInches: 84,
      bblsTaken: 160,
      flowRateDays: 1.4,
    });
    await db.ref('packets/outgoing/response_g5').set({
      wellName: 'Gabriel 5',
      lastPullPacketId: PID,
      lastPullBbls: '160',
      lastPullDateTimeUTC: ORIGINAL_UTC,
    });
    await db.ref('well_config/Gabriel 5').set({
      route: 'Gabriels',
      companyId: COMPANY,
      ndicApiNo: '33-053-01234-00-00',
      h2sStatus: 'low',
      waterWeight: 8.34,
      bblPerFoot: 40,
      tanks: 2,
      tankCapacity: 400,
      tankHeight: 20,
      pullBbls: 140,
      bottomLevel: 1,
      loadLine: 1,
    });
    await db.ref(`drivers/profiles/${DRIVER}`).set({
      assignedRoutes: ['Gabriels'],
      assignedWells: [],
      companyId: COMPANY,
    });
  }

  async function ingest(packet: Record<string, unknown>) {
    const wellSnap = await db.ref('well_config').once('value');
    const origSnap = await db.ref(`packets/processed/${PID}`).once('value');
    return runIngestWbmEdit({
      packet,
      driverId: DRIVER,
      uid: 'uid-a',
      displayName: 'Pat',
      authSource: 'secure',
      companyId: COMPANY,
      assignedRoutes: ['Gabriels'],
      assignedWells: [],
      wellConfig: wellSnap.val() as Record<string, unknown>,
      original: origSnap.val() as Record<string, unknown>,
      readReceipt: async (editEventId) => {
        const snap = await db.ref(wbmEditReceiptPath(editEventId)).once('value');
        return snap.exists() ? (snap.val() as Record<string, unknown>) : null;
      },
      writeIncoming: async (path, decide) => {
        const ref = db.ref(path);
        const box: { outcome: 'write' | 'queued' | 'abort'; abortReason: string } = {
          outcome: 'write',
          abortReason: 'ingest_conflict',
        };
        const tx = await ref.transaction((current) => {
          const existing = current && typeof current === 'object'
            ? current as Record<string, unknown>
            : null;
          const gate = decide(existing);
          if (gate.action === 'write') {
            box.outcome = 'write';
            return gate.stamped;
          }
          if (gate.action === 'queued') {
            box.outcome = 'queued';
            return current;
          }
          box.outcome = 'abort';
          box.abortReason = gate.reason;
          return;
        });
        return { committed: tx.committed, outcome: box.outcome, abortReason: box.abortReason };
      },
    });
  }

  async function invokeHandler(incomingPath: string): Promise<void> {
    const snapshot = await db.ref(incomingPath).once('value');
    const packetId = incomingPath.split('/').pop() as string;
    await processIncomingEdit(snapshot, { params: { packetId } });
  }

  it('does not treat the observed production Gabriel 5 id as this fixture', () => {
    expect(PID).not.toBe(OBSERVED_LIVE_GABRIEL5);
    expect(EVENT_A).not.toBe(OBSERVED_LIVE_GABRIEL5);
  });

  it('consumes incoming, updates processed/outgoing/history, two distinct edits, retry idempotent', async () => {
    await seedOriginal();

    const packetA = {
      requestType: 'edit',
      wellName: 'Gabriel 5',
      originalPacketId: PID,
      packetId: PID,
      editEventId: EVENT_A,
      tankLevelFeet: 9.5,
      bblsTaken: 140,
      wellDown: false,
      idempotencyKey: EVENT_A,
    };

    const first = await ingest(packetA);
    expect(first).toMatchObject({
      ok: true,
      status: 'pending',
      originalPacketId: PID,
      editEventId: EVENT_A,
      incomingPath: wbmEditIncomingPath(EVENT_A),
    });
    if (!first.ok) return;

    const queued = await ingest(packetA);
    expect(queued).toMatchObject({ ok: true, status: 'pending', editEventId: EVENT_A });

    await invokeHandler(first.incomingPath);

    const incomingAfter = await db.ref(first.incomingPath).once('value');
    expect(incomingAfter.exists()).toBe(false);

    const processedAfterA = (await db.ref(`packets/processed/${PID}`).once('value')).val() as Record<string, unknown>;
    expect(processedAfterA.packetId).toBe(PID);
    expect(processedAfterA.bblsTaken).toBe(140);
    expect(processedAfterA.dateTimeUTC).toBe(ORIGINAL_UTC);
    expect(processedAfterA.editCount).toBe(1);

    const historyA = (await db.ref(`packets/editHistory/${PID}/${EVENT_A}`).once('value')).val() as Record<string, unknown>;
    expect(historyA).toMatchObject({
      eventId: EVENT_A,
      packetId: PID,
      sequence: 1,
      outcome: 'applied',
      payloadDigest: first.payloadDigest,
    });
    expect(await version()).toBe(1);

    const receiptA = (await db.ref(wbmEditReceiptPath(EVENT_A)).once('value')).val() as Record<string, unknown>;
    expect(receiptA).toMatchObject({
      editEventId: EVENT_A,
      originalPacketId: PID,
      payloadDigest: first.payloadDigest,
      status: 'accepted',
    });

    const outgoingAfterA = (await db.ref('packets/outgoing/response_g5').once('value')).val() as Record<string, unknown>;
    expect(outgoingAfterA).toMatchObject({
      isEdit: true,
      originalPacketId: PID,
      lastPullPacketId: PID,
      lastPullBbls: '140',
      lastPullDateTimeUTC: ORIGINAL_UTC,
    });

    const appliedAck = await ingest(packetA);
    expect(appliedAck).toMatchObject({ ok: true, status: 'accepted', editEventId: EVENT_A });
    expect(await version()).toBe(1);

    const retryIncoming = await ingest(packetA);
    expect(retryIncoming).toMatchObject({ ok: true, status: 'accepted' });
    expect((await db.ref(wbmEditIncomingPath(EVENT_A)).once('value')).exists()).toBe(false);
    expect(await version()).toBe(1);

    const packetB = {
      ...packetA,
      editEventId: EVENT_B,
      idempotencyKey: EVENT_B,
      tankLevelFeet: 9.0,
      bblsTaken: 130,
    };
    const second = await ingest(packetB);
    expect(second).toMatchObject({
      ok: true,
      status: 'pending',
      originalPacketId: PID,
      editEventId: EVENT_B,
    });
    if (!second.ok) return;
    expect(second.editEventId).not.toBe(EVENT_A);

    await invokeHandler(second.incomingPath);

    const processedAfterB = (await db.ref(`packets/processed/${PID}`).once('value')).val() as Record<string, unknown>;
    expect(processedAfterB.packetId).toBe(PID);
    expect(processedAfterB.bblsTaken).toBe(130);
    expect(processedAfterB.editCount).toBe(2);

    const historyRoot = (await db.ref(`packets/editHistory/${PID}`).once('value')).val() as Record<string, unknown>;
    expect(Object.keys(historyRoot).sort()).toEqual([EVENT_A, EVENT_B].sort());
    expect((historyRoot[EVENT_A] as Record<string, unknown>).sequence).toBe(1);
    expect((historyRoot[EVENT_B] as Record<string, unknown>).sequence).toBe(2);
    expect((historyRoot[EVENT_A] as Record<string, unknown>).payloadDigest).toBe(first.payloadDigest);
    expect((historyRoot[EVENT_B] as Record<string, unknown>).payloadDigest).toBe(second.payloadDigest);
    expect((historyRoot[EVENT_A] as Record<string, unknown>).payloadDigest)
      .not.toBe((historyRoot[EVENT_B] as Record<string, unknown>).payloadDigest);
    expect(await version()).toBe(2);

    await db.ref(wbmEditIncomingPath(EVENT_A)).set({
      requestType: 'edit',
      wellName: 'Gabriel 5',
      originalPacketId: PID,
      packetId: PID,
      editEventId: EVENT_A,
      tankLevelFeet: 9.5,
      bblsTaken: 140,
      wellDown: false,
      payloadDigest: first.payloadDigest,
      driverId: DRIVER,
    });
    await invokeHandler(wbmEditIncomingPath(EVENT_A));
    const processedRetry = (await db.ref(`packets/processed/${PID}`).once('value')).val() as Record<string, unknown>;
    expect(processedRetry.editCount).toBe(2);
    expect(processedRetry.bblsTaken).toBe(130);
    expect((await db.ref(wbmEditIncomingPath(EVENT_A)).once('value')).exists()).toBe(false);
    expect(await version()).toBe(2);

    const cfg = evaluateGovernedWellConfig({
      companyId: COMPANY,
      assignedRoutes: ['Gabriels'],
      assignedWells: [],
      wellConfig: (await db.ref('well_config').once('value')).val() as Record<string, unknown>,
      wellName: 'Gabriel 5',
      assignmentKey: PID,
    });
    expect(cfg).toMatchObject({ ok: true, found: true });
    if (!cfg.found) return;
    expect(cfg.config.wellName).toBe('Gabriel 5');
    expect(cfg.config.ndicApiNo).toBe('33-053-01234-00-00');
    expect(cfg.config.bblPerFoot).toBe(40);
  });

  it('same event + different digest is conflict with no overwrite or replacement receipt', async () => {
    await seedOriginal();
    const packetA = {
      requestType: 'edit',
      wellName: 'Gabriel 5',
      originalPacketId: PID,
      packetId: PID,
      editEventId: EVENT_A,
      tankLevelFeet: 9.5,
      bblsTaken: 140,
      wellDown: false,
      idempotencyKey: EVENT_A,
    };
    const first = await ingest(packetA);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await invokeHandler(first.incomingPath);
    const digestA = first.payloadDigest;
    const receiptBefore = (await db.ref(wbmEditReceiptPath(EVENT_A)).once('value')).val();

    await db.ref(wbmEditIncomingPath(EVENT_A)).set({
      requestType: 'edit',
      wellName: 'Gabriel 5',
      originalPacketId: PID,
      packetId: PID,
      editEventId: EVENT_A,
      tankLevelFeet: 8,
      bblsTaken: 200,
      wellDown: false,
      idempotencyKey: EVENT_A,
    });
    await invokeHandler(wbmEditIncomingPath(EVENT_A));

    const processed = (await db.ref(`packets/processed/${PID}`).once('value')).val() as Record<string, unknown>;
    expect(processed.bblsTaken).toBe(140);
    expect(processed.editCount).toBe(1);
    const history = (await db.ref(`packets/editHistory/${PID}/${EVENT_A}`).once('value')).val() as Record<string, unknown>;
    expect(history.payloadDigest).toBe(digestA);
    expect(history.outcome).toBe('applied');
    const receiptAfter = (await db.ref(wbmEditReceiptPath(EVENT_A)).once('value')).val() as Record<string, unknown>;
    expect(receiptAfter).toEqual(receiptBefore);
    expect(receiptAfter.status).toBe('accepted');
    expect(receiptAfter.payloadDigest).toBe(digestA);
    expect((await db.ref(wbmEditIncomingPath(EVENT_A)).once('value')).exists()).toBe(false);
    expect(await version()).toBe(1);
  });

  it('governed no-op writes an acknowledged receipt and does not strand or reapply', async () => {
    await seedOriginal();
    const packet = {
      requestType: 'edit',
      wellName: 'Gabriel 5',
      originalPacketId: PID,
      packetId: PID,
      editEventId: EVENT_A,
      tankLevelFeet: 10.5,
      bblsTaken: 160,
      wellDown: false,
      idempotencyKey: EVENT_A,
    };
    const queued = await ingest(packet);
    expect(queued).toMatchObject({ ok: true, status: 'pending' });
    if (!queued.ok) return;
    await invokeHandler(queued.incomingPath);
    expect((await db.ref(queued.incomingPath).once('value')).exists()).toBe(false);
    const receipt = (await db.ref(wbmEditReceiptPath(EVENT_A)).once('value')).val() as Record<string, unknown>;
    expect(receipt).toMatchObject({
      status: 'acknowledged',
      reason: 'material_noop',
      editEventId: EVENT_A,
      originalPacketId: PID,
      payloadDigest: queued.payloadDigest,
    });
    const history = (await db.ref(`packets/editHistory/${PID}/${EVENT_A}`).once('value')).val() as Record<string, unknown>;
    expect(history.outcome).toBe('noop');
    const processed = (await db.ref(`packets/processed/${PID}`).once('value')).val() as Record<string, unknown>;
    expect(processed.bblsTaken).toBe(160);
    expect(processed.editCount).toBeUndefined();
    expect(await version()).toBe(0);
    const ack = await ingest(packet);
    expect(ack).toMatchObject({ ok: true, status: 'acknowledged' });
  });

  it('governed stale revision is rejected with a durable receipt, not silently dropped', async () => {
    await seedOriginal();
    await db.ref(`packets/processed/${PID}/lastRevisionAt`).set('2026-08-23T18:00:00.000Z');
    const incoming = {
      requestType: 'edit',
      wellName: 'Gabriel 5',
      originalPacketId: PID,
      packetId: PID,
      editEventId: EVENT_A,
      tankLevelFeet: 9.5,
      bblsTaken: 140,
      wellDown: false,
      idempotencyKey: EVENT_A,
      revisionAt: '2026-08-23T17:00:00.000Z',
      driverId: DRIVER,
    };
    const digest = digestGovernedEditIncoming(incoming);
    await db.ref(wbmEditIncomingPath(EVENT_A)).set({ ...incoming, payloadDigest: digest });
    await invokeHandler(wbmEditIncomingPath(EVENT_A));
    expect((await db.ref(wbmEditIncomingPath(EVENT_A)).once('value')).exists()).toBe(false);
    const receipt = (await db.ref(wbmEditReceiptPath(EVENT_A)).once('value')).val() as Record<string, unknown>;
    expect(receipt).toMatchObject({
      status: 'rejected',
      reason: 'stale_revision',
      editEventId: EVENT_A,
      originalPacketId: PID,
      payloadDigest: digest,
    });
    const processed = (await db.ref(`packets/processed/${PID}`).once('value')).val() as Record<string, unknown>;
    expect(processed.bblsTaken).toBe(160);
    expect(await version()).toBe(0);
  });

  it('no-level applied edit writes history+receipt and advances version once', async () => {
    await seedOriginal();
    const packet = {
      requestType: 'edit',
      wellName: 'Gabriel 5',
      originalPacketId: PID,
      packetId: PID,
      editEventId: EVENT_A,
      tankLevelFeet: 0,
      bblsTaken: 155,
      wellDown: false,
      idempotencyKey: EVENT_A,
    };
    const queued = await ingest(packet);
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    await invokeHandler(queued.incomingPath);
    const processed = (await db.ref(`packets/processed/${PID}`).once('value')).val() as Record<string, unknown>;
    expect(processed.noLevel).toBe(true);
    expect(processed.bblsTaken).toBe(155);
    expect(processed.tankTopInches).toBe(0);
    const receipt = (await db.ref(wbmEditReceiptPath(EVENT_A)).once('value')).val() as Record<string, unknown>;
    expect(receipt).toMatchObject({
      status: 'accepted',
      payloadDigest: queued.payloadDigest,
      originalPacketId: PID,
    });
    const history = (await db.ref(`packets/editHistory/${PID}/${EVENT_A}`).once('value')).val() as Record<string, unknown>;
    expect(history).toMatchObject({ outcome: 'applied', payloadDigest: queued.payloadDigest });
    expect(await version()).toBe(1);
    const replay = await ingest(packet);
    expect(replay).toMatchObject({ ok: true, status: 'accepted' });
    expect(await version()).toBe(1);
  });

  it('stored numeric-string BBL/ft is used; missing rate never falls back to 20×tanks', async () => {
    await seedOriginal();
    await db.ref('well_config/Gabriel 5').update({ bblPerFoot: '40' });
    const packet = {
      requestType: 'edit',
      wellName: 'Gabriel 5',
      originalPacketId: PID,
      packetId: PID,
      editEventId: EVENT_A,
      tankLevelFeet: 9.5,
      bblsTaken: 140,
      wellDown: false,
      idempotencyKey: EVENT_A,
    };
    const queued = await ingest(packet);
    if (!queued.ok) return;
    await invokeHandler(queued.incomingPath);
    const processed = (await db.ref(`packets/processed/${PID}`).once('value')).val() as Record<string, unknown>;
    expect(processed.bblsTaken).toBe(140);
    // 9.5 ft = 114"; 140 BBL / 40 BBL/ft * 12 = 42"; after = 72"
    expect(processed.tankAfterInches).toBe(72);

    await db.ref('packets').set(null);
    await db.ref('packets/incoming_version').set(0);
    await seedOriginal();
    await db.ref('well_config/Gabriel 5').set({
      route: 'Gabriels',
      companyId: COMPANY,
      tanks: 2,
    });
    const missing = await ingest({ ...packet, editEventId: EVENT_B, idempotencyKey: EVENT_B });
    if (!missing.ok) return;
    const before = (await db.ref(`packets/processed/${PID}`).once('value')).val() as Record<string, unknown>;
    await invokeHandler(missing.incomingPath);
    const after = (await db.ref(`packets/processed/${PID}`).once('value')).val() as Record<string, unknown>;
    expect(after.bblsTaken).toBe(before.bblsTaken);
    expect(after.tankAfterInches).toBe(before.tankAfterInches);
    const rejected = (await db.ref(wbmEditReceiptPath(EVENT_B)).once('value')).val() as Record<string, unknown>;
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: 'bbl_per_foot_unavailable',
      originalPacketId: PID,
    });
    expect(await version()).toBe(0);
  });

  it('derives BBL/ft from capacity/height/tanks including numeric strings', async () => {
    await seedOriginal();
    await db.ref('well_config/Gabriel 5').set({
      route: 'Gabriels',
      companyId: COMPANY,
      tankCapacity: '400',
      tankHeight: '20',
      tanks: '2',
      pullBbls: 140,
      bottomLevel: 1,
      loadLine: 1,
    });
    const packet = {
      requestType: 'edit',
      wellName: 'Gabriel 5',
      originalPacketId: PID,
      packetId: PID,
      editEventId: EVENT_A,
      tankLevelFeet: 9.5,
      bblsTaken: 140,
      wellDown: false,
      idempotencyKey: EVENT_A,
    };
    const queued = await ingest(packet);
    if (!queued.ok) return;
    await invokeHandler(queued.incomingPath);
    const processed = (await db.ref(`packets/processed/${PID}`).once('value')).val() as Record<string, unknown>;
    expect(processed.tankAfterInches).toBe(72);
    expect((await db.ref(wbmEditReceiptPath(EVENT_A)).once('value')).val().status).toBe('accepted');
  });

  it('standalone display dateTime does not mutate operational instant; offsetless UTC is ignored', async () => {
    await seedOriginal();
    const packet = {
      requestType: 'edit',
      wellName: 'Gabriel 5',
      originalPacketId: PID,
      packetId: PID,
      editEventId: EVENT_A,
      tankLevelFeet: 9.5,
      bblsTaken: 140,
      wellDown: false,
      idempotencyKey: EVENT_A,
      dateTime: '1/1/1999 3:00 AM',
    };
    const queued = await ingest(packet);
    if (!queued.ok) return;
    expect(queued.ok && !('dateTimeUTC' in (queued as { payloadDigest: string }))).toBe(true);
    await invokeHandler(queued.incomingPath);
    const processed = (await db.ref(`packets/processed/${PID}`).once('value')).val() as Record<string, unknown>;
    expect(processed.dateTimeUTC).toBe(ORIGINAL_UTC);
    expect(processed.dateTime).toBe('8/23/2026 11:23 AM');

    await db.ref(wbmEditIncomingPath(EVENT_B)).set({
      requestType: 'edit',
      wellName: 'Gabriel 5',
      originalPacketId: PID,
      packetId: PID,
      editEventId: EVENT_B,
      tankLevelFeet: 9.0,
      bblsTaken: 130,
      wellDown: false,
      idempotencyKey: EVENT_B,
      dateTimeUTC: '2026-08-23T18:00:00',
      dateTime: '8/23/2026 1:00 PM',
      payloadDigest: 'deadbeef',
    });
    await invokeHandler(wbmEditIncomingPath(EVENT_B));
    const afterOffsetless = (await db.ref(`packets/processed/${PID}`).once('value')).val() as Record<string, unknown>;
    expect(afterOffsetless.dateTimeUTC).toBe(ORIGINAL_UTC);
  });
});
