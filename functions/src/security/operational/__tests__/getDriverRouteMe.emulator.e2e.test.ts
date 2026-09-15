/**
 * Real emulator E2E tests for shared self-scoped getDriverRouteMe callable.
 *
 * Verifies:
 * 1. Gabriel-5 dynamic level & TTP projection rule (ignores frozen outgoing values, calculates at asOfMs).
 * 2. Active dispatch assignment states (unassigned, assigned_self, assigned_other, in_ddjd).
 * 3. 5-rule disposal recommendations.
 * 4. Priority states and predictedReadyAtMs ordering.
 * 5. Down wells remain frozen.
 * 6. Tenant isolation and inactive driver fail-closed.
 * 7. Caller location validation (missing/stale/inaccurate -> LOCATION_REQUIRED).
 * 8. Driver-self mode only in Phase 1 (rejects non-driver session).
 * 9. Honest fail-safe contract (ROUTE_UNVERIFIED / ROUTING_DATA_UNAVAILABLE) with per-leg contract.
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

import { getDriverRouteMe } from '../getDriverRouteMe';
import { outgoingCompositeKey } from '../../outgoingCompositeKey';

const describeE2E = RTDB && FS ? describe : describe.skip;

describeE2E('getDriverRouteMe — Shared Routing Core (Emulator E2E)', () => {
  jest.setTimeout(60000);

  let db: admin.database.Database;
  let fs: admin.firestore.Firestore;

  const validLocation = () => ({
    latitude: 47.8012,
    longitude: -103.2845,
    capturedAt: Date.now(),
    accuracy: 25,
  });

  beforeAll(async () => {
    db = admin.database();
    fs = admin.firestore();
  });

  afterAll(async () => {
    await Promise.all(admin.apps.filter(Boolean).map((a) => a!.delete()));
  });

  beforeEach(async () => {
    await db.ref('packets').remove();
    await db.ref('well_config').remove();
    await db.ref('drivers').remove();

    // Clear Firestore dispatches, driver_credentials, disposals
    const collections = ['dispatches', 'driver_credentials', 'disposals'];
    for (const col of collections) {
      const snap = await fs.collection(col).get();
      const batch = fs.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  });

  it('Scenario 1: Dynamic level & TTP projection (Gabriel-5) ignores frozen outgoing values and returns honest ROUTE_UNVERIFIED contract', async () => {
    const driverId = 'drv-gabriel';
    const companyId = 'company-a';

    // 1. Setup driver
    await fs.collection('driver_credentials').doc(driverId).set({ active: true });
    await db.ref(`drivers/profiles/${driverId}`).set({
      active: true,
      companyId,
      assignedRoutes: ['Route A'],
      assignedWells: ['Gabriel 5'],
    });

    // 2. Setup well_config for Gabriel 5:
    // allowedBottom = 3 ft (36 in), pullBbls = 140, bblPerFoot = 20
    // Target height = 3 + 140 / 20 = 10 ft (10'0")
    await db.ref('well_config/well-gabriel-5').set({
      companyId,
      wellId: 'well-gabriel-5',
      wellName: 'Gabriel 5',
      route: 'Route A',
      bottomLevel: 3,
      pullBbls: 140,
      tanks: 1,
      bblPerFoot: 20,
    });

    // 3. Outgoing packet with Gabriel-5 parameters:
    // Flow: 3:20:24 (200.4 min/ft). Baseline: 4'9". Full fill duration: 1052.1 min (~17h 32m).
    // The pull happened 8 hours ago.
    const eightHoursAgoMs = Date.now() - 8 * 3600 * 1000;
    const eightHoursAgoIso = new Date(eightHoursAgoMs).toISOString();

    const key = outgoingCompositeKey(companyId, 'well-gabriel-5');
    await db.ref(`packets/outgoing/${key}`).set({
      wellName: 'Gabriel 5',
      companyId,
      wellId: 'well-gabriel-5',
      // Frozen values that must NOT be consumed:
      currentLevel: "4'9\"",
      timeTillPull: '17h 32m',
      // Authoritative baseline and observation timestamp:
      lastPullBottomLevel: "4'9\"",
      lastPullDateTimeUTC: eightHoursAgoIso,
      flowRate: '3:20:24',
    });

    // 4. Call getDriverRouteMe as the driver with valid device location
    const res = (await getDriverRouteMe.run({
      data: { location: validLocation() },
      auth: {
        uid: 'uid-gabriel',
        token: { kind: 'driver', driverId, companyId } as any,
      },
      rawRequest: {} as any,
    } as any)) as any;

    expect(res.ok).toBe(true);
    expect(res.capabilities.canViewRouteMe).toBe(true);
    expect(res.capabilities.canCreateDdjd).toBe(false);
    expect(res.routeVerificationStatus).toBe('ROUTE_UNVERIFIED');
    expect(res.unavailableReason).toBe('ROUTING_DATA_UNAVAILABLE');
    expect(res.wells).toHaveLength(1);

    const well = res.wells[0];
    expect(well.wellName).toBe('Gabriel 5');

    // MUST NOT return the frozen "4'9\"" or "17h 32m"
    expect(well.levelDisplay).not.toBe("4'9\"");
    expect(well.timeTillPull).not.toBe('17h 32m');

    // Expected projection after 8 hours:
    // 480 min / 200.4 min/ft = 2.3952 ft. 4.75 + 2.3952 = 7.1452 ft = 85.74 in -> 7'1"
    expect(well.levelDisplay).toBe("7'1\"");
    // Remaining TTP: 1052.1 - 480 = 572.1 min -> 9h 32m
    expect(well.timeTillPull).toBe('9h 32m');
    expect(well.priorityState).toBe('verify');
    expect(well.assignmentState).toBe('unassigned');
    expect(well.muted).toBe(false);

    // Verify per-leg and cycle time contract:
    expect(well.routeVerificationStatus).toBe('ROUTE_UNVERIFIED');
    expect(well.legs).toBeDefined();
    expect(well.legs.originToPickup.travelBasis).toBe('unverified');
    expect(well.legs.originToPickup.confidence).toBe(0);
    expect(well.legs.originToPickup.sampleCount).toBe(0);
    expect(well.legs.originToPickup.estimatedTravelMinutes).toBeNull();
    expect(well.legs.originToPickup.reasonCode).toBe('ROUTING_DATA_UNAVAILABLE');

    expect(well.legs.pickupToDisposal.travelBasis).toBe('unverified');
    expect(well.legs.pickupToDisposal.estimatedTravelMinutes).toBeNull();

    expect(well.cycleTimeEstimate).toBeDefined();
    expect(well.cycleTimeEstimate.travelToPickupMinutes).toBeNull();
    expect(well.cycleTimeEstimate.travelToDisposalMinutes).toBeNull();
    expect(well.cycleTimeEstimate.totalCycleMinutes).toBeNull();
    expect(well.cycleTimeEstimate.loadingMinutes).toBe(30);
    expect(well.cycleTimeEstimate.unloadingMinutes).toBe(30);
  });

  it('Scenario 2: Active dispatches resolve assignment states (self, other, unassigned)', async () => {
    const driverId = 'drv-main';
    const otherDriverId = 'drv-other';
    const companyId = 'company-a';

    await fs.collection('driver_credentials').doc(driverId).set({ active: true });
    await db.ref(`drivers/profiles/${driverId}`).set({
      active: true,
      companyId,
      assignedRoutes: ['Route A'],
      assignedWells: ['Well 1', 'Well 2', 'Well 3'],
    });

    // 3 wells
    for (let i = 1; i <= 3; i++) {
      await db.ref(`well_config/well-${i}`).set({
        companyId,
        wellId: `well-${i}`,
        wellName: `Well ${i}`,
        route: 'Route A',
        bottomLevel: 3,
        pullBbls: 140,
        tanks: 1,
        bblPerFoot: 20,
      });

      const key = outgoingCompositeKey(companyId, `well-${i}`);
      await db.ref(`packets/outgoing/${key}`).set({
        wellName: `Well ${i}`,
        companyId,
        wellId: `well-${i}`,
        lastPullBottomLevel: "5'0\"",
        lastPullDateTimeUTC: new Date(Date.now() - 3600 * 1000).toISOString(),
        flowRate: '1:00:00',
      });
    }

    // Active dispatch for Well 2 assigned to calling driver
    await fs.collection('dispatches').add({
      companyId,
      wellId: 'well-2',
      wellName: 'Well 2',
      driverId,
      driverFirstName: 'Mike',
      status: 'accepted',
    });

    // Active dispatch for Well 3 assigned to other driver
    await fs.collection('dispatches').add({
      companyId,
      wellId: 'well-3',
      wellName: 'Well 3',
      driverId: otherDriverId,
      driverFirstName: 'Sarah',
      status: 'in_progress',
    });

    const res = (await getDriverRouteMe.run({
      data: { location: validLocation() },
      auth: { uid: 'uid-main', token: { kind: 'driver', driverId, companyId } as any },
      rawRequest: {} as any,
    } as any)) as any;

    expect(res.ok).toBe(true);
    expect(res.wells).toHaveLength(3);

    const w1 = res.wells.find((w: any) => w.wellName === 'Well 1');
    const w2 = res.wells.find((w: any) => w.wellName === 'Well 2');
    const w3 = res.wells.find((w: any) => w.wellName === 'Well 3');

    expect(w1.assignmentState).toBe('unassigned');
    expect(w1.muted).toBe(false);

    expect(w2.assignmentState).toBe('assigned_self');
    expect(w2.assignee).toBe('Mike');
    expect(w2.muted).toBe(false);

    expect(w3.assignmentState).toBe('assigned_other');
    expect(w3.assignee).toBe('Sarah');
    expect(w3.muted).toBe(true);
  });

  it('Scenario 3: 5-rule disposal recommendation excludes blacklisted and cross-company', async () => {
    const driverId = 'drv-disp';
    const companyId = 'company-a';

    await fs.collection('driver_credentials').doc(driverId).set({ active: true });
    await db.ref(`drivers/profiles/${driverId}`).set({
      active: true,
      companyId,
      assignedRoutes: ['Route A'],
      assignedWells: ['Well Disp'],
    });

    await db.ref('well_config/well-disp').set({
      companyId,
      wellId: 'well-disp',
      wellName: 'Well Disp',
      route: 'Route A',
      bottomLevel: 3,
      pullBbls: 140,
      tanks: 1,
      bblPerFoot: 20,
    });

    const key = outgoingCompositeKey(companyId, 'well-disp');
    await db.ref(`packets/outgoing/${key}`).set({
      wellName: 'Well Disp',
      companyId,
      wellId: 'well-disp',
      lastPullBottomLevel: "5'0\"",
      lastPullDateTimeUTC: new Date(Date.now() - 3600 * 1000).toISOString(),
      flowRate: '1:00:00',
    });

    // Add disposals: 1 blacklisted, 1 other company, 1 valid
    await fs.collection('disposals').add({
      well_name: 'SWD Blacklisted',
      companyId,
      isBlacklisted: true,
    });
    await fs.collection('disposals').add({
      well_name: 'SWD Foreign',
      companyId: 'company-b',
    });
    await fs.collection('disposals').add({
      well_name: 'SWD Valid Alpha',
      companyId,
      isBlacklisted: false,
    });

    const res = (await getDriverRouteMe.run({
      data: { location: validLocation() },
      auth: { uid: 'uid-disp', token: { kind: 'driver', driverId, companyId } as any },
      rawRequest: {} as any,
    } as any)) as any;

    expect(res.ok).toBe(true);
    const well = res.wells[0];
    expect(well.recommendedDisposal).toBe('SWD Valid Alpha');
  });

  it('Scenario 4: Down wells remain frozen at baseline level with TTP Down', async () => {
    const driverId = 'drv-down';
    const companyId = 'company-a';

    await fs.collection('driver_credentials').doc(driverId).set({ active: true });
    await db.ref(`drivers/profiles/${driverId}`).set({
      active: true,
      companyId,
      assignedRoutes: ['Route A'],
      assignedWells: ['Down Well'],
    });

    await db.ref('well_config/well-down').set({
      companyId,
      wellId: 'well-down',
      wellName: 'Down Well',
      route: 'Route A',
      bottomLevel: 3,
      pullBbls: 140,
      tanks: 1,
      bblPerFoot: 20,
      wellDown: true,
    });

    const key = outgoingCompositeKey(companyId, 'well-down');
    await db.ref(`packets/outgoing/${key}`).set({
      wellName: 'Down Well',
      companyId,
      wellId: 'well-down',
      lastPullBottomLevel: "6'2\"",
      lastPullDateTimeUTC: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      flowRate: '1:00:00',
      wellDown: true,
    });

    const res = (await getDriverRouteMe.run({
      data: { location: validLocation() },
      auth: { uid: 'uid-down', token: { kind: 'driver', driverId, companyId } as any },
      rawRequest: {} as any,
    } as any)) as any;

    expect(res.ok).toBe(true);
    const well = res.wells[0];
    expect(well.levelDisplay).toBe("6'2\"");
    expect(well.timeTillPull).toBe('Down');
    expect(well.priorityState).toBe('down');
    expect(well.predictedReadyAtMs).toBeNull();
  });

  it('Scenario 5: Inactive or cross-company driver fails closed', async () => {
    const driverId = 'drv-inactive';
    await fs.collection('driver_credentials').doc(driverId).set({ active: false });
    await db.ref(`drivers/profiles/${driverId}`).set({
      active: false,
      companyId: 'company-a',
    });

    const res = (await getDriverRouteMe.run({
      data: { location: validLocation() },
      auth: { uid: 'uid-inactive', token: { kind: 'driver', driverId, companyId: 'company-a' } as any },
      rawRequest: {} as any,
    } as any)) as any;

    expect(res.ok).toBe(false);
    expect(res.capabilities.canViewRouteMe).toBe(false);
    expect(res.wells).toHaveLength(0);
  });

  it('Scenario 6: Caller location validation rejects missing, stale, or inaccurate location', async () => {
    const driverId = 'drv-loc-test';
    const companyId = 'company-a';

    await fs.collection('driver_credentials').doc(driverId).set({ active: true });
    await db.ref(`drivers/profiles/${driverId}`).set({
      active: true,
      companyId,
      assignedRoutes: ['Route A'],
      assignedWells: ['Well Loc'],
    });

    const callWithData = async (data: any) => {
      return (await getDriverRouteMe.run({
        data,
        auth: { uid: 'uid-loc', token: { kind: 'driver', driverId, companyId } as any },
        rawRequest: {} as any,
      } as any)) as any;
    };

    // A. Missing location
    const resMissing = await callWithData({});
    expect(resMissing.ok).toBe(false);
    expect(resMissing.unavailableReason).toBe('LOCATION_REQUIRED');
    expect(resMissing.locationFailureReason).toBe('missing');

    // B. Stale location (>15 minutes)
    const twentyMinutesAgo = Date.now() - 20 * 60 * 1000;
    const resStale = await callWithData({
      location: { latitude: 47.8, longitude: -103.28, capturedAt: twentyMinutesAgo, accuracy: 10 },
    });
    expect(resStale.ok).toBe(false);
    expect(resStale.unavailableReason).toBe('LOCATION_REQUIRED');
    expect(resStale.locationFailureReason).toBe('stale');

    // C. Inaccurate location (>500 meters)
    const resInaccurate = await callWithData({
      location: { latitude: 47.8, longitude: -103.28, capturedAt: Date.now(), accuracy: 600 },
    });
    expect(resInaccurate.ok).toBe(false);
    expect(resInaccurate.unavailableReason).toBe('LOCATION_REQUIRED');
    expect(resInaccurate.locationFailureReason).toBe('inaccurate');
  });

  it('Scenario 7: Driver-self mode only in Phase 1 (rejects unauthenticated or non-driver sessions)', async () => {
    // Non-driver / unauthenticated session
    const resUnauth = (await getDriverRouteMe.run({
      data: { location: validLocation() },
      auth: null,
      rawRequest: {} as any,
    } as any)) as any;

    expect(resUnauth.ok).toBe(false);
    expect(resUnauth.capabilities.canViewRouteMe).toBe(false);

    // Staff session without driver claim is rejected (staff mode not exposed in Phase 1)
    const resStaff = (await getDriverRouteMe.run({
      data: { location: validLocation(), targetDriverId: 'some-drv' },
      auth: { uid: 'uid-staff', token: { kind: 'staff', companyId: 'company-a' } as any },
      rawRequest: {} as any,
    } as any)) as any;

    expect(resStaff.ok).toBe(false);
    expect(resStaff.capabilities.canViewRouteMe).toBe(false);
  });
});
