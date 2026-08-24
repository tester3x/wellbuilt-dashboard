/**
 * Real Admin SDK Firestore query for the FirebaseDvirTransport schema.
 *
 * Requires FIRESTORE_EMULATOR_HOST. Uses project wellbuilt-equipment-prod
 * (never wellbuilt-sync). Does not talk to production.
 *
 * Proves:
 *   - summary.inspectionType + report.shiftId finds the writer document
 *   - top-level inspectionType/shiftId does not
 *   - Transaction.get(Query) sees the same result
 *   - wellbuilt-sync project id is rejected by the dedicated query helper
 */
import * as admin from 'firebase-admin';
import {
  dedicatedEquipmentPostTripQuerySpec,
  dedicatedPostTripDocumentMatches,
  INCIDENT,
  WB_E_COMPLETION_AUTHORITY,
} from '../unclaimedShiftRecovery';
import {
  applyDedicatedEquipmentPostTripQuery,
  applyWrongTopLevelPostTripQuery,
  assertDedicatedEquipmentProject,
} from '../unclaimedShiftRecoveryQueries';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = WB_E_COMPLETION_AUTHORITY.dedicatedProject.prod;
const hasEmulator = Boolean(EMULATOR);
const describeE2E = hasEmulator ? describe : describe.skip;

const COMPANY = INCIDENT.companyId;
const PERIOD = INCIDENT.periodId;
const APP_NAME = 'dvir-recovery-query-e2e';

function writerDoc(periodId: string, orgId: string): Record<string, unknown> {
  return {
    inspectionId: 'insp-post-1',
    reportId: 'insp-post-1',
    orgId,
    report: {
      schemaVersion: 'dvir-report/2',
      inspectionId: 'insp-post-1',
      reportId: 'insp-post-1',
      shiftId: periodId,
      companyId: orgId,
      inspectionType: 'post_trip',
      driver: { driverHash: 'hhhh' },
      noDefects: true,
      issues: [],
      version: 1,
      completedAt: '2026-08-21T20:00:00.000Z',
    },
    summary: {
      completedAt: '2026-08-21T20:00:00.000Z',
      inspectionType: 'post_trip',
      driverHash: 'hhhh',
      noDefects: true,
      issueCount: 0,
      version: 1,
    },
    localCreatedAt: '2026-08-21T20:00:00.000Z',
    syncedAt: '2026-08-21T20:00:00.000Z',
  };
}

describeE2E('emulator: dedicated WB-E Post-Trip query uses the writer schema', () => {
  let app: admin.app.App;
  let db: admin.firestore.Firestore;

  beforeAll(() => {
    process.env.FIRESTORE_EMULATOR_HOST = EMULATOR!;
    app = admin.apps.find((a) => a?.name === APP_NAME)
      ?? admin.initializeApp({ projectId: PROJECT }, APP_NAME);
    db = admin.firestore(app);
  });

  afterAll(async () => {
    await app.delete();
  });

  beforeEach(async () => {
    const col = db.collection(`organizations/${COMPANY}/dvirReports`);
    const snap = await col.get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  });

  it('project is the dedicated equipment prod project, not wellbuilt-sync', () => {
    expect(app.options.projectId).toBe('wellbuilt-equipment-prod');
    expect(app.options.projectId).not.toBe('wellbuilt-sync');
    expect(() => assertDedicatedEquipmentProject(app.options.projectId)).not.toThrow();
  });

  it('Admin SDK query on summary.inspectionType + report.shiftId finds the writer document', async () => {
    const doc = writerDoc(PERIOD, COMPANY);
    expect(dedicatedPostTripDocumentMatches(doc, PERIOD)).toBe(true);
    expect(doc.summary).not.toHaveProperty('shiftId');

    await db.doc(`organizations/${COMPANY}/dvirReports/insp-post-1`).set(doc);
    await db.doc(`organizations/${COMPANY}/dvirReports/top-level-only`).set({
      inspectionType: 'post_trip',
      shiftId: PERIOD,
    });
    await db.doc(`organizations/${COMPANY}/dvirReports/summary-shiftId-only`).set({
      summary: { inspectionType: 'post_trip', shiftId: PERIOD },
      report: {},
    });

    const spec = dedicatedEquipmentPostTripQuerySpec(COMPANY, PERIOD);
    expect(spec.filters.map((f) => f.field)).toEqual([
      'summary.inspectionType',
      'report.shiftId',
    ]);

    const found = await applyDedicatedEquipmentPostTripQuery(db, COMPANY, PERIOD, PROJECT).get();
    expect(found.docs.map((d) => d.id)).toEqual(['insp-post-1']);
    expect(dedicatedPostTripDocumentMatches(found.docs[0].data(), PERIOD)).toBe(true);

    const wrong = await applyWrongTopLevelPostTripQuery(db, COMPANY, PERIOD).get();
    expect(wrong.docs.map((d) => d.id)).toEqual(['top-level-only']);
    expect(wrong.docs.map((d) => d.id)).not.toContain('insp-post-1');
  });

  it('Transaction.get(Query) returns the same writer document', async () => {
    const doc = writerDoc(PERIOD, COMPANY);
    await db.doc(`organizations/${COMPANY}/dvirReports/insp-post-1`).set(doc);

    const ids = await db.runTransaction(async (tx) => {
      const snap = await tx.get(applyDedicatedEquipmentPostTripQuery(db, COMPANY, PERIOD, PROJECT));
      return snap.docs.map((d) => d.id);
    });
    expect(ids).toEqual(['insp-post-1']);
  });
});

describe('dedicated query construction rejects wellbuilt-sync without emulator', () => {
  it('assertDedicatedEquipmentProject refuses the Dashboard host project', () => {
    expect(() => assertDedicatedEquipmentProject('wellbuilt-sync')).toThrow(/wellbuilt-sync/);
    expect(() => assertDedicatedEquipmentProject('wellbuilt-equipment-prod')).not.toThrow();
    expect(() => assertDedicatedEquipmentProject('wellbuilt-equipment-dev')).not.toThrow();
  });
});
