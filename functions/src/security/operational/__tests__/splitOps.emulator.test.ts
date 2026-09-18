/**
 * Firestore Emulator Integration Suite for Authoritative Split Operations:
 *   - Duplicate concurrent add (simultaneous identical commandId execution)
 *   - Sequential duplicate retry (idempotent replay after commit)
 *   - Legacy client contract without commandId (creates distinct legitimate legs)
 *   - Cross-tenant isolation (same splitGroupId string across separate tenants)
 *   - Transaction conflict / optimistic retry on rapid sibling additions
 *   - Unauthorized actor rejection (viewer, payroll, driver-manager without dispatch authority, unassigned driver)
 *   - Invoice synchronization consistency
 *
 * Runs with:
 *   npx firebase emulators:exec --only firestore "npx jest src/security/operational/__tests__/splitOps.emulator.test.ts"
 */
import * as admin from 'firebase-admin';
import {
  addSplitLeg,
  removeSplitLeg,
  resequenceSplitFamily,
} from '../splitOps';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
const describeEmulator = EMULATOR ? describe : describe.skip;

describeEmulator('Firestore Emulator: Split Operations Authority & Idempotency', () => {
  let fs: admin.firestore.Firestore;

  beforeAll(() => {
    if (!admin.apps.length) {
      admin.initializeApp({
        projectId: process.env.GCLOUD_PROJECT || 'wellbuilt-emulator-split',
      });
    }
    fs = admin.firestore();
  });

  afterAll(async () => {
    await Promise.all(
      admin.apps.filter((app): app is admin.app.App => app != null).map((app) => app.delete()),
    );
  });

  async function clearCollection(name: string) {
    const snap = await fs.collection(name).get();
    const batch = fs.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    if (!snap.empty) {
      await batch.commit();
    }
  }

  beforeEach(async () => {
    await clearCollection('dispatches');
    await clearCollection('invoices');
    await clearCollection('split_idempotency');
    await clearCollection('security_audits');
  });

  // Callers
  const staffDispatchA = {
    auth: {
      uid: 'staff-dispatcher-a',
      token: { roles: ['dispatch'], companyId: 'company-alpha' },
    },
  };

  const staffViewerA = {
    auth: {
      uid: 'staff-viewer-a',
      token: { roles: ['viewer'], companyId: 'company-alpha' },
    },
  };

  const staffPayrollA = {
    auth: {
      uid: 'staff-payroll-a',
      token: { roles: ['payroll'], companyId: 'company-alpha' },
    },
  };

  const staffDriverManagerA = {
    auth: {
      uid: 'staff-recruiter-a',
      token: { roles: ['driver_recruiter'], caps: ['manageDrivers'], companyId: 'company-alpha' },
    },
  };

  const assignedDriverA = {
    auth: {
      uid: 'driver-assigned-1',
      token: {
        kind: 'driver',
        driverId: 'driver-assigned-1',
        companyId: 'company-alpha',
      },
    },
  };

  const unassignedDriverA = {
    auth: {
      uid: 'driver-unassigned-2',
      token: {
        kind: 'driver',
        driverId: 'driver-unassigned-2',
        companyId: 'company-alpha',
      },
    },
  };

  describe('1. Replay & Idempotency: duplicate concurrent add', () => {
    it('handles simultaneous duplicate delivery atomically: creates exactly 1 leg and 1 BBL reduction', async () => {
      const parentId = 'disp-parent-concurrent-1';
      await fs.collection('dispatches').doc(parentId).set({
        companyId: 'company-alpha',
        driverId: 'driver-assigned-1',
        driverHash: 'driver-assigned-1',
        wellName: 'Federal Alpha 1',
        ndicWellName: 'Federal Alpha 1',
        bbls: 150,
        status: 'accepted',
      });

      const sharedCommandId = 'cmd-concurrent-dup-001';
      const callData = {
        parentDispatchId: parentId,
        commandId: sharedCommandId,
        legSpec: {
          disposal: 'SWD Oasis Station',
          bbls: 50,
          destinationType: 'SWD',
        },
      };

      // Execute both simultaneously
      const [res1, res2] = await Promise.all([
        (addSplitLeg as any).run({ data: callData, auth: assignedDriverA.auth }),
        (addSplitLeg as any).run({ data: callData, auth: assignedDriverA.auth }),
      ]);

      // Both should succeed and agree on dispatch ID and split group
      expect(res1.splitGroupId).toBe(res2.splitGroupId);
      expect(res1.newDispatchId).toBe(res2.newDispatchId);
      expect(res1.splitSequence).toBe(2);
      expect(res2.splitSequence).toBe(2);
      expect(res1.splitTotal).toBe(2);
      expect(res2.splitTotal).toBe(2);

      // One of the calls was the transactional leader, the other was idempotent replay
      const hasIdempotentFlag = res1.idempotent === true || res2.idempotent === true;
      expect(hasIdempotentFlag).toBe(true);

      // Verify Firestore state: exactly TWO dispatches exist (parent + single leg)
      const allDispatches = await fs.collection('dispatches').get();
      expect(allDispatches.size).toBe(2);

      // Verify parent was reduced exactly once (150 - 50 = 100)
      const parentSnap = await fs.collection('dispatches').doc(parentId).get();
      expect(parentSnap.data()?.bbls).toBe(100);
      expect(parentSnap.data()?.splitTotal).toBe(2);
      expect(parentSnap.data()?.splitSequence).toBe(1);

      // Verify idempotency record in split_idempotency
      const idemSnap = await fs
        .collection('split_idempotency')
        .doc('company-alpha_' + parentId + '_' + sharedCommandId)
        .get();
      expect(idemSnap.exists).toBe(true);
      expect(idemSnap.data()?.newDispatchId).toBe(res1.newDispatchId);
      expect(idemSnap.data()?.parentBblsAfter).toBe(100);
    });
  });

  describe('2. Replay & Idempotency: sequential duplicate retry', () => {
    it('returns recorded outcome and prevents double volume reduction on sequential retry', async () => {
      const parentId = 'disp-parent-seq-1';
      await fs.collection('dispatches').doc(parentId).set({
        companyId: 'company-alpha',
        driverId: 'driver-assigned-1',
        wellName: 'Federal Alpha 2',
        bbls: 140,
        status: 'accepted',
      });

      const commandId = 'cmd-sequential-retry-002';
      const payload = {
        parentDispatchId: parentId,
        commandId,
        legSpec: {
          disposal: 'SWD Central Plant',
          bbls: 60,
          destinationType: 'SWD',
        },
      };

      // Call 1: initial execution
      const res1 = await (addSplitLeg as any).run({ data: payload, auth: assignedDriverA.auth });
      expect(res1.splitSequence).toBe(2);
      expect(res1.splitTotal).toBe(2);
      expect(res1.parentBblsAfter).toBe(80);

      // Call 2: retry of identical request after commit
      const res2 = await (addSplitLeg as any).run({ data: payload, auth: assignedDriverA.auth });
      expect(res2.idempotent).toBe(true);
      expect(res2.newDispatchId).toBe(res1.newDispatchId);
      expect(res2.splitGroupId).toBe(res1.splitGroupId);
      expect(res2.splitSequence).toBe(2);
      expect(res2.splitTotal).toBe(2);
      expect(res2.parentBblsAfter).toBe(80);

      // Dispatches count is exactly 2
      const allDispatches = await fs.collection('dispatches').get();
      expect(allDispatches.size).toBe(2);

      // Parent volume remained 80 (not 20!)
      const parentSnap = await fs.collection('dispatches').doc(parentId).get();
      expect(parentSnap.data()?.bbls).toBe(80);
    });
  });

  describe('3. Replay & Idempotency: legacy client contract without commandId', () => {
    it('permits distinct legs when commandId is absent, proving legacy clients create separate legs', async () => {
      const parentId = 'disp-parent-legacy-1';
      await fs.collection('dispatches').doc(parentId).set({
        companyId: 'company-alpha',
        driverId: 'driver-assigned-1',
        wellName: 'Federal Alpha Legacy',
        bbls: 150,
        status: 'accepted',
      });

      // Legacy payload: NO commandId, NO idempotencyKey
      const legacyPayload = {
        parentDispatchId: parentId,
        callerDriverHash: 'driver-assigned-1',
        legSpec: {
          disposal: 'SWD Shared',
          bbls: 40,
        },
      };

      const res1 = await (addSplitLeg as any).run({ data: legacyPayload, auth: assignedDriverA.auth });
      expect(res1.splitSequence).toBe(2);
      expect(res1.splitTotal).toBe(2);
      expect(res1.parentBblsAfter).toBe(110);

      // Second identical call WITHOUT commandId creates a legitimate distinct leg (e.g. driver adds 2nd stop)
      const res2 = await (addSplitLeg as any).run({ data: legacyPayload, auth: assignedDriverA.auth });
      expect(res2.splitSequence).toBe(3);
      expect(res2.splitTotal).toBe(3);
      expect(res2.parentBblsAfter).toBe(70);
      expect(res2.newDispatchId).not.toBe(res1.newDispatchId);

      // Total dispatches is now 3 (parent + 2 distinct legs)
      const allDispatches = await fs.collection('dispatches').get();
      expect(allDispatches.size).toBe(3);
    });
  });

  describe('4. Cross-Tenant Isolation: same splitGroupId string', () => {
    it('isolates tenants even if identical splitGroupId strings collide across companies', async () => {
      const sharedGroupId = 'split_identical_group_999';

      // Tenant Alpha family
      await fs.collection('dispatches').doc('alpha-leg-1').set({
        companyId: 'company-alpha',
        splitGroupId: sharedGroupId,
        splitSequence: 1,
        splitTotal: 2,
        status: 'accepted',
        wellName: 'Alpha Well',
      });
      await fs.collection('dispatches').doc('alpha-leg-2').set({
        companyId: 'company-alpha',
        splitGroupId: sharedGroupId,
        splitSequence: 2,
        splitTotal: 2,
        status: 'pending',
        disposal: 'Alpha SWD',
      });

      // Tenant Beta family with identical splitGroupId string
      await fs.collection('dispatches').doc('beta-leg-1').set({
        companyId: 'company-beta',
        splitGroupId: sharedGroupId,
        splitSequence: 1,
        splitTotal: 2,
        status: 'accepted',
        wellName: 'Beta Well',
      });
      await fs.collection('dispatches').doc('beta-leg-2').set({
        companyId: 'company-beta',
        splitGroupId: sharedGroupId,
        splitSequence: 2,
        splitTotal: 2,
        status: 'pending',
        disposal: 'Beta SWD',
      });

      // Tenant Alpha dispatcher adds a leg
      const addRes = await (addSplitLeg as any).run({
        data: {
          parentDispatchId: 'alpha-leg-1',
          commandId: 'cmd-alpha-leg-3',
          legSpec: { disposal: 'Alpha SWD #2' },
        },
        auth: staffDispatchA.auth,
      });
      expect(addRes.splitTotal).toBe(3);

      // Verify Tenant Beta documents were COMPLETELY UNTOUCHED
      const betaLeg1Snap = await fs.collection('dispatches').doc('beta-leg-1').get();
      const betaLeg2Snap = await fs.collection('dispatches').doc('beta-leg-2').get();
      expect(betaLeg1Snap.data()?.splitTotal).toBe(2);
      expect(betaLeg2Snap.data()?.splitTotal).toBe(2);

      // Cross-company mutation rejection: Tenant Alpha tries to mutate Tenant Beta dispatch
      await expect(
        (addSplitLeg as any).run({
          data: {
            parentDispatchId: 'beta-leg-1',
            commandId: 'cmd-cross-tenant-attack',
            legSpec: { disposal: 'Hacker SWD' },
          },
          auth: staffDispatchA.auth,
        }),
      ).rejects.toThrow('Cross-company access denied');
    });
  });

  describe('5. Transaction Conflict & Retry: rapid sibling leg additions', () => {
    it('serializes concurrent additions on the same parent via optimistic concurrency retry', async () => {
      const parentId = 'disp-parent-rapid-siblings';
      await fs.collection('dispatches').doc(parentId).set({
        companyId: 'company-alpha',
        wellName: 'Federal Rapid 1',
        bbls: 150,
        status: 'accepted',
      });

      // Two different legitimate legs added concurrently
      const call1 = (addSplitLeg as any).run({
        data: {
          parentDispatchId: parentId,
          commandId: 'cmd-sibling-leg-2',
          legSpec: { disposal: 'SWD Site 2', bbls: 40 },
        },
        auth: staffDispatchA.auth,
      });

      const call2 = (addSplitLeg as any).run({
        data: {
          parentDispatchId: parentId,
          commandId: 'cmd-sibling-leg-3',
          legSpec: { disposal: 'SWD Site 3', bbls: 30 },
        },
        auth: staffDispatchA.auth,
      });

      const [res1, res2] = await Promise.all([call1, call2]);

      // Both should succeed
      expect(res1.splitGroupId).toBe(res2.splitGroupId);
      expect(new Set([res1.splitSequence, res2.splitSequence])).toEqual(new Set([2, 3]));
      expect(res1.newDispatchId).not.toBe(res2.newDispatchId);

      // Parent volume is reduced by both: 150 - 40 - 30 = 80
      const parentSnap = await fs.collection('dispatches').doc(parentId).get();
      expect(parentSnap.data()?.bbls).toBe(80);
      expect(parentSnap.data()?.splitTotal).toBe(3);
    });
  });

  describe('6. Unauthorized Actor Rejection', () => {
    const parentId = 'disp-parent-auth-test';

    beforeEach(async () => {
      await fs.collection('dispatches').doc(parentId).set({
        companyId: 'company-alpha',
        driverId: 'driver-assigned-1',
        wellName: 'Federal Auth Well',
        bbls: 100,
        status: 'accepted',
      });
    });

    it('rejects caller with role viewer', async () => {
      await expect(
        (addSplitLeg as any).run({
          data: { parentDispatchId: parentId, legSpec: { disposal: 'SWD 1' } },
          auth: staffViewerA.auth,
        }),
      ).rejects.toThrow('Caller lacks required dispatch/staff permissions for split operations');
    });

    it('rejects caller with role payroll', async () => {
      await expect(
        (addSplitLeg as any).run({
          data: { parentDispatchId: parentId, legSpec: { disposal: 'SWD 1' } },
          auth: staffPayrollA.auth,
        }),
      ).rejects.toThrow('Caller lacks required dispatch/staff permissions for split operations');
    });

    it('rejects caller with ONLY manageDrivers capability (driver manager without dispatch authority)', async () => {
      await expect(
        (addSplitLeg as any).run({
          data: { parentDispatchId: parentId, legSpec: { disposal: 'SWD 1' } },
          auth: staffDriverManagerA.auth,
        }),
      ).rejects.toThrow('Caller lacks required dispatch/staff permissions for split operations');
    });

    it('rejects unassigned driver attempting to split another driver dispatch', async () => {
      await expect(
        (addSplitLeg as any).run({
          data: { parentDispatchId: parentId, legSpec: { disposal: 'SWD 1' } },
          auth: unassignedDriverA.auth,
        }),
      ).rejects.toThrow('Caller is not assigned to this dispatch');
    });
  });

  describe('7. Invoice Synchronization Consistency', () => {
    it('mirrors splitTotal and splitSequence to matching invoices on add and resequence', async () => {
      const parentId = 'disp-parent-invoice-sync';
      const invoiceId1 = 'inv-sync-leg-1';

      // Seed parent dispatch
      await fs.collection('dispatches').doc(parentId).set({
        companyId: 'company-alpha',
        wellName: 'Federal Inv Well',
        bbls: 120,
        status: 'accepted',
      });

      // Add split leg
      const addRes = await (addSplitLeg as any).run({
        data: {
          parentDispatchId: parentId,
          commandId: 'cmd-inv-sync-leg-2',
          legSpec: { disposal: 'SWD Inv Target', bbls: 40 },
        },
        auth: staffDispatchA.auth,
      });

      const splitGroupId = addRes.splitGroupId;
      const leg2Id = addRes.newDispatchId;

      // Seed invoices for leg 1 and leg 2 matching splitGroupId & companyId
      await fs.collection('invoices').doc(invoiceId1).set({
        companyId: 'company-alpha',
        dispatchId: parentId,
        dispatchSplitGroupId: splitGroupId,
        dispatchSplitSequence: 1,
        dispatchSplitTotal: 2,
      });

      const invoiceId2 = 'inv-sync-leg-2';
      await fs.collection('invoices').doc(invoiceId2).set({
        companyId: 'company-alpha',
        dispatchId: leg2Id,
        dispatchSplitGroupId: splitGroupId,
        dispatchSplitSequence: 2,
        dispatchSplitTotal: 2,
      });

      // Add leg 3
      const addRes3 = await (addSplitLeg as any).run({
        data: {
          parentDispatchId: parentId,
          commandId: 'cmd-inv-sync-leg-3',
          legSpec: { disposal: 'SWD Inv Leg 3', bbls: 20 },
        },
        auth: staffDispatchA.auth,
      });

      const leg3Id = addRes3.newDispatchId;

      // Invoices 1 and 2 should now have dispatchSplitTotal: 3
      const inv1Snap = await fs.collection('invoices').doc(invoiceId1).get();
      const inv2Snap = await fs.collection('invoices').doc(invoiceId2).get();
      expect(inv1Snap.data()?.dispatchSplitTotal).toBe(3);
      expect(inv2Snap.data()?.dispatchSplitTotal).toBe(3);

      // Resequence: swap leg 2 and leg 3 (anchor parentId stays first)
      await (resequenceSplitFamily as any).run({
        data: {
          splitGroupId,
          orderedLegIds: [parentId, leg3Id, leg2Id],
        },
        auth: staffDispatchA.auth,
      });

      // Invoices should mirror the resequencing: invoice for leg 2 is now sequence 3
      const inv2AfterReseq = await fs.collection('invoices').doc(invoiceId2).get();
      expect(inv2AfterReseq.data()?.dispatchSplitSequence).toBe(3);
      expect(inv2AfterReseq.data()?.dispatchSplitTotal).toBe(3);
    });
  });
});
