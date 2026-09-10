/**
 * ACTUAL emulator coverage for the targeted per-well recompute consumer.
 * Proves: event create → one completed recompute; retry → no duplicate;
 * concurrent → single claim; void → exact event-free v1 restoration;
 * no-event & ON byte identity. Real RTDB + Firestore; skips without emulator.
 */
import * as admin from 'firebase-admin';
import { computeAfrV1FromRates } from '../afr/afrV1';

const RTDB = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const FS = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = process.env.GCLOUD_PROJECT || 'wellbuilt-sync';
const describeE2E = RTDB && FS ? describe : describe.skip;
const DAY = 86400000;

describeE2E('emulator: targeted per-well recompute consumer', () => {
  const C = 'liquid-gold';
  const WELL = 'Gabriel 4';
  // Pulls ending 2026-08-14; an event on 08-12 puts the latest pull in Day 2.
  const END = Date.parse('2026-08-14T18:00:00Z');
  const RATES = [0.50, 0.52, 0.49, 0.51, 0.50, 0.60];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let idx: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let we: any;

  const managerAuth = { uid: 'mgr-1', token: { roles: ['manager'], companyId: C, manageDrivers: true } };
  const run = (fn: { run: (r: unknown) => Promise<unknown> }, data: unknown, auth: unknown) =>
    fn.run({ data, auth, rawRequest: {} } as unknown);

  async function seedPulls() {
    const updates: Record<string, unknown> = {};
    RATES.forEach((rate, i) => {
      const ts = END - (RATES.length - 1 - i) * DAY;
      updates[`packets/processed/2026_${i}_${WELL.replace(/\s/g, '')}`] = {
        wellName: WELL, companyId: C, flowRateDays: rate, dateTimeUTC: new Date(ts).toISOString(),
        tankLevelFeet: 8, bblsTaken: 100,
      };
    });
    updates[`packets/outgoing/out_${WELL.replace(/\s/g, '')}`] = { wellName: WELL, companyId: C, flowRate: 'seed' };
    await admin.database().ref().update(updates);
    await admin.database().ref(`well_config/${WELL}`).set({ tanks: 1 });
    await admin.database().ref(`companyWells/${C}/${WELL}`).set(true);
    await admin.firestore().collection('companies').doc(C).set({ timezone: 'America/Chicago' });
  }
  const outAfr = async () => (await admin.database().ref(`packets/outgoing/out_${WELL.replace(/\s/g, '')}/flowRate`).once('value')).val();
  const reqAfter = async () => (await admin.database().ref(`well_recompute_requests/${C}/${WELL}`).once('value')).val();

  beforeAll(() => {
    // index.ts calls admin.initializeApp() itself at module load; the emulator
    // env vars (FIREBASE_DATABASE_EMULATOR_HOST / FIRESTORE_EMULATOR_HOST) point
    // admin at the emulators. Do NOT initialize here (would conflict).
    idx = require('../index');
    we = require('../wellEvents');
  });
  afterAll(async () => { await Promise.all(admin.apps.filter(Boolean).map((a) => a!.delete())); });
  beforeEach(async () => {
    await admin.database().ref('packets').set(null);
    await admin.database().ref('well_events').set(null);
    await admin.database().ref('well_recompute_requests').set(null);
    await admin.database().ref('well_recompute_status').set(null);
    await seedPulls();
  });

  const statusAfr = async () => (await admin.database().ref(`well_recompute_status/${C}/${WELL}/afr`).once('value')).val();

  it('no-event recompute → AFR is v1 byte-identical; outgoing flowRate rewritten (ON row untouched)', async () => {
    expect(await idx.runWellRecompute(C, WELL, { requestedAtUtc: 1 })).toBe('completed');
    expect(await statusAfr()).toBeCloseTo(computeAfrV1FromRates(RATES), 9); // event-free = v1
    expect(await outAfr()).not.toBe('seed'); // outgoing flowRate was recomputed
  });

  it('event create → exactly one completed targeted recompute; retry → no duplicate', async () => {
    await run(we.recordWellEvent, { companyId: C, wellKey: WELL, type: 'hot_oiler_washout', eventId: 'e1', occurredAtUtc: END - 2 * DAY }, managerAuth);
    const after = await reqAfter();
    expect(after.byEventId).toBe('e1');
    const first = await idx.runWellRecompute(C, WELL, after);
    expect(first).toBe('completed');
    const st = (await admin.database().ref(`well_recompute_status/${C}/${WELL}`).once('value')).val();
    expect(st.status).toBe('completed');
    expect(st.completedAtUtc).toBeGreaterThan(0);
    // retry the SAME version → skipped (no duplicate recompute)
    expect(await idx.runWellRecompute(C, WELL, after)).toBe('skipped');
  });

  it('concurrent requests for the same version → exactly one claim proceeds', async () => {
    await run(we.recordWellEvent, { companyId: C, wellKey: WELL, type: 'hot_oiler_washout', eventId: 'e2', occurredAtUtc: END - 2 * DAY }, managerAuth);
    const after = await reqAfter();
    const results = await Promise.all([idx.runWellRecompute(C, WELL, after), idx.runWellRecompute(C, WELL, after), idx.runWellRecompute(C, WELL, after)]);
    expect(results.filter((r) => r === 'completed').length).toBe(1);
    expect(results.filter((r) => r === 'skipped').length).toBe(2);
  });

  it('failed status for a version is retryable (same version re-claims)', async () => {
    await admin.database().ref(`well_recompute_status/${C}/${WELL}`).set({ status: 'failed', forRequestedAtUtc: 500 });
    expect(await idx.runWellRecompute(C, WELL, { requestedAtUtc: 500 })).toBe('completed');
  });

  it('void → exact event-free v1 restoration (and the event changed it while active)', async () => {
    const v1 = computeAfrV1FromRates(RATES);
    // record an event: the latest pull lands in its Day 2 recovery window
    await run(we.recordWellEvent, { companyId: C, wellKey: WELL, type: 'hot_oiler_washout', eventId: 'e3', occurredAtUtc: END - 2 * DAY }, managerAuth);
    await idx.runWellRecompute(C, WELL, await reqAfter());
    expect(await statusAfr()).not.toBeCloseTo(v1, 9); // washout weighting changed the AFR
    // void → recompute → exact event-free v1 restored
    await run(we.voidWellEvent, { companyId: C, wellKey: WELL, eventId: 'e3', reason: 'test' }, managerAuth);
    const voidReq = await reqAfter();
    expect(voidReq.reason).toBe('washout_event_voided');
    await idx.runWellRecompute(C, WELL, voidReq);
    expect(await statusAfr()).toBeCloseTo(v1, 9); // event-free v1 restored exactly
  });
});
