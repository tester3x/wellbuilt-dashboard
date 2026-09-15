/**
 * Comprehensive real-emulator test suite for Well-Pool Containment & Composite Writer Migration.
 *
 * Verifies the 12 required scenarios:
 * 1. Two different companies each configure a well named "Shared Well" (Company A with well-a, Company B with well-b).
 * 2. Company A processes a pull -> written to response_company-a__well-a with companyId and wellId.
 * 3. Company B processes a pull for "Shared Well" -> written to response_company-b__well-b; Company A untouched.
 * 4. Outgoing deduplication for Company A replaces/updates only Company A's row; Company B remains intact.
 * 5. Incoming packet with missing or mismatched companyId/wellId does not overwrite outgoing status (fails closed / quarantined).
 * 6. Outgoing status without companyId (legacy) does not crash or corrupt the pool.
 * 7. Newer outgoing status deterministically wins over older status for the same composite identity.
 * 8. Outgoing status for a deleted pull: survivor row is reconciled under composite key, or removed if no survivor.
 * 9. Edit packet updates only the target company's composite outgoing row.
 * 10. adminGetWellPool in company mode returns only Company A's "Shared Well" with Company A's status.
 * 11. adminGetWellPool in platform global mode returns both distinct wells with their respective statuses.
 * 12. WB-M getDriverOutgoingStatus returns the correct status for an authorized driver matching company and well.
 */
import * as admin from 'firebase-admin';

const RTDB = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const FS = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = process.env.GCLOUD_PROJECT || 'wellbuilt-sync';

if (!admin.apps.length) {
  admin.initializeApp({
    projectId: PROJECT,
    databaseURL: RTDB ? `http://${RTDB}?ns=${PROJECT}-default-rtdb` : 'http://127.0.0.1:9000?ns=demo-test',
  });
}

import { outgoingCompositeKey, encodeSegment, decodeSegment, parseOutgoingCompositeKey } from '../outgoingCompositeKey';
import { adminGetWellPool } from '../adminDashboardCatalog';
import { getDriverOutgoingStatus } from '../operational/getDriverOutgoingStatus';
import {
  processIncomingPull,
  processEditRequest,
  processDeleteRequest,
} from '../../index';
import { recoverRejectedPull } from '../../recoverRejectedPullCallable';

const describeE2E = RTDB && FS ? describe : describe.skip;

describeE2E('Well-Pool Containment + Composite Writer Migration (Emulator E2E)', () => {
  jest.setTimeout(60000);

  let db: admin.database.Database;
  let fs: admin.firestore.Firestore;

  beforeAll(async () => {
    db = admin.database();
    fs = admin.firestore();
  });

  afterAll(async () => {
    await Promise.all(admin.apps.filter(Boolean).map((a) => a!.delete()));
  });

  beforeEach(async () => {
    await db.ref('packets').remove();
    await db.ref('wells').remove();
    await db.ref('well_config').remove();
    await db.ref('users').remove();
    await db.ref('drivers').remove();
    await db.ref('companyWells').remove();
    await db.ref('performance').remove();
  });

  async function triggerPull(packetId: string, packet: Record<string, unknown>) {
    await db.ref(`packets/incoming/${packetId}`).set(packet);
    const snap = await db.ref(`packets/incoming/${packetId}`).once('value');
    await (processIncomingPull as any).run(snap, { params: { packetId } });
  }

  async function triggerEdit(packetId: string, packet: Record<string, unknown>) {
    await db.ref(`packets/incoming/${packetId}`).set(packet);
    const snap = await db.ref(`packets/incoming/${packetId}`).once('value');
    await (processEditRequest as any).run(snap, { params: { packetId } });
  }

  async function triggerDelete(packetId: string, packet: Record<string, unknown>) {
    await db.ref(`packets/incoming/${packetId}`).set(packet);
    const snap = await db.ref(`packets/incoming/${packetId}`).once('value');
    await (processDeleteRequest as any).run(snap, { params: { packetId } });
  }

  it('Scenarios 1, 2, 3, 4: Two companies with "Shared Well" write to isolated composite keys; deduplication never touches cross-tenant row', async () => {
    // 1. Two different companies each configure a well named "Shared Well"
    await db.ref('well_config').set({
      'well-a': {
        companyId: 'company-a',
        wellId: 'well-a',
        wellName: 'Shared Well',
        route: 'Route A',
        tanks: 1,
        pullBbls: 140,
        bottomLevel: 3,
        avgFlowRate: '6:00:00',
      },
      'well-b': {
        companyId: 'company-b',
        wellId: 'well-b',
        wellName: 'Shared Well',
        route: 'Route B',
        tanks: 1,
        pullBbls: 140,
        bottomLevel: 3,
        avgFlowRate: '6:00:00',
      },
    });

    const keyA = outgoingCompositeKey('company-a', 'well-a');
    const keyB = outgoingCompositeKey('company-b', 'well-b');
    expect(keyA).toBe('response_company-a__well-a');
    expect(keyB).toBe('response_company-b__well-b');

    // 2. Company A processes a pull:
    //    - status written to response_company-a__well-a
    //    - contains companyId: 'company-a', wellId: 'well-a'
    const pullA1 = {
      requestType: 'pull',
      wellName: 'Shared Well',
      wellId: 'well-a',
      companyId: 'company-a',
      driverId: 'driver-a',
      driverName: 'Driver A',
      dateTimeUTC: '2026-09-15T01:00:00.000Z',
      tankLevelFeet: 10,
      bblsTaken: 120,
    };
    await triggerPull('pull-a-1', pullA1);

    const outA1Snap = await db.ref(`packets/outgoing/${keyA}`).once('value');
    expect(outA1Snap.exists()).toBe(true);
    const outA1 = outA1Snap.val();
    expect(outA1.companyId).toBe('company-a');
    expect(outA1.wellId).toBe('well-a');
    expect(outA1.wellName).toBe('Shared Well');
    expect(outA1.lastPullPacketId).toBe('pull-a-1');
    expect(outA1.lastPullBbls).toBe('120');

    // 3. Company B processes a pull for its "Shared Well":
    //    - written to response_company-b__well-b
    //    - contains companyId: 'company-b', wellId: 'well-b'
    //    - Company A's status row is completely untouched (not deleted, not overwritten)
    const pullB1 = {
      requestType: 'pull',
      wellName: 'Shared Well',
      wellId: 'well-b',
      companyId: 'company-b',
      driverId: 'driver-b',
      driverName: 'Driver B',
      dateTimeUTC: '2026-09-15T02:00:00.000Z',
      tankLevelFeet: 12,
      bblsTaken: 150,
    };
    await triggerPull('pull-b-1', pullB1);

    const outB1Snap = await db.ref(`packets/outgoing/${keyB}`).once('value');
    expect(outB1Snap.exists()).toBe(true);
    const outB1 = outB1Snap.val();
    expect(outB1.companyId).toBe('company-b');
    expect(outB1.wellId).toBe('well-b');
    expect(outB1.wellName).toBe('Shared Well');
    expect(outB1.lastPullPacketId).toBe('pull-b-1');
    expect(outB1.lastPullBbls).toBe('150');

    // Verify Company A's status row is 100% untouched
    const outA1AfterSnap = await db.ref(`packets/outgoing/${keyA}`).once('value');
    expect(outA1AfterSnap.val()).toEqual(outA1);

    // 4. Outgoing deduplication for Company A replaces/updates only Company A's row; Company B's row remains intact.
    // Also seed an old legacy row for Company A to ensure deduplication cleans it up while sparing Company B
    await db.ref('packets/outgoing/response_legacy_old_a').set({
      wellName: 'Shared Well',
      companyId: 'company-a',
      wellId: 'well-a',
      lastPullPacketId: 'pull-old-legacy',
      lastPullDateTimeUTC: '2026-09-14T00:00:00.000Z',
    });

    const pullA2 = {
      requestType: 'pull',
      wellName: 'Shared Well',
      wellId: 'well-a',
      companyId: 'company-a',
      driverId: 'driver-a',
      driverName: 'Driver A',
      dateTimeUTC: '2026-09-15T03:00:00.000Z',
      tankLevelFeet: 11,
      bblsTaken: 130,
    };
    await triggerPull('pull-a-2', pullA2);

    const outA2Snap = await db.ref(`packets/outgoing/${keyA}`).once('value');
    expect(outA2Snap.val().lastPullPacketId).toBe('pull-a-2');
    expect(outA2Snap.val().lastPullBbls).toBe('130');

    // Legacy row for Company A was cleaned up
    const legacySnap = await db.ref('packets/outgoing/response_legacy_old_a').once('value');
    expect(legacySnap.exists()).toBe(false);

    // Company B's status row is STILL untouched
    const outB1AfterA2Snap = await db.ref(`packets/outgoing/${keyB}`).once('value');
    expect(outB1AfterA2Snap.val()).toEqual(outB1);
  });

  it('Scenario 5: Incoming packet with missing or mismatched companyId/wellId does not overwrite outgoing status (fails closed / quarantined)', async () => {
    // Well configured without companyId
    await db.ref('well_config/Stranded Well').set({
      wellName: 'Stranded Well',
      wellId: 'stranded-1',
      // NO companyId
      route: 'Route S',
      tanks: 1,
    });

    // Seed existing outgoing status
    await db.ref('packets/outgoing/response_safe_existing').set({
      wellName: 'Stranded Well',
      companyId: 'company-x',
      wellId: 'stranded-1',
      lastPullPacketId: 'prior-pull',
      lastPullDateTimeUTC: '2026-09-15T01:00:00.000Z',
    });

    const pullBad = {
      requestType: 'pull',
      wellName: 'Stranded Well',
      dateTimeUTC: '2026-09-15T02:00:00.000Z',
      tankLevelFeet: 8,
      bblsTaken: 100,
    };
    await triggerPull('pull-bad-1', pullBad);

    // Quarantined in rejected
    const rejectedSnap = await db.ref('packets/rejected/pull-bad-1').once('value');
    expect(rejectedSnap.exists()).toBe(true);
    expect(rejectedSnap.val().reason).toBe('STRANDED_INCOMING_PACKET');

    // Outgoing status untouched
    const safeSnap = await db.ref('packets/outgoing/response_safe_existing').once('value');
    expect(safeSnap.exists()).toBe(true);
    expect(safeSnap.val().lastPullPacketId).toBe('prior-pull');
  });

  it('Scenario 6: Outgoing status without companyId (legacy) does not crash or corrupt the pool', async () => {
    await db.ref('users/a-admin').set({ role: 'admin', companyId: 'company-a' });
    await db.ref('well_config/well-a').set({
      companyId: 'company-a',
      wellId: 'well-a',
      wellName: 'Shared Well',
      route: 'Route A',
      tanks: 1,
      pullBbls: 140,
    });
    // Legacy outgoing row without companyId or wellId
    await db.ref('packets/outgoing/response_legacy_untagged').set({
      wellName: 'Shared Well',
      currentLevel: "5'0\"",
      lastPullBottomLevel: "4'0\"",
      lastPullDateTimeUTC: '2026-09-14T00:00:00Z',
      flowRate: '6:00:00',
    });

    // adminGetWellPool in company mode should gracefully handle untagged row without crashing
    const res = (await adminGetWellPool.run({
      data: {},
      auth: { uid: 'a-admin', token: {} },
      rawRequest: {},
    } as any)) as any;

    expect(res.ok).toBe(true);
    expect(res.canViewWellPool).toBe(true);
    expect(res.wellConfig['well-a']).toBeDefined();
    // Untagged row is excluded from company pool (fails closed against foreign/unattributed data)
    expect(res.wellStatus['well-a']).toBeUndefined();
  });

  it('Scenario 7: Newer outgoing status deterministically wins over older status for the same composite identity', async () => {
    await db.ref('well_config/well-a').set({
      companyId: 'company-a',
      wellId: 'well-a',
      wellName: 'Shared Well',
      route: 'Route A',
      tanks: 1,
      pullBbls: 140,
      bottomLevel: 3,
    });

    const compositeKey = outgoingCompositeKey('company-a', 'well-a');

    // Write a newer pull first
    const pullNewer = {
      requestType: 'pull',
      wellName: 'Shared Well',
      wellId: 'well-a',
      companyId: 'company-a',
      driverId: 'driver-a',
      dateTimeUTC: '2026-09-15T05:00:00.000Z',
      tankLevelFeet: 10,
      bblsTaken: 100,
    };
    await triggerPull('pull-newer', pullNewer);

    const outNewerSnap = await db.ref(`packets/outgoing/${compositeKey}`).once('value');
    expect(outNewerSnap.val().lastPullPacketId).toBe('pull-newer');

    // Attempt to process an older pull
    const pullOlder = {
      requestType: 'pull',
      wellName: 'Shared Well',
      wellId: 'well-a',
      companyId: 'company-a',
      driverId: 'driver-a',
      dateTimeUTC: '2026-09-15T02:00:00.000Z',
      tankLevelFeet: 9,
      bblsTaken: 80,
    };
    await triggerPull('pull-older', pullOlder);

    // Newer status remains intact
    const outAfterOlderSnap = await db.ref(`packets/outgoing/${compositeKey}`).once('value');
    expect(outAfterOlderSnap.val().lastPullPacketId).toBe('pull-newer');
    expect(outAfterOlderSnap.val().lastPullDateTimeUTC).toBe('2026-09-15T05:00:00.000Z');
  });

  it('Scenario 8: Outgoing status for a deleted pull: survivor row is reconciled under composite key, or removed if no survivor', async () => {
    await db.ref('well_config/well-a').set({
      companyId: 'company-a',
      wellId: 'well-a',
      wellName: 'Shared Well',
      route: 'Route A',
      tanks: 1,
      pullBbls: 140,
      bottomLevel: 3,
    });

    const compositeKey = outgoingCompositeKey('company-a', 'well-a');

    // Process pull 1
    const pull1 = {
      requestType: 'pull',
      wellName: 'Shared Well',
      wellId: 'well-a',
      companyId: 'company-a',
      driverId: 'driver-a',
      dateTimeUTC: '2026-09-15T01:00:00.000Z',
      tankLevelFeet: 8,
      bblsTaken: 100,
    };
    await triggerPull('pull-1', pull1);

    // Process pull 2
    const pull2 = {
      requestType: 'pull',
      wellName: 'Shared Well',
      wellId: 'well-a',
      companyId: 'company-a',
      driverId: 'driver-a',
      dateTimeUTC: '2026-09-15T02:00:00.000Z',
      tankLevelFeet: 10,
      bblsTaken: 120,
    };
    await triggerPull('pull-2', pull2);

    expect((await db.ref(`packets/outgoing/${compositeKey}`).once('value')).val().lastPullPacketId).toBe('pull-2');

    // Delete pull-2 -> survivor pull-1 must be reconciled
    const deletePull2 = {
      requestType: 'delete',
      wellName: 'Shared Well',
      wellId: 'well-a',
      companyId: 'company-a',
      packetId: 'pull-2',
      deletedAt: '2026-09-15T03:00:00.000Z',
    };
    await triggerDelete('del-pull-2', deletePull2);

    const survivorSnap = await db.ref(`packets/outgoing/${compositeKey}`).once('value');
    expect(survivorSnap.exists()).toBe(true);
    expect(survivorSnap.val().lastPullPacketId).toBe('pull-1');
    expect(survivorSnap.val().companyId).toBe('company-a');
    expect(survivorSnap.val().wellId).toBe('well-a');

    // Delete remaining pull-1 -> row should be removed as no pulls survive
    const deletePull1 = {
      requestType: 'delete',
      wellName: 'Shared Well',
      wellId: 'well-a',
      companyId: 'company-a',
      packetId: 'pull-1',
      deletedAt: '2026-09-15T04:00:00.000Z',
    };
    await triggerDelete('del-pull-1', deletePull1);

    const emptySnap = await db.ref(`packets/outgoing/${compositeKey}`).once('value');
    expect(emptySnap.exists()).toBe(false);
  });

  it('Scenario 9: Edit packet updates only the target company\'s composite outgoing row', async () => {
    await db.ref('well_config').set({
      'well-a': {
        companyId: 'company-a',
        wellId: 'well-a',
        wellName: 'Shared Well',
        route: 'Route A',
        tanks: 1,
        pullBbls: 140,
        bottomLevel: 3,
      },
      'well-b': {
        companyId: 'company-b',
        wellId: 'well-b',
        wellName: 'Shared Well',
        route: 'Route B',
        tanks: 1,
        pullBbls: 140,
        bottomLevel: 3,
      },
    });

    const keyA = outgoingCompositeKey('company-a', 'well-a');
    const keyB = outgoingCompositeKey('company-b', 'well-b');

    // Process pull for A and pull for B
    await triggerPull('pull-a-edit', {
      requestType: 'pull',
      wellName: 'Shared Well',
      wellId: 'well-a',
      companyId: 'company-a',
      driverId: 'driver-a',
      dateTimeUTC: '2026-09-15T01:00:00.000Z',
      tankLevelFeet: 8,
      bblsTaken: 100,
    });
    await triggerPull('pull-b-edit', {
      requestType: 'pull',
      wellName: 'Shared Well',
      wellId: 'well-b',
      companyId: 'company-b',
      driverId: 'driver-b',
      dateTimeUTC: '2026-09-15T01:30:00.000Z',
      tankLevelFeet: 9,
      bblsTaken: 110,
    });

    const beforeB = (await db.ref(`packets/outgoing/${keyB}`).once('value')).val();

    // Now edit pull-a-edit
    const editA = {
      requestType: 'edit',
      wellName: 'Shared Well',
      wellId: 'well-a',
      companyId: 'company-a',
      originalPacketId: 'pull-a-edit',
      tankLevelFeet: 8.5,
      bblsTaken: 115,
      source: 'dashboard',
    };
    await triggerEdit('edit-a-1', editA);

    const afterA = (await db.ref(`packets/outgoing/${keyA}`).once('value')).val();
    expect(afterA.isEdit).toBe(true);
    expect(afterA.lastPullBbls).toBe('115');
    expect(afterA.companyId).toBe('company-a');
    expect(afterA.wellId).toBe('well-a');

    // Company B is completely untouched
    const afterB = (await db.ref(`packets/outgoing/${keyB}`).once('value')).val();
    expect(afterB).toEqual(beforeB);
  });

  it('Scenario 10, 11: adminGetWellPool in company mode vs platform global mode', async () => {
    await db.ref('users').set({
      'plat-admin': { role: 'it' }, // viewAllCompanies
      'a-admin': { role: 'admin', companyId: 'company-a' },
      'b-admin': { role: 'admin', companyId: 'company-b' },
    });

    await db.ref('well_config').set({
      'well-a': {
        companyId: 'company-a',
        wellId: 'well-a',
        wellName: 'Shared Well',
        route: 'Route A',
        tanks: 1,
        pullBbls: 140,
        bottomLevel: 3,
      },
      'well-b': {
        companyId: 'company-b',
        wellId: 'well-b',
        wellName: 'Shared Well',
        route: 'Route B',
        tanks: 1,
        pullBbls: 140,
        bottomLevel: 3,
      },
    });

    const keyA = outgoingCompositeKey('company-a', 'well-a');
    const keyB = outgoingCompositeKey('company-b', 'well-b');

    await db.ref(`packets/outgoing/${keyA}`).set({
      wellName: 'Shared Well',
      companyId: 'company-a',
      wellId: 'well-a',
      currentLevel: "5'0\"",
      lastPullBottomLevel: "4'0\"",
      lastPullDateTimeUTC: '2026-09-15T01:00:00Z',
      flowRate: '6:00:00',
    });
    await db.ref(`packets/outgoing/${keyB}`).set({
      wellName: 'Shared Well',
      companyId: 'company-b',
      wellId: 'well-b',
      currentLevel: "9'0\"",
      lastPullBottomLevel: "8'0\"",
      lastPullDateTimeUTC: '2026-09-15T02:00:00Z',
      flowRate: '4:00:00',
    });

    // 10. adminGetWellPool in company mode returns only Company A's "Shared Well" with Company A's status
    const resA = (await adminGetWellPool.run({
      data: {},
      auth: { uid: 'a-admin', token: {} },
      rawRequest: {},
    } as any)) as any;

    expect(resA.ok).toBe(true);
    expect(resA.canViewWellPool).toBe(true);
    expect(Object.keys(resA.wellConfig)).toEqual(['well-a']);
    expect(resA.wellStatus['well-a']).toBeDefined();
    expect(resA.wellStatus['well-a'].companyId).toBe('company-a');
    expect(resA.wellStatus['well-a'].wellId).toBe('well-a');
    expect(resA.wellStatus['well-a'].currentLevel).toBe("5'0\"");
    expect(resA.wellStatus['well-b']).toBeUndefined();

    // 11. adminGetWellPool in platform global mode returns both distinct wells with their respective statuses
    const resGlobal = (await adminGetWellPool.run({
      data: {},
      auth: { uid: 'plat-admin', token: {} },
      rawRequest: {},
    } as any)) as any;

    expect(resGlobal.ok).toBe(true);
    expect(resGlobal.canViewWellPool).toBe(true);
    expect(resGlobal.wellConfig['well-a']).toBeDefined();
    expect(resGlobal.wellConfig['well-b']).toBeDefined();
    // Distinct composite identities are both present in wellStatus
    expect(resGlobal.wellStatus['company-a__well-a']).toBeDefined();
    expect(resGlobal.wellStatus['company-a__well-a'].currentLevel).toBe("5'0\"");
    expect(resGlobal.wellStatus['company-b__well-b']).toBeDefined();
    expect(resGlobal.wellStatus['company-b__well-b'].currentLevel).toBe("9'0\"");
  });

  it('Scenario 12: WB-M getDriverOutgoingStatus returns the correct status for an authorized driver matching company and well', async () => {
    // Setup driver authority
    const driverId = 'drv-alpha';
    await fs.collection('driver_credentials').doc(driverId).set({ active: true });
    await db.ref(`drivers/profiles/${driverId}`).set({
      active: true,
      companyId: 'company-a',
      assignedWells: ['Shared Well'],
    });

    await db.ref('well_config/well-a').set({
      companyId: 'company-a',
      wellId: 'well-a',
      wellName: 'Shared Well',
      route: 'Route A',
      tanks: 1,
      pullBbls: 140,
    });

    const keyA = outgoingCompositeKey('company-a', 'well-a');
    await db.ref(`packets/outgoing/${keyA}`).set({
      wellName: 'Shared Well',
      companyId: 'company-a',
      wellId: 'well-a',
      currentLevel: "6'6\"",
      lastPullDateTimeUTC: '2026-09-15T02:00:00Z',
      flowRate: '5:00:00',
    });

    const res = (await getDriverOutgoingStatus.run({
      data: {},
      auth: {
        uid: 'drv-uid-1',
        token: {
          kind: 'driver',
          driverId,
          companyId: 'company-a',
        },
      },
      rawRequest: {},
    } as any)) as any;

    expect(res.ok).toBe(true);
    expect(res.driverId).toBe(driverId);
    expect(res.companyId).toBe('company-a');
    expect(res.authorizedWells).toContain('Shared Well');
    expect(res.responses.length).toBe(1);
    expect(res.responses[0].wellName).toBe('Shared Well');
    expect(res.responses[0].currentLevel).toBe("6'6\"");
  });

  it('Scenario 13: Injective composite key encoding proof (forbidden chars, underscores, Unicode, length limits, and collision resistance)', () => {
    // 1. Distinct raw IDs that would collide under naive replacement
    const encDot = encodeSegment('alpha.beta');
    const encUnderscore = encodeSegment('alpha_beta');
    const encSlash = encodeSegment('alpha/beta');
    const encHyphen = encodeSegment('alpha-beta');
    expect(encDot).not.toBe(encUnderscore);
    expect(encSlash).not.toBe(encHyphen);
    expect(encDot).toBe('alpha~2ebeta');
    expect(encUnderscore).toBe('alpha~5fbeta');
    expect(encSlash).toBe('alpha~2fbeta');
    expect(encHyphen).toBe('alpha-beta');

    // 2. RTDB forbidden characters: . # $ [ ] /
    const forbiddenRaw = 'well.#$[test]/1';
    const forbiddenEnc = encodeSegment(forbiddenRaw);
    expect(forbiddenEnc).not.toMatch(/[.#$\[\]/]/);
    expect(decodeSegment(forbiddenEnc)).toBe(forbiddenRaw);

    // 3. Separators and underscores: __ does not collide with single _ or boundary
    const compWithDelim = 'tenant__alpha';
    const wellWithDelim = 'well__beta';
    const compKey = outgoingCompositeKey(compWithDelim, wellWithDelim);
    expect(compKey).toBe('response_tenant~5f~5falpha__well~5f~5fbeta');
    const parsed = parseOutgoingCompositeKey(compKey);
    expect(parsed).toEqual({ companyId: compWithDelim, wellId: wellWithDelim });

    // 4. Unicode support
    const unicodeCompany = '公司-alpha';
    const unicodeWell = '井#1-Café';
    const unicodeKey = outgoingCompositeKey(unicodeCompany, unicodeWell);
    expect(unicodeKey).not.toMatch(/[.#$\[\]/]/);
    const parsedUnicode = parseOutgoingCompositeKey(unicodeKey);
    expect(parsedUnicode).toEqual({ companyId: unicodeCompany, wellId: unicodeWell });

    // 5. Length bounding (RTDB 768 UTF-8 byte limit on final key)
    const maxKey = outgoingCompositeKey('c', 'w'.repeat(756));
    expect(Buffer.byteLength(maxKey, 'utf8')).toBe(768);
    expect(() => outgoingCompositeKey('c', 'w'.repeat(757))).toThrow(/768 UTF-8 bytes/);
  });

  it('Scenario 14: Server-authoritative incoming identity binding (wellName-only pull resolves by company; ambiguous/spoofed fails closed)', async () => {
    await db.ref('well_config').set({
      'well-a': {
        companyId: 'company-a',
        wellId: 'well-a',
        wellName: 'Shared Well',
        route: 'Route A',
        tanks: 1,
        pullBbls: 140,
        bottomLevel: 3,
      },
      'well-b': {
        companyId: 'company-b',
        wellId: 'well-b',
        wellName: 'Shared Well',
        route: 'Route B',
        tanks: 1,
        pullBbls: 140,
        bottomLevel: 3,
      },
    });

    const keyA = outgoingCompositeKey('company-a', 'well-a');
    const keyB = outgoingCompositeKey('company-b', 'well-b');

    // A. Company A driver submits pull with wellName ONLY (NO wellId in packet)
    const pullA = {
      requestType: 'pull',
      wellName: 'Shared Well',
      companyId: 'company-a',
      driverId: 'driver-a',
      dateTimeUTC: '2026-09-15T04:00:00.000Z',
      tankLevelFeet: 8,
      bblsTaken: 100,
    };
    await triggerPull('pull-authoritative-a', pullA);

    const outASnap = await db.ref(`packets/outgoing/${keyA}`).once('value');
    expect(outASnap.exists()).toBe(true);
    expect(outASnap.val().companyId).toBe('company-a');
    expect(outASnap.val().wellId).toBe('well-a');
    expect(outASnap.val().lastPullPacketId).toBe('pull-authoritative-a');

    // B. Company B driver submits pull with wellName ONLY (NO wellId in packet)
    const pullB = {
      requestType: 'pull',
      wellName: 'Shared Well',
      companyId: 'company-b',
      driverId: 'driver-b',
      dateTimeUTC: '2026-09-15T04:30:00.000Z',
      tankLevelFeet: 7,
      bblsTaken: 110,
    };
    await triggerPull('pull-authoritative-b', pullB);

    const outBSnap = await db.ref(`packets/outgoing/${keyB}`).once('value');
    expect(outBSnap.exists()).toBe(true);
    expect(outBSnap.val().companyId).toBe('company-b');
    expect(outBSnap.val().wellId).toBe('well-b');
    expect(outBSnap.val().lastPullPacketId).toBe('pull-authoritative-b');

    // C. Ambiguous pull: packet lacks companyId entirely -> fails closed into quarantine
    const ambiguousPull = {
      requestType: 'pull',
      wellName: 'Shared Well',
      // NO companyId
      driverId: 'driver-anon',
      dateTimeUTC: '2026-09-15T05:00:00.000Z',
      tankLevelFeet: 9,
      bblsTaken: 90,
    };
    await triggerPull('pull-ambiguous-anon', ambiguousPull);

    // Verify it was quarantined in packets/rejected
    const qSnap = await db.ref('packets/rejected/pull-ambiguous-anon').once('value');
    expect(qSnap.exists()).toBe(true);
    expect(qSnap.val().reason).toBe('STRANDED_INCOMING_PACKET');

    // D. Spoof attempt: Company B driver passes untrusted wellId pointing to Company A's well
    const spoofPull = {
      requestType: 'pull',
      wellName: 'Shared Well',
      companyId: 'company-b',
      wellId: 'well-a', // Belongs to Company A!
      driverId: 'driver-b',
      dateTimeUTC: '2026-09-15T05:30:00.000Z',
      tankLevelFeet: 5,
      bblsTaken: 80,
    };
    await triggerPull('pull-spoof-a', spoofPull);

    // Company A's outgoing status was NOT mutated or overwritten by the spoof
    const outASnapAfterSpoof = await db.ref(`packets/outgoing/${keyA}`).once('value');
    expect(outASnapAfterSpoof.val().lastPullPacketId).toBe('pull-authoritative-a');
  });

  it('Scenario 15: Legacy identity-missing status safety (two companies, identical wellName, one complete, one legacy — neither tenant receives the other or legacy status)', async () => {
    // 1. Two companies configure "Shared Well"
    await db.ref('well_config').set({
      'well-a': {
        companyId: 'company-a',
        wellId: 'well-a',
        wellName: 'Shared Well',
        route: 'Route A',
        tanks: 1,
        pullBbls: 140,
      },
      'well-b': {
        companyId: 'company-b',
        wellId: 'well-b',
        wellName: 'Shared Well',
        route: 'Route B',
        tanks: 1,
        pullBbls: 140,
      },
    });

    // 2. Company A has identity-complete status row
    const keyA = outgoingCompositeKey('company-a', 'well-a');
    await db.ref(`packets/outgoing/${keyA}`).set({
      wellName: 'Shared Well',
      companyId: 'company-a',
      wellId: 'well-a',
      currentLevel: "5'0\"",
      flowRate: '6:00:00',
      timestampUTC: '2026-09-15T01:00:00Z',
    });

    // 3. Legacy identity-missing status row exists in packets/outgoing
    await db.ref('packets/outgoing/response_SharedWell_legacy').set({
      wellName: 'Shared Well',
      // NO companyId, NO wellId
      currentLevel: "12'0\"",
      flowRate: '1:00:00',
      timestampUTC: '2026-09-15T03:00:00Z',
    });

    // 4. Test adminGetWellPool in Company B mode:
    //    Company B has configured "Shared Well", but NO owned status.
    //    It must receive status UNAVAILABLE (0 status rows returned).
    //    It must NEVER receive Company A's "5'0\"" row or the legacy "12'0\"" row!
    const resB = (await adminGetWellPool.run({
      data: { companyId: 'company-b' },
      auth: {
        uid: 'user-b-admin',
        token: {
          roles: ['manager'],
          companyId: 'company-b',
          roleCapabilities: ['viewWellPool'],
        },
      },
      rawRequest: {},
    } as any)) as any;

    expect(resB.ok).toBe(true);
    expect(resB.canViewWellPool).toBe(true);
    expect(Object.keys(resB.wellConfig)).toEqual(['well-b']);
    // Outgoing status for Company B MUST be empty (unavailable)
    expect(Object.keys(resB.wellStatus)).toEqual([]);
    expect(resB.counts.wellStatus).toBe(0);

    // 5. Test adminGetWellPool in Company A mode:
    //    Company A receives ONLY its owned status, NEVER the legacy "12'0\"" row
    const resA = (await adminGetWellPool.run({
      data: { companyId: 'company-a' },
      auth: {
        uid: 'user-a-admin',
        token: {
          roles: ['manager'],
          companyId: 'company-a',
          roleCapabilities: ['viewWellPool'],
        },
      },
      rawRequest: {},
    } as any)) as any;

    expect(resA.ok).toBe(true);
    expect(resA.canViewWellPool).toBe(true);
    expect(Object.keys(resA.wellConfig)).toEqual(['well-a']);
    expect(resA.counts.wellStatus).toBe(1);
    expect(resA.wellStatus['well-a'].currentLevel).toBe("5'0\"");
    expect(resA.wellStatus['well-a'].companyId).toBe('company-a');

    // 6. Test WB-M getDriverOutgoingStatus for Driver B:
    //    Must report "Shared Well" in unavailableWells, and 0 responses
    const driverIdB = 'drv-beta';
    await fs.collection('driver_credentials').doc(driverIdB).set({ active: true });
    await db.ref(`drivers/profiles/${driverIdB}`).set({
      active: true,
      companyId: 'company-b',
      assignedWells: ['Shared Well'],
    });

    const drvResB = (await getDriverOutgoingStatus.run({
      data: {},
      auth: {
        uid: 'drv-uid-beta',
        token: {
          kind: 'driver',
          driverId: driverIdB,
          companyId: 'company-b',
        },
      },
      rawRequest: {},
    } as any)) as any;

    expect(drvResB.ok).toBe(true);
    expect(drvResB.responses).toHaveLength(0);
    expect(drvResB.unavailableWells).toContain('Shared Well');
  });

  it('Scenario 16: Canonical recovery callable isolation and watermark recognition', async () => {
    // 1. Two companies configure "Shared Well"
    await db.ref('well_config').set({
      'well-a': {
        companyId: 'company-a',
        wellId: 'well-a',
        wellName: 'Shared Well',
        route: 'Route A',
        tanks: 1,
        pullBbls: 140,
        bottomLevel: 3,
      },
      'well-b': {
        companyId: 'company-b',
        wellId: 'well-b',
        wellName: 'Shared Well',
        route: 'Route B',
        tanks: 1,
        pullBbls: 140,
        bottomLevel: 3,
      },
    });

    // 2. Setup driver profiles
    await db.ref('drivers/profiles/driver-b').set({ active: true, companyId: 'company-b' });
    await db.ref('drivers/profiles/driver-a').set({ active: true, companyId: 'company-a' });
    await db.ref('drivers/profiles/driver-c').set({ active: true, companyId: 'company-c' });

    const now = Date.now();
    const tMinus6h = new Date(now - 6 * 3600 * 1000).toISOString();
    const tMinus5h = new Date(now - 5 * 3600 * 1000).toISOString();
    const tMinus4h = new Date(now - 4 * 3600 * 1000).toISOString();
    const tMinus3h = new Date(now - 3 * 3600 * 1000).toISOString();

    // 3. Only Company A has an outgoing composite status at tMinus3h
    const keyA = outgoingCompositeKey('company-a', 'well-a');
    const keyB = outgoingCompositeKey('company-b', 'well-b');
    await db.ref(`packets/outgoing/${keyA}`).set({
      wellName: 'Shared Well',
      companyId: 'company-a',
      wellId: 'well-a',
      lastPullDateTimeUTC: tMinus3h,
      currentLevel: "5'0\"",
    });

    // 4. Company B has a rejected pull in packets/rejected
    const rejIdB = 'rej-b-stale-01';
    await db.ref(`packets/rejected/${rejIdB}`).set({
      packetId: rejIdB,
      reason: 'STALE_PULL_TIME',
      wellName: 'Shared Well',
      requestType: 'pull',
      packet: {
        packetId: rejIdB,
        wellName: 'Shared Well',
        companyId: 'company-b',
        wellId: 'well-b',
        driverId: 'driver-b',
        driverName: 'Driver B',
        requestType: 'pull',
        dateTimeUTC: tMinus6h,
        tankLevelFeet: 6,
        bblsTaken: 60,
        wellDown: false,
        timezone: 'America/Chicago',
      },
    });

    // 5. Recovering Company B's rejected pull with corrected time tMinus4h
    // (Older than Company A's tMinus3h status).
    // Must NOT match Company A's status or watermark!
    const replIdB = '20260915_100000_SharedWell_replB';

    // Hook to execute processIncomingPull when recovery writes replacement to packets/incoming
    const incomingListener = async (snapshot: admin.database.DataSnapshot) => {
      if (snapshot.key === replIdB) {
        await (processIncomingPull as any).run(snapshot, { params: { packetId: replIdB } });
      }
    };
    db.ref('packets/incoming').on('child_added', incomingListener);

    try {
      const recRes = (await (recoverRejectedPull as any).run({
        data: {
          rejectedPacketId: rejIdB,
          replacementPacketId: replIdB,
          corrected: {
            dateTimeUTC: tMinus4h,
            tankLevelFeet: 6,
            bblsTaken: 60,
            wellDown: false,
          },
        },
        auth: {
          uid: 'uid-drv-b',
          token: { kind: 'driver', driverId: 'driver-b', companyId: 'company-b' },
        },
      })) as any;

      expect(recRes.status).toBe('recovered');
      expect(recRes.replacementPacketId).toBe(replIdB);

      // Company B's composite status was created
      const outBSnap = await db.ref(`packets/outgoing/${keyB}`).once('value');
      expect(outBSnap.exists()).toBe(true);
      expect(outBSnap.val().companyId).toBe('company-b');
      expect(outBSnap.val().lastPullDateTimeUTC).toBe(tMinus4h);

      // Company A's composite row was untouched
      const outASnap = await db.ref(`packets/outgoing/${keyA}`).once('value');
      expect(outASnap.val().lastPullDateTimeUTC).toBe(tMinus3h);
      expect(outASnap.val().currentLevel).toBe("5'0\"");

      // 6. A spoofed company identity must fail
      await expect(
        (recoverRejectedPull as any).run({
          data: {
            rejectedPacketId: rejIdB,
            replacementPacketId: '20260915_110000_SharedWell_spoofC',
            corrected: {
              dateTimeUTC: tMinus3h,
              tankLevelFeet: 6,
              bblsTaken: 60,
              wellDown: false,
            },
          },
          auth: {
            uid: 'uid-drv-c',
            token: { kind: 'driver', driverId: 'driver-c', companyId: 'company-c' },
          },
        })
      ).rejects.toThrow();

      // 7. The correct Company B composite row must be recognized after Company B owns one
      // Now Company B owns outgoing composite status at tMinus4h.
      // Setup second rejected packet for Company B
      const rejIdB2 = 'rej-b-stale-02';
      await db.ref(`packets/rejected/${rejIdB2}`).set({
        packetId: rejIdB2,
        reason: 'STALE_PULL_TIME',
        wellName: 'Shared Well',
        requestType: 'pull',
        packet: {
          packetId: rejIdB2,
          wellName: 'Shared Well',
          companyId: 'company-b',
          wellId: 'well-b',
          driverId: 'driver-b',
          requestType: 'pull',
          dateTimeUTC: tMinus6h,
          tankLevelFeet: 5,
          bblsTaken: 50,
          wellDown: false,
        },
      });

      // Attempt recovery with corrected time tMinus5h (older than Company B's watermark tMinus4h)
      // Must fail closed with REPLACEMENT_NOT_NEWER
      await expect(
        (recoverRejectedPull as any).run({
          data: {
            rejectedPacketId: rejIdB2,
            replacementPacketId: '20260915_090000_SharedWell_replB2',
            corrected: {
              dateTimeUTC: tMinus5h,
              tankLevelFeet: 5,
              bblsTaken: 50,
              wellDown: false,
            },
          },
          auth: {
            uid: 'uid-drv-b',
            token: { kind: 'driver', driverId: 'driver-b', companyId: 'company-b' },
          },
        })
      ).rejects.toThrow(/REPLACEMENT_NOT_NEWER/);
    } finally {
      db.ref('packets/incoming').off('child_added', incomingListener);
    }
  });

  it('Scenario 17: Identityless legacy row does not block incoming pull or influence edit', async () => {
    // 1. Two companies configure "Shared Well"
    await db.ref('well_config').set({
      'well-a': {
        companyId: 'company-a',
        wellId: 'well-a',
        wellName: 'Shared Well',
        route: 'Route A',
        tanks: 2,
        pullBbls: 140,
        bottomLevel: 1,
      },
      'well-b': {
        companyId: 'company-b',
        wellId: 'well-b',
        wellName: 'Shared Well',
        route: 'Route B',
        tanks: 2,
        pullBbls: 140,
        bottomLevel: 1,
      },
    });

    const keyA = outgoingCompositeKey('company-a', 'well-a');
    const keyB = outgoingCompositeKey('company-b', 'well-b');

    const now = Date.now();
    const tMinus5h = new Date(now - 5 * 3600 * 1000).toISOString();
    const tMinus3h = new Date(now - 3 * 3600 * 1000).toISOString();
    const tMinus2h30m = new Date(now - 2.5 * 3600 * 1000).toISOString();
    const tMinus2h = new Date(now - 2 * 3600 * 1000).toISOString();

    // 2. Company A has composite status at tMinus5h
    await db.ref(`packets/outgoing/${keyA}`).set({
      wellName: 'Shared Well',
      companyId: 'company-a',
      wellId: 'well-a',
      lastPullDateTimeUTC: tMinus5h,
      currentLevel: "4'0\"",
      lastPullBbls: '80',
    });

    // 3. An identityless legacy row exists with a newer timestamp (tMinus2h)
    // Under the old bug, this row matched any company and blocked incoming pulls
    await db.ref('packets/outgoing/response_Shared Well').set({
      wellName: 'Shared Well',
      // Explicitly NO companyId, NO wellId
      lastPullDateTimeUTC: tMinus2h,
      currentLevel: "14'0\"",
      flowRate: '1:00:00',
    });

    // 4. Company B submits a valid incoming pull at tMinus3h
    // (Older than legacy row's tMinus2h, but valid for Company B)
    const pullIdB = 'pull-b-legacy-fixture';
    await triggerPull(pullIdB, {
      packetId: pullIdB,
      wellName: 'Shared Well',
      companyId: 'company-b',
      wellId: 'well-b',
      driverId: 'drv-b',
      driverName: 'Driver B',
      dateTimeUTC: tMinus3h,
      tankLevelFeet: 8,
      bblsTaken: 100,
      tanks: 2,
    });

    // 5. B's valid incoming pull must still create B's composite status
    const outBSnap = await db.ref(`packets/outgoing/${keyB}`).once('value');
    expect(outBSnap.exists()).toBe(true);
    expect(outBSnap.val().companyId).toBe('company-b');
    expect(outBSnap.val().wellId).toBe('well-b');
    expect(outBSnap.val().lastPullDateTimeUTC).toBe(tMinus3h);
    expect(outBSnap.val().lastPullBbls).toBe('100');

    // 6. Company A and the legacy row remain untouched
    const outASnap = await db.ref(`packets/outgoing/${keyA}`).once('value');
    expect(outASnap.val().lastPullDateTimeUTC).toBe(tMinus5h);
    expect(outASnap.val().currentLevel).toBe("4'0\"");

    const legacySnap = await db.ref('packets/outgoing/response_Shared Well').once('value');
    expect(legacySnap.exists()).toBe(true);
    expect(legacySnap.val().lastPullDateTimeUTC).toBe(tMinus2h);
    expect(legacySnap.val().currentLevel).toBe("14'0\"");
    expect(legacySnap.val().companyId).toBeUndefined();

    // 7. B's edit affects only B
    const editIdB = 'edit-b-legacy-fixture';
    await triggerEdit(editIdB, {
      packetId: editIdB,
      originalPacketId: pullIdB,
      requestType: 'edit',
      wellName: 'Shared Well',
      companyId: 'company-b',
      wellId: 'well-b',
      driverId: 'drv-b',
      dateTimeUTC: tMinus2h30m,
      bblsTaken: 110,
      tankLevelFeet: 9,
    });

    // B's composite row updated
    const outBAfterEdit = await db.ref(`packets/outgoing/${keyB}`).once('value');
    expect(outBAfterEdit.val().lastPullBbls).toBe('110');
    expect(outBAfterEdit.val().companyId).toBe('company-b');

    // Company A and legacy row still untouched
    const outAAfterEdit = await db.ref(`packets/outgoing/${keyA}`).once('value');
    expect(outAAfterEdit.val().lastPullDateTimeUTC).toBe(tMinus5h);
    expect(outAAfterEdit.val().lastPullBbls).toBe('80');

    const legacyAfterEdit = await db.ref('packets/outgoing/response_Shared Well').once('value');
    expect(legacyAfterEdit.exists()).toBe(true);
    expect(legacyAfterEdit.val().lastPullDateTimeUTC).toBe(tMinus2h);
  });
});
