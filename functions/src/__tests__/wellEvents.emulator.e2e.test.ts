/**
 * ACTUAL Firebase emulator coverage for the governed washout-event callables.
 * Runs against emulated RTDB + Firestore (never production). Skips when the
 * emulator env is absent. Invoke via:
 *   JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=C:\t \
 *   firebase emulators:exec --only database,firestore --project wellbuilt-sync \
 *     "npx jest src/__tests__/wellEvents.emulator.e2e.test.ts"
 *
 * (no-event byte identity + ON byte identity are DB-independent and proven
 * deterministically in afrV2.test.ts / afrV2Preservation.test.ts.)
 */
import * as admin from 'firebase-admin';

const RTDB = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const FS = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = process.env.GCLOUD_PROJECT || 'wellbuilt-sync';
const describeE2E = RTDB && FS ? describe : describe.skip;

function init() {
  if (!admin.apps.length) {
    admin.initializeApp({ projectId: PROJECT, databaseURL: `http://${RTDB}?ns=${PROJECT}-default-rtdb` });
  }
}

describeE2E('emulator: recordWellEvent / voidWellEvent', () => {
  // Import after env is set so admin picks up the emulators.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { recordWellEvent, voidWellEvent } = require('../wellEvents');
  const C = 'liquid-gold';
  const WELL = 'Gabriel 4';
  const managerAuth = { uid: 'mgr-1', token: { roles: ['manager'], companyId: C, manageDrivers: true } };
  const driverAuth = { uid: 'drv-1', token: { kind: 'driver', driverId: 'drv-1', companyId: C } };
  const run = (fn: { run: (r: unknown) => Promise<unknown> }, data: unknown, auth: unknown) =>
    fn.run({ data, auth, rawRequest: {} } as unknown);
  const base = { companyId: C, wellKey: WELL, type: 'hot_oiler_washout', occurredAtUtc: Date.parse('2026-08-23T18:00:00Z') };

  beforeAll(init);
  afterAll(async () => { await Promise.all(admin.apps.filter(Boolean).map((a) => a!.delete())); });
  beforeEach(async () => {
    await admin.database().ref('well_events').set(null);
    await admin.database().ref('well_recompute_requests').set(null);
    await admin.database().ref(`companyWells/${C}/${WELL}`).set(true);       // well exists
    await admin.firestore().collection('companies').doc(C).set({ state: 'ND' }); // tz via state fallback
    await admin.firestore().collection('companies').doc('tz-co').set({ timezone: 'America/Denver' });
  });

  it('driver authorization: a field driver records for their own company; tz snapshot + recompute request written', async () => {
    const res: any = await run(recordWellEvent, { ...base, eventId: 'e1' }, driverAuth);
    expect(res.ok).toBe(true);
    expect(res.ianaTimezoneSnapshot).toBe('America/Chicago'); // resolved from state ND
    const rec = (await admin.database().ref(`well_events/${C}/${WELL}/e1`).once('value')).val();
    expect(rec.recordedByRole).toBe('driver');
    expect(rec.occurredAtUtc).toBe(base.occurredAtUtc);
    const rq = (await admin.database().ref(`well_recompute_requests/${C}/${WELL}`).once('value')).val();
    expect(rq.byEventId).toBe('e1'); // targeted recompute requested
  });

  it('manager authorization + explicit company timezone snapshot', async () => {
    await admin.database().ref(`companyWells/tz-co/${WELL}`).set(true);
    const res: any = await run(recordWellEvent, { ...base, companyId: 'tz-co', eventId: 'e2' },
      { uid: 'mgr-2', token: { roles: ['manager'], companyId: 'tz-co', manageDrivers: true } });
    expect(res.ok).toBe(true);
    expect(res.ianaTimezoneSnapshot).toBe('America/Denver');
  });

  it('cross-company denial and nonexistent well', async () => {
    await expect(run(recordWellEvent, { ...base, eventId: 'x' }, { uid: 'd', token: { kind: 'driver', driverId: 'd', companyId: 'other' } }))
      .rejects.toThrow(/company_scope_mismatch/);
    await expect(run(recordWellEvent, { ...base, wellKey: 'No Such Well', eventId: 'x' }, managerAuth))
      .rejects.toThrow(/well_not_found_in_company/);
  });

  it('create / idempotent / conflict', async () => {
    const first: any = await run(recordWellEvent, { ...base, eventId: 'e3', note: 'a' }, managerAuth);
    expect(first.idempotent).toBe(false);
    const again: any = await run(recordWellEvent, { ...base, eventId: 'e3', note: 'a' }, managerAuth);
    expect(again.idempotent).toBe(true); // identical retry
    await expect(run(recordWellEvent, { ...base, eventId: 'e3', note: 'DIFFERENT' }, managerAuth))
      .rejects.toThrow(/event_id_reused_with_different_payload/); // conflict, never silent
  });

  it('late/backdated event is accepted and triggers a targeted recompute', async () => {
    const backdated = Date.parse('2026-06-01T12:00:00Z');
    const res: any = await run(recordWellEvent, { ...base, eventId: 'late', occurredAtUtc: backdated }, managerAuth);
    expect(res.ok).toBe(true);
    const rq = (await admin.database().ref(`well_recompute_requests/${C}/${WELL}`).once('value')).val();
    expect(rq.byEventId).toBe('late');
  });

  it('void is manager-only, auditable (original preserved), repeated void idempotent; recompute requested', async () => {
    await run(recordWellEvent, { ...base, eventId: 'v1' }, managerAuth);
    await admin.database().ref('well_recompute_requests').set(null);
    // driver cannot void
    await expect(run(voidWellEvent, { companyId: C, wellKey: WELL, eventId: 'v1' }, driverAuth))
      .rejects.toThrow(/manageDrivers|permission/i);
    // manager voids
    const v: any = await run(voidWellEvent, { companyId: C, wellKey: WELL, eventId: 'v1', reason: 'mistake' }, managerAuth);
    expect(v.action).toBe('void');
    const rec = (await admin.database().ref(`well_events/${C}/${WELL}/v1`).once('value')).val();
    expect(rec.voidedAtUtc).toBeGreaterThan(0);
    expect(rec.voidedBy).toBe('mgr-1');
    expect(rec.occurredAtUtc).toBe(base.occurredAtUtc); // original preserved, not deleted
    expect((await admin.database().ref(`well_recompute_requests/${C}/${WELL}`).once('value')).val().byEventId).toBe('v1');
    // repeated void is idempotent
    const v2: any = await run(voidWellEvent, { companyId: C, wellKey: WELL, eventId: 'v1' }, managerAuth);
    expect(v2.action).toBe('already_voided');
  });
});
