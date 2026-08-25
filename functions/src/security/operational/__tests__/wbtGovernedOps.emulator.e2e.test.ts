/**
 * RTDB emulator: governed WB-T edit ingest + well config + outgoing visibility.
 * Requires FIREBASE_DATABASE_EMULATOR_HOST. Never talks to production.
 */
import * as admin from 'firebase-admin';
import { evaluateGovernedWellConfig } from '../governedWellConfig';
import { expectedEditIdempotencyKey } from '../wbmEditAuthorize';
import { applyWbmEditLifecycle, planWbmEditLifecycle } from '../wbmEditLifecycle';
import { runIngestWbmEdit } from '../ingestWbmEdit';

const EMULATOR = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const PROJECT = process.env.GCLOUD_PROJECT || 'wellbuilt-sync';
const describeE2E = EMULATOR ? describe : describe.skip;

const PID = '20260823_112300_Gabriel5_orig';
const KEY = expectedEditIdempotencyKey(PID, 'Gabriel 5') as string;
const DRIVER = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';
const COMPANY = 'liquid-gold';
const ORIGINAL_UTC = '2026-08-23T16:23:00.000Z';

describeE2E('emulator: governed WB-T operational dependencies', () => {
  let db: admin.database.Database;
  let app: admin.app.App;

  beforeAll(() => {
    process.env.FIREBASE_DATABASE_EMULATOR_HOST = EMULATOR!;
    app = admin.initializeApp({
      projectId: PROJECT,
      databaseURL: `http://${EMULATOR}?ns=${PROJECT}-default-rtdb`,
    }, `wbt-ops-${Date.now()}`);
    db = app.database();
  });

  afterAll(async () => {
    await app.delete();
  });

  beforeEach(async () => {
    await db.ref('packets').set(null);
    await db.ref('well_config').set(null);
    await db.ref(`drivers/profiles/${DRIVER}`).set(null);
  });

  it('ingests an exact Gabriel 5 edit, preserves original time, and surfaces outgoing', async () => {
    await db.ref(`packets/processed/${PID}`).set({
      packetId: PID,
      wellName: 'Gabriel 5',
      driverId: DRIVER,
      dateTimeUTC: ORIGINAL_UTC,
      dateTime: '8/23/2026 11:23 AM',
      tankLevelFeet: 10.5,
      bblsTaken: 160,
      companyId: COMPANY,
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
    });
    await db.ref(`drivers/profiles/${DRIVER}`).set({
      assignedRoutes: ['Gabriels'],
      assignedWells: [],
      companyId: COMPANY,
    });

    const wellSnap = await db.ref('well_config').once('value');
    const origSnap = await db.ref(`packets/processed/${PID}`).once('value');
    const packet = {
      requestType: 'edit',
      wellName: 'Gabriel 5',
      originalPacketId: PID,
      packetId: PID,
      tankLevelFeet: 9.5,
      bblsTaken: 140,
      wellDown: false,
      idempotencyKey: KEY,
    };
    const first = await runIngestWbmEdit({
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
      writeIncoming: async (path, decide) => {
        const ref = db.ref(path);
        const box: { outcome: 'write' | 'duplicate' | 'abort'; abortReason: string } = {
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
          if (gate.action === 'duplicate') {
            box.outcome = 'duplicate';
            return current;
          }
          box.outcome = 'abort';
          box.abortReason = gate.reason;
          return;
        });
        return { committed: tx.committed, outcome: box.outcome, abortReason: box.abortReason };
      },
    });
    expect(first).toMatchObject({ ok: true, status: 'pending', originalPacketId: PID });
    if (!first.ok) return;

    const incoming = (await db.ref(first.incomingPath).once('value')).val() as Record<string, unknown>;
    expect(incoming.originalPacketId).toBe(PID);
    expect(incoming.dateTimeUTC).toBeUndefined();

    const replay = await runIngestWbmEdit({
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
      writeIncoming: async (path, decide) => {
        const current = (await db.ref(path).once('value')).val() as Record<string, unknown> | null;
        const gate = decide(current);
        if (gate.action === 'duplicate') return { committed: true, outcome: 'duplicate', abortReason: '' };
        if (gate.action === 'abort') return { committed: false, outcome: 'abort', abortReason: gate.reason };
        return { committed: true, outcome: 'write', abortReason: '' };
      },
    });
    expect(replay).toMatchObject({ ok: true, status: 'duplicate' });

    const plan = planWbmEditLifecycle({
      original: origSnap.val() as Record<string, unknown>,
      payload: incoming,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.preservedOriginalEventTime).toBe(true);
    await applyWbmEditLifecycle({
      plan,
      update: async (path, values) => {
        await db.ref(path).update(values);
      },
      readOutgoing: async () => (await db.ref('packets/outgoing').once('value')).val(),
    });
    const processed = (await db.ref(`packets/processed/${PID}`).once('value')).val() as Record<string, unknown>;
    expect(processed.dateTimeUTC).toBe(ORIGINAL_UTC);
    expect(processed.bblsTaken).toBe(140);
    expect(processed.packetId).toBe(PID);
    const outgoing = (await db.ref('packets/outgoing/response_g5').once('value')).val() as Record<string, unknown>;
    expect(outgoing).toMatchObject({
      isEdit: true,
      originalPacketId: PID,
      lastPullPacketId: PID,
      lastPullBbls: '140',
      lastPullDateTimeUTC: ORIGINAL_UTC,
    });

    const cfg = evaluateGovernedWellConfig({
      companyId: COMPANY,
      assignedRoutes: ['Gabriels'],
      assignedWells: [],
      wellConfig: wellSnap.val() as Record<string, unknown>,
      wellName: 'Gabriel 5',
    });
    expect(cfg.ok).toBe(true);
    if (!cfg.ok) return;
    expect(cfg.wells['Gabriel 5'].canonicalWellKey).toBe('Gabriel 5');
    expect(cfg.wells['Gabriel 5'].apiNumber).toBe('33-053-01234-00-00');
  });
});
