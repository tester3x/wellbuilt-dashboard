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
import {
  applyStatePath,
  armGovernedEditLeaseHold,
  clearGovernedEditLeaseHold,
  decideAdvancePhase,
  parseApplyState,
  setGovernedEditApplyFault,
  setGovernedEditLeaseMs,
  setGovernedEditLeaseRenew,
  shouldRetriggerEditIncoming,
  VERSION_LEDGER_PATH,
  withPhase,
} from '../governedEditApplyState';

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
  jest.setTimeout(90000);
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

  afterEach(() => {
    clearGovernedEditLeaseHold();
    setGovernedEditApplyFault(null);
    setGovernedEditLeaseMs(30_000);
    setGovernedEditLeaseRenew(true);
  });

  beforeEach(async () => {
    clearGovernedEditLeaseHold();
    setGovernedEditApplyFault(null);
    setGovernedEditLeaseMs(30_000);
    setGovernedEditLeaseRenew(true);
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

  async function expectNoAccepted(): Promise<void> {
    const rec = (await db.ref(wbmEditReceiptPath(EVENT_A)).once('value')).val();
    expect(rec == null || rec.status !== 'accepted').toBe(true);
  }

  it('crash before processed mutation: no accepted receipt; retry recovers', async () => {
    await seedOriginal();
    const queued = await ingest(packetA);
    if (!queued.ok) return;
    setGovernedEditApplyFault('after_captured');
    await expect(invokeHandler(queued.incomingPath)).rejects.toThrow('GOVERNED_EDIT_APPLY_FAULT:after_captured');
    expect((await db.ref(`packets/processed/${PID}`).once('value')).val().bblsTaken).toBe(160);
    await expectNoAccepted();
    expect((await db.ref(queued.incomingPath).once('value')).exists()).toBe(true);
    expect(await version()).toBe(0);
    setGovernedEditApplyFault(null);
    await invokeHandler(queued.incomingPath);
    expect((await db.ref(wbmEditReceiptPath(EVENT_A)).once('value')).val().status).toBe('accepted');
    expect((await db.ref(`packets/processed/${PID}`).once('value')).val().bblsTaken).toBe(140);
    expect(await version()).toBe(1);
  });

  it('crash after processed mutation before outgoing: no accepted receipt; retry does not double-apply', async () => {
    await seedOriginal();
    const queued = await ingest(packetA);
    if (!queued.ok) return;
    setGovernedEditApplyFault('after_mutated');
    await expect(invokeHandler(queued.incomingPath)).rejects.toThrow('GOVERNED_EDIT_APPLY_FAULT:after_mutated');
    expect((await db.ref(`packets/processed/${PID}`).once('value')).val().bblsTaken).toBe(140);
    expect((await db.ref(`packets/editHistory/${PID}/${EVENT_A}`).once('value')).exists()).toBe(true);
    await expectNoAccepted();
    expect((await db.ref(queued.incomingPath).once('value')).exists()).toBe(true);
    expect(await version()).toBe(0);
    setGovernedEditApplyFault(null);
    await invokeHandler(queued.incomingPath);
    expect((await db.ref(wbmEditReceiptPath(EVENT_A)).once('value')).val().status).toBe('accepted');
    expect((await db.ref(`packets/editHistory/${PID}`).once('value')).val()[EVENT_A].outcome).toBe('applied');
    expect(Object.keys((await db.ref(`packets/editHistory/${PID}`).once('value')).val())).toEqual([EVENT_A]);
    expect(await version()).toBe(1);
    const outgoing = (await db.ref('packets/outgoing/response_g5').once('value')).val();
    expect(outgoing.lastPullBbls).toBe('140');
  });

  it('outgoing write failure: no accepted receipt; retry completes outgoing', async () => {
    await seedOriginal();
    const queued = await ingest(packetA);
    if (!queued.ok) return;
    setGovernedEditApplyFault('outgoing_fail');
    await expect(invokeHandler(queued.incomingPath)).rejects.toThrow('GOVERNED_EDIT_APPLY_FAULT:outgoing_fail');
    await expectNoAccepted();
    expect((await db.ref('packets/outgoing/response_g5').once('value')).val().lastPullBbls).toBe('160');
    setGovernedEditApplyFault(null);
    await invokeHandler(queued.incomingPath);
    expect((await db.ref(wbmEditReceiptPath(EVENT_A)).once('value')).val().status).toBe('accepted');
    expect((await db.ref('packets/outgoing/response_g5').once('value')).val().lastPullBbls).toBe('140');
    expect(await version()).toBe(1);
  });

  it('crash after outgoing/current before version: no accepted receipt; retry publishes version once', async () => {
    await seedOriginal();
    const queued = await ingest(packetA);
    if (!queued.ok) return;
    setGovernedEditApplyFault('after_downstream');
    await expect(invokeHandler(queued.incomingPath)).rejects.toThrow('GOVERNED_EDIT_APPLY_FAULT:after_downstream');
    await expectNoAccepted();
    expect((await db.ref('packets/outgoing/response_g5').once('value')).val().lastPullBbls).toBe('140');
    expect(await version()).toBe(0);
    setGovernedEditApplyFault(null);
    await invokeHandler(queued.incomingPath);
    expect((await db.ref(wbmEditReceiptPath(EVENT_A)).once('value')).val().status).toBe('accepted');
    expect(await version()).toBe(1);
  });

  it('version transaction null: no accepted receipt; remains resumable', async () => {
    await seedOriginal();
    const queued = await ingest(packetA);
    if (!queued.ok) return;
    setGovernedEditApplyFault('version_null');
    await invokeHandler(queued.incomingPath);
    await expectNoAccepted();
    expect((await db.ref(queued.incomingPath).once('value')).exists()).toBe(true);
    expect(await version()).toBe(0);
    const st = (await db.ref(applyStatePath(EVENT_A)).once('value')).val();
    expect(st.phase).toBe('downstream');
    setGovernedEditApplyFault(null);
    await invokeHandler(queued.incomingPath);
    expect((await db.ref(wbmEditReceiptPath(EVENT_A)).once('value')).val().status).toBe('accepted');
    expect(await version()).toBe(1);
  });

  it('crash after version before receipt: retry does not increment version again', async () => {
    await seedOriginal();
    const queued = await ingest(packetA);
    if (!queued.ok) return;
    setGovernedEditApplyFault('after_versioned');
    await expect(invokeHandler(queued.incomingPath)).rejects.toThrow('GOVERNED_EDIT_APPLY_FAULT:after_versioned');
    await expectNoAccepted();
    expect(await version()).toBe(1);
    setGovernedEditApplyFault(null);
    await invokeHandler(queued.incomingPath);
    expect((await db.ref(wbmEditReceiptPath(EVENT_A)).once('value')).val().status).toBe('accepted');
    expect(await version()).toBe(1);
  });

  it('no-level path crash boundaries match the durable invariant', async () => {
    await seedOriginal();
    const packet = { ...packetA, tankLevelFeet: 0, bblsTaken: 155 };
    const queued = await ingest(packet);
    if (!queued.ok) return;
    setGovernedEditApplyFault('after_mutated');
    await expect(invokeHandler(queued.incomingPath)).rejects.toThrow('GOVERNED_EDIT_APPLY_FAULT:after_mutated');
    expect((await db.ref(`packets/processed/${PID}`).once('value')).val().noLevel).toBe(true);
    await expectNoAccepted();
    expect(await version()).toBe(0);
    setGovernedEditApplyFault(null);
    await invokeHandler(queued.incomingPath);
    expect((await db.ref(wbmEditReceiptPath(EVENT_A)).once('value')).val().status).toBe('accepted');
    expect(await version()).toBe(1);
    const replay = await ingest(packet);
    expect(replay).toMatchObject({ ok: true, status: 'accepted' });
    expect(await version()).toBe(1);
  });

  async function waitFor(pred: () => Promise<boolean>, ms = 8000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (await pred()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('waitFor timeout');
  }

  async function ledgerClaim(editEventId: string): Promise<{ payloadDigest: string; seq: number } | null> {
    const v = (await db.ref(`${VERSION_LEDGER_PATH}/claims/${editEventId}`).once('value')).val();
    if (!v || typeof v !== 'object') return null;
    return v as { payloadDigest: string; seq: number };
  }

  it('two different edits concurrent versioning each keep an event-specific claim', async () => {
    await seedOriginal();
    const queuedA = await ingest(packetA);
    const queuedB = await ingest({
      ...packetA,
      editEventId: EVENT_B,
      idempotencyKey: EVENT_B,
      tankLevelFeet: 9.0,
      bblsTaken: 130,
    });
    expect(queuedA.ok && queuedB.ok).toBe(true);
    if (!queuedA.ok || !queuedB.ok) return;

    await Promise.all([
      invokeHandler(queuedA.incomingPath),
      invokeHandler(queuedB.incomingPath),
    ]);

    const claimA = await ledgerClaim(EVENT_A);
    const claimB = await ledgerClaim(EVENT_B);
    expect(claimA?.payloadDigest).toBe(queuedA.payloadDigest);
    expect(claimB?.payloadDigest).toBe(queuedB.payloadDigest);
    expect(claimA?.seq).not.toBe(claimB?.seq);
    expect(typeof claimA?.seq).toBe('number');
    expect(typeof claimB?.seq).toBe('number');
    expect(await version()).toBe(2);
    expect((await db.ref(wbmEditReceiptPath(EVENT_A)).once('value')).val().status).toBe('accepted');
    expect((await db.ref(wbmEditReceiptPath(EVENT_B)).once('value')).val().status).toBe('accepted');
    const history = (await db.ref(`packets/editHistory/${PID}`).once('value')).val() as Record<string, unknown>;
    expect(Object.keys(history).sort()).toEqual([EVENT_A, EVENT_B].sort());
    expect((history[EVENT_A] as Record<string, unknown>).packetId).toBe(PID);
    expect((history[EVENT_B] as Record<string, unknown>).packetId).toBe(PID);
  });

  it('A crash then B publish does not let A treat B\'s counter as A\'s proof', async () => {
    await seedOriginal();
    const queuedA = await ingest(packetA);
    const queuedB = await ingest({
      ...packetA,
      editEventId: EVENT_B,
      idempotencyKey: EVENT_B,
      tankLevelFeet: 9.0,
      bblsTaken: 130,
    });
    if (!queuedA.ok || !queuedB.ok) return;

    setGovernedEditApplyFault('after_downstream');
    await expect(invokeHandler(queuedA.incomingPath)).rejects.toThrow('GOVERNED_EDIT_APPLY_FAULT:after_downstream');
    expect(await ledgerClaim(EVENT_A)).toBeNull();
    expect(await version()).toBe(0);

    setGovernedEditApplyFault(null);
    await invokeHandler(queuedB.incomingPath);
    const claimB = await ledgerClaim(EVENT_B);
    expect(claimB?.seq).toBe(1);
    expect(await version()).toBe(1);
    expect((await db.ref(wbmEditReceiptPath(EVENT_A)).once('value')).val() == null
      || (await db.ref(wbmEditReceiptPath(EVENT_A)).once('value')).val().status !== 'accepted').toBe(true);

    await invokeHandler(queuedA.incomingPath);
    const claimA = await ledgerClaim(EVENT_A);
    expect(claimA?.seq).toBe(2);
    expect(claimA?.seq).not.toBe(claimB?.seq);
    expect(await version()).toBe(2);
    expect((await db.ref(wbmEditReceiptPath(EVENT_A)).once('value')).val().status).toBe('accepted');
    expect((await db.ref(wbmEditReceiptPath(EVENT_B)).once('value')).val().status).toBe('accepted');
  });

  it('same event two concurrent invocations: one owner, one history, one version claim', async () => {
    await seedOriginal();
    const queued = await ingest(packetA);
    if (!queued.ok) return;
    const release = armGovernedEditLeaseHold();
    const first = invokeHandler(queued.incomingPath);
    await waitFor(async () => {
      const st = (await db.ref(applyStatePath(EVENT_A)).once('value')).val();
      return !!(st && st.lease && st.lease.ownerId);
    });
    await invokeHandler(queued.incomingPath);
    release();
    await first;

    const history = (await db.ref(`packets/editHistory/${PID}`).once('value')).val() as Record<string, unknown>;
    expect(Object.keys(history)).toEqual([EVENT_A]);
    expect(await ledgerClaim(EVENT_A)).toMatchObject({ payloadDigest: queued.payloadDigest, seq: 1 });
    expect(await version()).toBe(1);
    expect((await db.ref(wbmEditReceiptPath(EVENT_A)).once('value')).val().status).toBe('accepted');
    expect((await db.ref(`packets/processed/${PID}`).once('value')).val().bblsTaken).toBe(140);
  });

  it('resumeAt during active execution does not duplicate apply', async () => {
    await seedOriginal();
    const queued = await ingest(packetA);
    if (!queued.ok) return;
    const release = armGovernedEditLeaseHold();
    const first = invokeHandler(queued.incomingPath);
    await waitFor(async () => {
      const st = (await db.ref(applyStatePath(EVENT_A)).once('value')).val();
      return !!(st && st.lease);
    });
    await db.ref(queued.incomingPath).update({ resumeAt: Date.now() });
    await invokeHandler(queued.incomingPath);
    release();
    await first;
    expect(Object.keys((await db.ref(`packets/editHistory/${PID}`).once('value')).val())).toEqual([EVENT_A]);
    expect(await version()).toBe(1);
  });

  it('watchdog resumeAt during active execution does not duplicate apply', async () => {
    await seedOriginal();
    const queued = await ingest(packetA);
    if (!queued.ok) return;
    const release = armGovernedEditLeaseHold();
    const first = invokeHandler(queued.incomingPath);
    await waitFor(async () => {
      const st = (await db.ref(applyStatePath(EVENT_A)).once('value')).val();
      return !!(st && st.lease);
    });
    const st = parseApplyState((await db.ref(applyStatePath(EVENT_A)).once('value')).val());
    expect(shouldRetriggerEditIncoming({ isGoverned: true, applyState: st })).toBe(true);
    await db.ref(queued.incomingPath).update({ resumeAt: Date.now() });
    await invokeHandler(queued.incomingPath);
    release();
    await first;
    expect(Object.keys((await db.ref(`packets/editHistory/${PID}`).once('value')).val())).toEqual([EVENT_A]);
    expect(await version()).toBe(1);
  });

  it('stale owner cannot regress a newer checkpoint after lease expiry takeover', async () => {
    await seedOriginal();
    const queued = await ingest(packetA);
    if (!queued.ok) return;
    setGovernedEditLeaseRenew(false);
    setGovernedEditLeaseMs(200);
    const release = armGovernedEditLeaseHold();
    const stale = invokeHandler(queued.incomingPath);
    await waitFor(async () => {
      const st = (await db.ref(applyStatePath(EVENT_A)).once('value')).val();
      return !!(st && st.lease);
    });
    await new Promise((r) => setTimeout(r, 250));
    await invokeHandler(queued.incomingPath);
    expect((await db.ref(wbmEditReceiptPath(EVENT_A)).once('value')).val().status).toBe('accepted');
    const advanced = parseApplyState((await db.ref(applyStatePath(EVENT_A)).once('value')).val());
    expect(advanced?.phase).toBe('terminal');
    release();
    await stale;
    const after = parseApplyState((await db.ref(applyStatePath(EVENT_A)).once('value')).val());
    expect(after?.phase).toBe('terminal');
    expect(after?.assignedVersion).toBe(1);
    expect(await version()).toBe(1);
    expect(Object.keys((await db.ref(`packets/editHistory/${PID}`).once('value')).val())).toEqual([EVENT_A]);
  });

  it('lease expiry recovery: expired owner is taken over and the edit finishes', async () => {
    await seedOriginal();
    const queued = await ingest(packetA);
    if (!queued.ok) return;
    setGovernedEditLeaseRenew(false);
    const now = Date.now();
    await db.ref(applyStatePath(EVENT_A)).set({
      editEventId: EVENT_A,
      originalPacketId: PID,
      incomingId: EVENT_A,
      payloadDigest: queued.payloadDigest,
      wellName: 'Gabriel 5',
      noLevel: false,
      phase: 'captured',
      historyWritten: false,
      processedWritten: false,
      outgoingRequired: false,
      outgoingCommitted: false,
      wellStatusCommitted: false,
      versionPublished: false,
      publishedVersion: null,
      assignedVersion: null,
      seqBefore: null,
      incomingPayload: packetA,
      lease: { ownerId: 'dead-owner', expiresAt: now - 5_000 },
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    });
    await invokeHandler(queued.incomingPath);
    expect((await db.ref(wbmEditReceiptPath(EVENT_A)).once('value')).val().status).toBe('accepted');
    expect(await version()).toBe(1);
    const st = parseApplyState((await db.ref(applyStatePath(EVENT_A)).once('value')).val());
    expect(st?.phase).toBe('terminal');
    expect(st?.lease == null || st?.lease?.ownerId !== 'dead-owner').toBe(true);
  });

  it('phase monotonicity: versioned→mutated and terminal→downstream are keep/no-op', async () => {
    await seedOriginal();
    const queued = await ingest(packetA);
    if (!queued.ok) return;
    setGovernedEditApplyFault('after_versioned');
    await expect(invokeHandler(queued.incomingPath)).rejects.toThrow('GOVERNED_EDIT_APPLY_FAULT:after_versioned');
    const versioned = parseApplyState((await db.ref(applyStatePath(EVENT_A)).once('value')).val());
    expect(versioned?.phase).toBe('versioned');
    expect(versioned?.assignedVersion).toBe(1);

    await db.ref(applyStatePath(EVENT_A)).transaction((raw) => {
      const current = parseApplyState(raw);
      const decision = decideAdvancePhase({
        current,
        desired: withPhase(current || versioned!, 'mutated', {
          versionPublished: false,
          publishedVersion: null,
          assignedVersion: null,
        }, new Date().toISOString()),
        ownerId: 'stale',
        nowMs: Date.now(),
      });
      if (decision.action === 'write') return decision.state;
      if (decision.action === 'keep') return raw;
      return;
    });
    const stillVersioned = parseApplyState((await db.ref(applyStatePath(EVENT_A)).once('value')).val());
    expect(stillVersioned?.phase).toBe('versioned');
    expect(stillVersioned?.assignedVersion).toBe(1);
    expect(stillVersioned?.publishedVersion).toBe(1);
    expect(stillVersioned?.versionPublished).toBe(true);

    setGovernedEditApplyFault(null);
    await invokeHandler(queued.incomingPath);
    const terminal = parseApplyState((await db.ref(applyStatePath(EVENT_A)).once('value')).val());
    expect(terminal?.phase).toBe('terminal');
    await db.ref(applyStatePath(EVENT_A)).transaction((raw) => {
      const current = parseApplyState(raw);
      const decision = decideAdvancePhase({
        current,
        desired: withPhase(current || terminal!, 'downstream', {}, new Date().toISOString()),
        ownerId: 'stale',
        nowMs: Date.now(),
      });
      if (decision.action === 'write') return decision.state;
      if (decision.action === 'keep') return raw;
      return;
    });
    const stillTerminal = parseApplyState((await db.ref(applyStatePath(EVENT_A)).once('value')).val());
    expect(stillTerminal?.phase).toBe('terminal');
    expect(stillTerminal?.assignedVersion).toBe(1);
    expect(await version()).toBe(1);
  });

  it('crash before captured: watchdog/retry reconstructs and does not quarantine', async () => {
    await seedOriginal();
    const queued = await ingest(packetA);
    if (!queued.ok) return;
    setGovernedEditApplyFault('before_captured');
    await expect(invokeHandler(queued.incomingPath)).rejects.toThrow('GOVERNED_EDIT_APPLY_FAULT:before_captured');
    expect((await db.ref(applyStatePath(EVENT_A)).once('value')).exists()).toBe(false);
    expect((await db.ref(queued.incomingPath).once('value')).exists()).toBe(true);
    expect(shouldRetriggerEditIncoming({ isGoverned: true, applyState: null })).toBe(true);
    expect((await db.ref('packets/rejected').once('value')).exists()).toBe(false);
    await db.ref(queued.incomingPath).update({ resumeAt: Date.now() });
    setGovernedEditApplyFault(null);
    await invokeHandler(queued.incomingPath);
    expect((await db.ref(wbmEditReceiptPath(EVENT_A)).once('value')).val().status).toBe('accepted');
    expect((await db.ref('packets/rejected').once('value')).exists()).toBe(false);
    expect(await version()).toBe(1);
  });

  it('initial capture idempotency: racing first invocations share one canonical state', async () => {
    await seedOriginal();
    const queued = await ingest(packetA);
    if (!queued.ok) return;
    const release = armGovernedEditLeaseHold();
    const p1 = invokeHandler(queued.incomingPath);
    const p2 = invokeHandler(queued.incomingPath);
    await waitFor(async () => (await db.ref(applyStatePath(EVENT_A)).once('value')).exists());
    const first = parseApplyState((await db.ref(applyStatePath(EVENT_A)).once('value')).val());
    expect(first?.payloadDigest).toBe(queued.payloadDigest);
    expect(first?.editEventId).toBe(EVENT_A);
    release();
    await Promise.all([p1, p2]);
    const after = parseApplyState((await db.ref(applyStatePath(EVENT_A)).once('value')).val());
    expect(after?.payloadDigest).toBe(queued.payloadDigest);
    expect(after?.editEventId).toBe(EVENT_A);
    expect(await ledgerClaim(EVENT_A)).toMatchObject({ payloadDigest: queued.payloadDigest, seq: 1 });
    expect(await version()).toBe(1);
    expect(Object.keys((await db.ref(`packets/editHistory/${PID}`).once('value')).val())).toEqual([EVENT_A]);
  });

  it('concurrent same editEventId different digest remains conflict and steals nothing', async () => {
    await seedOriginal();
    const queued = await ingest(packetA);
    if (!queued.ok) return;
    const release = armGovernedEditLeaseHold();
    const first = invokeHandler(queued.incomingPath);
    await waitFor(async () => (await db.ref(applyStatePath(EVENT_A)).once('value')).exists());
    const conflictIncoming = {
      ...packetA,
      tankLevelFeet: 8,
      bblsTaken: 200,
      payloadDigest: 'deadbeefdeadbeef',
    };
    await db.ref(queued.incomingPath).set(conflictIncoming);
    await invokeHandler(queued.incomingPath);
    release();
    await first;
    expect(await ledgerClaim(EVENT_A)).toMatchObject({ payloadDigest: queued.payloadDigest, seq: 1 });
    expect((await db.ref(`packets/processed/${PID}`).once('value')).val().bblsTaken).toBe(140);
    expect((await db.ref(wbmEditReceiptPath(EVENT_A)).once('value')).val()).toMatchObject({
      status: 'accepted',
      payloadDigest: queued.payloadDigest,
    });
    expect(await version()).toBe(1);
  });

  it('concurrent second corrections to the same original stay separate events', async () => {
    await seedOriginal();
    const queuedA = await ingest(packetA);
    const queuedB = await ingest({
      ...packetA,
      editEventId: EVENT_B,
      idempotencyKey: EVENT_B,
      tankLevelFeet: 9.0,
      bblsTaken: 130,
    });
    if (!queuedA.ok || !queuedB.ok) return;
    await Promise.all([
      invokeHandler(queuedA.incomingPath),
      invokeHandler(queuedB.incomingPath),
    ]);
    const history = (await db.ref(`packets/editHistory/${PID}`).once('value')).val() as Record<string, unknown>;
    expect(Object.keys(history).sort()).toEqual([EVENT_A, EVENT_B].sort());
    expect((history[EVENT_A] as Record<string, unknown>).packetId).toBe(PID);
    expect((history[EVENT_B] as Record<string, unknown>).packetId).toBe(PID);
    expect((history[EVENT_A] as Record<string, unknown>).eventId).toBe(EVENT_A);
    expect((history[EVENT_B] as Record<string, unknown>).eventId).toBe(EVENT_B);
    const claimA = await ledgerClaim(EVENT_A);
    const claimB = await ledgerClaim(EVENT_B);
    expect(claimA?.seq).not.toBe(claimB?.seq);
    expect((await db.ref(`packets/processed/${PID}`).once('value')).val().packetId).toBe(PID);
  });

  it('pre-existing public version 5000 + empty ledger: first governed edit advances the public scalar', async () => {
    await seedOriginal();
    await db.ref('packets/incoming_version').set(5000);
    const queued = await ingest(packetA);
    if (!queued.ok) return;
    await invokeHandler(queued.incomingPath);
    expect(await ledgerClaim(EVENT_A)).toMatchObject({ payloadDigest: queued.payloadDigest, seq: 5001 });
    expect(await version()).toBe(5001);
    expect((await db.ref(wbmEditReceiptPath(EVENT_A)).once('value')).val().status).toBe('accepted');
  });

  it('pre-existing public version 5000 + two concurrent governed edits both publish above the floor', async () => {
    await seedOriginal();
    await db.ref('packets/incoming_version').set(5000);
    const queuedA = await ingest(packetA);
    const queuedB = await ingest({
      ...packetA,
      editEventId: EVENT_B,
      idempotencyKey: EVENT_B,
      tankLevelFeet: 9.0,
      bblsTaken: 130,
    });
    if (!queuedA.ok || !queuedB.ok) return;
    await Promise.all([
      invokeHandler(queuedA.incomingPath),
      invokeHandler(queuedB.incomingPath),
    ]);
    const claimA = await ledgerClaim(EVENT_A);
    const claimB = await ledgerClaim(EVENT_B);
    expect(claimA?.seq).toBeGreaterThan(5000);
    expect(claimB?.seq).toBeGreaterThan(5000);
    expect(claimA?.seq).not.toBe(claimB?.seq);
    const live = await version();
    expect(live).toBeGreaterThanOrEqual(5002);
    expect(live).toBeGreaterThanOrEqual(Math.max(claimA!.seq, claimB!.seq));
    expect((await db.ref(wbmEditReceiptPath(EVENT_A)).once('value')).val().status).toBe('accepted');
    expect((await db.ref(wbmEditReceiptPath(EVENT_B)).once('value')).val().status).toBe('accepted');
  });

  it('legacy/unrelated version movement racing a new governed claim still publishes', async () => {
    await seedOriginal();
    await db.ref('packets/incoming_version').set(5000);
    const queued = await ingest(packetA);
    if (!queued.ok) return;
    const release = armGovernedEditLeaseHold();
    const running = invokeHandler(queued.incomingPath);
    await waitFor(async () => !!(await db.ref(applyStatePath(EVENT_A)).once('value')).val()?.lease);
    await db.ref('packets/incoming_version').transaction((cur) => {
      const n = typeof cur === 'number' ? cur : Number(cur) || 0;
      return n + 1;
    });
    release();
    await running;
    expect((await db.ref(wbmEditReceiptPath(EVENT_A)).once('value')).val().status).toBe('accepted');
    const claim = await ledgerClaim(EVENT_A);
    expect(claim?.seq).toBeGreaterThan(5000);
    expect(await version()).toBeGreaterThan(5000);
    expect(await version()).toBeGreaterThanOrEqual(claim!.seq);
  });

  it('crash after event claim but before public publication: retry publishes exactly once', async () => {
    await seedOriginal();
    await db.ref('packets/incoming_version').set(5000);
    const queued = await ingest(packetA);
    if (!queued.ok) return;
    setGovernedEditApplyFault('after_claim_before_public');
    await expect(invokeHandler(queued.incomingPath)).rejects.toThrow('GOVERNED_EDIT_APPLY_FAULT:after_claim_before_public');
    expect(await ledgerClaim(EVENT_A)).toMatchObject({ seq: 5001 });
    expect(await version()).toBe(5000);
    await expectNoAccepted();
    setGovernedEditApplyFault(null);
    await invokeHandler(queued.incomingPath);
    expect(await version()).toBe(5001);
    expect((await db.ref(wbmEditReceiptPath(EVENT_A)).once('value')).val().status).toBe('accepted');
    await invokeHandler(queued.incomingPath);
    expect(await version()).toBe(5001);
  });

  it('crash after public publication before versioned checkpoint: retry does not publish again', async () => {
    await seedOriginal();
    await db.ref('packets/incoming_version').set(5000);
    const queued = await ingest(packetA);
    if (!queued.ok) return;
    setGovernedEditApplyFault('after_public_before_versioned');
    await expect(invokeHandler(queued.incomingPath)).rejects.toThrow('GOVERNED_EDIT_APPLY_FAULT:after_public_before_versioned');
    expect(await version()).toBe(5001);
    await expectNoAccepted();
    setGovernedEditApplyFault(null);
    await invokeHandler(queued.incomingPath);
    expect(await version()).toBe(5001);
    expect((await db.ref(wbmEditReceiptPath(EVENT_A)).once('value')).val().status).toBe('accepted');
  });

  it('existing terminal retry does not advance a mature public scalar again', async () => {
    await seedOriginal();
    await db.ref('packets/incoming_version').set(5000);
    const queued = await ingest(packetA);
    if (!queued.ok) return;
    await invokeHandler(queued.incomingPath);
    expect(await version()).toBe(5001);
    const replay = await ingest(packetA);
    expect(replay).toMatchObject({ ok: true, status: 'accepted' });
    expect(await version()).toBe(5001);
    await db.ref(queued.incomingPath).set({
      ...packetA,
      payloadDigest: queued.payloadDigest,
      driverId: DRIVER,
    });
    await invokeHandler(queued.incomingPath);
    expect(await version()).toBe(5001);
  });

  it('restart with populated ledger and high public scalar stays monotonic', async () => {
    await seedOriginal();
    await db.ref('packets/incoming_version').set(5000);
    await db.ref(VERSION_LEDGER_PATH).set({
      nextSeq: 5000,
      claims: {
        prior_evt: { editEventId: 'prior_evt', payloadDigest: 'prior', seq: 5000 },
      },
    });
    const queued = await ingest(packetA);
    if (!queued.ok) return;
    await invokeHandler(queued.incomingPath);
    expect(await ledgerClaim(EVENT_A)).toMatchObject({ seq: 5001 });
    expect(await ledgerClaim('prior_evt')).toMatchObject({ seq: 5000 });
    expect(await version()).toBe(5001);
  });

  it('healthy execution longer than 30s is not taken over; resumeAt and watchdog stay busy', async () => {
    await seedOriginal();
    const queued = await ingest(packetA);
    if (!queued.ok) return;
    const release = armGovernedEditLeaseHold();
    const first = invokeHandler(queued.incomingPath);
    await waitFor(async () => !!(await db.ref(applyStatePath(EVENT_A)).once('value')).val()?.lease);
    await new Promise((r) => setTimeout(r, 31_000));
    await db.ref(queued.incomingPath).update({ resumeAt: Date.now() });
    await invokeHandler(queued.incomingPath);
    await invokeHandler(queued.incomingPath);
    release();
    await first;
    expect(Object.keys((await db.ref(`packets/editHistory/${PID}`).once('value')).val())).toEqual([EVENT_A]);
    expect(await version()).toBe(1);
    expect((await db.ref(wbmEditReceiptPath(EVENT_A)).once('value')).val().status).toBe('accepted');
  });

  it('lost ownership before a business phase exits without mutating processed', async () => {
    await seedOriginal();
    const queued = await ingest(packetA);
    if (!queued.ok) return;
    setGovernedEditLeaseRenew(false);
    setGovernedEditLeaseMs(200);
    const release = armGovernedEditLeaseHold();
    const stale = invokeHandler(queued.incomingPath);
    await waitFor(async () => !!(await db.ref(applyStatePath(EVENT_A)).once('value')).val()?.lease);
    await new Promise((r) => setTimeout(r, 250));
    await invokeHandler(queued.incomingPath);
    expect((await db.ref(wbmEditReceiptPath(EVENT_A)).once('value')).val().status).toBe('accepted');
    const bbls = (await db.ref(`packets/processed/${PID}`).once('value')).val().bblsTaken;
    release();
    await stale;
    expect((await db.ref(`packets/processed/${PID}`).once('value')).val().bblsTaken).toBe(bbls);
    expect(Object.keys((await db.ref(`packets/editHistory/${PID}`).once('value')).val())).toEqual([EVENT_A]);
  });
});


