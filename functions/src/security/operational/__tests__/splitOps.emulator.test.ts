/**
 * Firestore Emulator Integration Suite for Authoritative Split Operations:
 *   1. Replay & Idempotency: duplicate concurrent add (simultaneous identical commandId execution)
 *   2. Replay & Idempotency: sequential duplicate retry (idempotent replay after commit)
 *   3. Request Fingerprint: same command ID + identical payload returns recorded result; different payload fails closed
 *   4. Safe Idempotency Identity: collision-safe hash doc ID, readable audit fields, rejection of malformed command IDs
 *   5. Legacy client contract without commandId (creates distinct legitimate legs)
 *   6. Broad Support Authority: 'it' role and 'isPlatformAdmin' require explicit operational capability & matching tenant
 *   7. Cross-Tenant Coverage: byte-for-byte isolation of Company B across add, remove, resequence, and invoice sync with identical splitGroupId
 *   8. Transaction conflict / optimistic retry on rapid sibling additions
 *   9. Unauthorized actor rejection (viewer, payroll, driver-manager without dispatch authority, unassigned driver)
 *   10. Invoice synchronization consistency
 *
 * Runs with:
 *   npx firebase emulators:exec --only firestore "npx jest src/security/operational/__tests__/splitOps.emulator.test.ts"
 */
import * as admin from 'firebase-admin';
import {
  addSplitLeg,
  removeSplitLeg,
  resequenceSplitFamily,
  computeSplitIdempotencyDocId,
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
    await clearCollection('security_audit');
  });

  /**
   * Captures the entire state of a tenant (dispatches, invoices, idempotency)
   * to prove byte-for-byte immutability when other tenants perform mutations.
   */
  async function getTenantByteSnapshot(companyId: string): Promise<string> {
    const [dispSnap, invSnap, idemSnap] = await Promise.all([
      fs.collection('dispatches').where('companyId', '==', companyId).get(),
      fs.collection('invoices').where('companyId', '==', companyId).get(),
      fs.collection('split_idempotency').where('companyId', '==', companyId).get(),
    ]);
    const dispatches = dispSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const invoices = invSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const idempotency = idemSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return JSON.stringify({ dispatches, invoices, idempotency });
  }

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

  // ── 1. Replay & Idempotency: duplicate concurrent add ─────────────────────
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

      // Verify idempotency record in split_idempotency using safe identity
      const expectedDocId = computeSplitIdempotencyDocId('company-alpha', parentId, sharedCommandId);
      const idemSnap = await fs.collection('split_idempotency').doc(expectedDocId).get();
      expect(idemSnap.exists).toBe(true);
      expect(idemSnap.data()?.newDispatchId).toBe(res1.newDispatchId);
      expect(idemSnap.data()?.parentBblsAfter).toBe(100);
      expect(idemSnap.data()?.commandId).toBe(sharedCommandId);
      expect(idemSnap.data()?.companyId).toBe('company-alpha');
      expect(idemSnap.data()?.requestDigest).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // ── 2. Replay & Idempotency: sequential duplicate retry ───────────────────
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

      // Idempotency doc exists and contains required fields
      const expectedDocId = computeSplitIdempotencyDocId('company-alpha', parentId, commandId);
      const idemSnap = await fs.collection('split_idempotency').doc(expectedDocId).get();
      expect(idemSnap.exists).toBe(true);
      expect(idemSnap.data()?.companyId).toBe('company-alpha');
      expect(idemSnap.data()?.parentDispatchId).toBe(parentId);
      expect(idemSnap.data()?.commandId).toBe(commandId);
      expect(idemSnap.data()?.result?.newDispatchId).toBe(res1.newDispatchId);
    });
  });

  // ── 3. Request Fingerprint: conflict detection & zero mutation ─────────────
  describe('3. Request Fingerprint: conflict detection', () => {
    it('fails closed when same command ID is retried with a different payload', async () => {
      const parentId = 'disp-parent-fp-test';
      await fs.collection('dispatches').doc(parentId).set({
        companyId: 'company-alpha',
        driverId: 'driver-assigned-1',
        wellName: 'Federal FP Well',
        bbls: 150,
        status: 'accepted',
      });

      const commandId = 'cmd-fingerprint-conflict-001';
      const initialPayload = {
        parentDispatchId: parentId,
        commandId,
        legSpec: {
          disposal: 'SWD Initial Station',
          bbls: 50,
          destinationType: 'SWD',
        },
      };

      // Initial execution succeeds
      const res1 = await (addSplitLeg as any).run({
        data: initialPayload,
        auth: assignedDriverA.auth,
      });
      expect(res1.splitSequence).toBe(2);
      expect(res1.parentBblsAfter).toBe(100);

      // Snapshot dispatches after initial success
      const dispatchesAfterInitial = await fs.collection('dispatches').get();
      expect(dispatchesAfterInitial.size).toBe(2);

      // Call 2 with SAME command ID but DIFFERENT payload (altered disposal)
      const alteredPayload = {
        parentDispatchId: parentId,
        commandId,
        legSpec: {
          disposal: 'SWD Altered Station', // Different!
          bbls: 50,
          destinationType: 'SWD',
        },
      };

      await expect(
        (addSplitLeg as any).run({ data: alteredPayload, auth: assignedDriverA.auth }),
      ).rejects.toThrow('Idempotency conflict: commandId was previously executed with a different request payload');

      // Verify ZERO mutation occurred: parent volume unchanged, dispatch count unchanged
      const parentSnap = await fs.collection('dispatches').doc(parentId).get();
      expect(parentSnap.data()?.bbls).toBe(100);
      const dispatchesAfterFailed = await fs.collection('dispatches').get();
      expect(dispatchesAfterFailed.size).toBe(2);
    });

    it('fails closed when same command ID is retried with altered BBL allocation', async () => {
      const parentId = 'disp-parent-fp-bbl-test';
      await fs.collection('dispatches').doc(parentId).set({
        companyId: 'company-alpha',
        driverId: 'driver-assigned-1',
        wellName: 'Federal FP BBL Well',
        bbls: 180,
        status: 'accepted',
      });

      const commandId = 'cmd-fingerprint-conflict-002';
      await (addSplitLeg as any).run({
        data: {
          parentDispatchId: parentId,
          commandId,
          legSpec: { disposal: 'SWD Target', bbls: 60 },
        },
        auth: assignedDriverA.auth,
      });

      // Retry with altered BBLs (70 instead of 60)
      await expect(
        (addSplitLeg as any).run({
          data: {
            parentDispatchId: parentId,
            commandId,
            legSpec: { disposal: 'SWD Target', bbls: 70 },
          },
          auth: assignedDriverA.auth,
        }),
      ).rejects.toThrow('Idempotency conflict');

      // Parent volume remains 120 (180 - 60)
      const parentSnap = await fs.collection('dispatches').doc(parentId).get();
      expect(parentSnap.data()?.bbls).toBe(120);
    });
  });

  // ── 4. Safe Idempotency Identity & Malformed Command IDs ──────────────────
  describe('4. Safe Idempotency Identity & Malformed Command IDs', () => {
    const parentId = 'disp-parent-malformed-cmd';

    beforeEach(async () => {
      await fs.collection('dispatches').doc(parentId).set({
        companyId: 'company-alpha',
        driverId: 'driver-assigned-1',
        wellName: 'Federal Cmd Well',
        bbls: 100,
        status: 'accepted',
      });
    });

    it('rejects path-injection / slashes in commandId', async () => {
      await expect(
        (addSplitLeg as any).run({
          data: {
            parentDispatchId: parentId,
            commandId: '../../etc/passwd',
            legSpec: { disposal: 'SWD Attack' },
          },
          auth: staffDispatchA.auth,
        }),
      ).rejects.toThrow('invalid characters');
    });

    it('rejects empty or whitespace-only commandId', async () => {
      await expect(
        (addSplitLeg as any).run({
          data: {
            parentDispatchId: parentId,
            commandId: '   ',
            legSpec: { disposal: 'SWD Attack' },
          },
          auth: staffDispatchA.auth,
        }),
      ).rejects.toThrow('commandId cannot be empty');
    });

    it('rejects oversized commandId exceeding 128 characters', async () => {
      await expect(
        (addSplitLeg as any).run({
          data: {
            parentDispatchId: parentId,
            commandId: 'a'.repeat(129),
            legSpec: { disposal: 'SWD Attack' },
          },
          auth: staffDispatchA.auth,
        }),
      ).rejects.toThrow('commandId exceeds maximum length of 128 characters');
    });
  });

  // ── 5. Legacy client contract without commandId ───────────────────────────
  describe('5. Legacy client contract without commandId', () => {
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

      // Second identical call WITHOUT commandId creates a legitimate distinct leg
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

  // ── 6. Broad Support Authority Enforcement ────────────────────────────────
  describe('6. Broad Support Authority Enforcement', () => {
    const parentId = 'disp-parent-broad-support';

    beforeEach(async () => {
      await fs.collection('dispatches').doc(parentId).set({
        companyId: 'company-alpha',
        wellName: 'Federal Broad Support Well',
        bbls: 120,
        status: 'accepted',
      });
    });

    it('rejects IT caller lacking operational dispatch capability', async () => {
      const staffItNoOps = {
        auth: {
          uid: 'staff-it-no-ops',
          token: { roles: ['it'], companyId: 'company-alpha' },
        },
      };
      await expect(
        (addSplitLeg as any).run({
          data: { parentDispatchId: parentId, legSpec: { disposal: 'SWD IT' } },
          auth: staffItNoOps.auth,
        }),
      ).rejects.toThrow('Caller lacks required dispatch/staff permissions for split operations');
    });

    it('rejects platform admin caller lacking operational capability', async () => {
      const platformAdminNoOps = {
        auth: {
          uid: 'platform-admin-no-ops',
          token: { roles: ['admin'], isPlatformAdmin: true, caps: [] },
        },
      };
      await expect(
        (addSplitLeg as any).run({
          data: { parentDispatchId: parentId, legSpec: { disposal: 'SWD Platform' } },
          auth: platformAdminNoOps.auth,
        }),
      ).rejects.toThrow('Caller lacks required dispatch/staff permissions for split operations');
    });

    it('rejects platform admin with operational capability attempting cross-company mutation', async () => {
      const platformAdminOpsBeta = {
        auth: {
          uid: 'platform-admin-ops-beta',
          token: {
            roles: ['admin'],
            caps: ['manageDispatches'],
            companyId: 'company-beta',
            isPlatformAdmin: true,
          },
        },
      };
      await expect(
        (addSplitLeg as any).run({
          data: { parentDispatchId: parentId, legSpec: { disposal: 'SWD Cross' } },
          auth: platformAdminOpsBeta.auth,
        }),
      ).rejects.toThrow('Cross-company access denied');
    });

    it('accepts platform admin with operational capability and matching companyId, recording audit actor', async () => {
      const platformAdminOpsAlpha = {
        auth: {
          uid: 'platform-admin-ops-alpha',
          token: {
            roles: ['admin'],
            caps: ['manageDispatches'],
            companyId: 'company-alpha',
            isPlatformAdmin: true,
          },
        },
      };
      const res = await (addSplitLeg as any).run({
        data: {
          parentDispatchId: parentId,
          commandId: 'cmd-admin-ops-leg-1',
          legSpec: { disposal: 'SWD Authorized Admin', bbls: 40 },
        },
        auth: platformAdminOpsAlpha.auth,
      });
      expect(res.splitTotal).toBe(2);

      // Check security audit record in security_audit collection
      const audits = await fs
        .collection('security_audit')
        .where('action', '==', 'addSplitLeg')
        .get();
      expect(audits.empty).toBe(false);
      const auditDoc = audits.docs.find((d) => d.data()?.actorUid === 'platform-admin-ops-alpha');
      expect(auditDoc).toBeDefined();
      expect(auditDoc?.data()?.detail?.actor?.caps).toContain('manageDispatches');
    });
  });

  // ── 7. Cross-Tenant Coverage: byte-for-byte immutability on shared splitGroupId
  describe('7. Cross-Tenant Coverage: byte-for-byte immutability on shared splitGroupId', () => {
    const sharedGroupId = 'split_identical_cross_tenant_shared_777';

    beforeEach(async () => {
      // Seed Company Alpha family
      await fs.collection('dispatches').doc('alpha-parent').set({
        companyId: 'company-alpha',
        splitGroupId: sharedGroupId,
        splitSequence: 1,
        splitTotal: 2,
        bbls: 100,
        status: 'accepted',
        wellName: 'Alpha Well 1',
      });
      await fs.collection('dispatches').doc('alpha-leg-2').set({
        companyId: 'company-alpha',
        parentDispatchId: 'alpha-parent',
        splitGroupId: sharedGroupId,
        splitSequence: 2,
        splitTotal: 2,
        bbls: 40,
        status: 'pending',
        disposal: 'Alpha SWD #1',
      });
      await fs.collection('invoices').doc('inv-alpha-1').set({
        companyId: 'company-alpha',
        dispatchId: 'alpha-parent',
        dispatchSplitGroupId: sharedGroupId,
        dispatchSplitSequence: 1,
        dispatchSplitTotal: 2,
      });
      await fs.collection('invoices').doc('inv-alpha-2').set({
        companyId: 'company-alpha',
        dispatchId: 'alpha-leg-2',
        dispatchSplitGroupId: sharedGroupId,
        dispatchSplitSequence: 2,
        dispatchSplitTotal: 2,
      });

      // Seed Company Beta family with IDENTICAL splitGroupId
      await fs.collection('dispatches').doc('beta-parent').set({
        companyId: 'company-beta',
        splitGroupId: sharedGroupId,
        splitSequence: 1,
        splitTotal: 2,
        bbls: 200,
        status: 'accepted',
        wellName: 'Beta Well 1',
      });
      await fs.collection('dispatches').doc('beta-leg-2').set({
        companyId: 'company-beta',
        parentDispatchId: 'beta-parent',
        splitGroupId: sharedGroupId,
        splitSequence: 2,
        splitTotal: 2,
        bbls: 80,
        status: 'pending',
        disposal: 'Beta SWD #1',
      });
      await fs.collection('invoices').doc('inv-beta-1').set({
        companyId: 'company-beta',
        dispatchId: 'beta-parent',
        dispatchSplitGroupId: sharedGroupId,
        dispatchSplitSequence: 1,
        dispatchSplitTotal: 2,
      });
      await fs.collection('invoices').doc('inv-beta-2').set({
        companyId: 'company-beta',
        dispatchId: 'beta-leg-2',
        dispatchSplitGroupId: sharedGroupId,
        dispatchSplitSequence: 2,
        dispatchSplitTotal: 2,
      });
    });

    it('operation: ADD - proves Company B is byte-for-byte unchanged when Company A adds a split leg', async () => {
      const betaSnapshotBefore = await getTenantByteSnapshot('company-beta');

      // Company Alpha adds leg 3
      const addRes = await (addSplitLeg as any).run({
        data: {
          parentDispatchId: 'alpha-parent',
          commandId: 'cmd-alpha-add-leg-3',
          legSpec: { disposal: 'Alpha SWD #2', bbls: 30 },
        },
        auth: staffDispatchA.auth,
      });
      expect(addRes.splitTotal).toBe(3);

      // Verify Company Alpha state was modified
      const alphaParentSnap = await fs.collection('dispatches').doc('alpha-parent').get();
      expect(alphaParentSnap.data()?.splitTotal).toBe(3);
      expect(alphaParentSnap.data()?.bbls).toBe(70);

      // Verify Company Beta is BYTE-FOR-BYTE IDENTICAL
      const betaSnapshotAfter = await getTenantByteSnapshot('company-beta');
      expect(betaSnapshotAfter).toBe(betaSnapshotBefore);
    });

    it('operation: REMOVE - proves Company B is byte-for-byte unchanged when Company A removes a split leg', async () => {
      const betaSnapshotBefore = await getTenantByteSnapshot('company-beta');

      // Company Alpha removes leg 2
      const removeRes = await (removeSplitLeg as any).run({
        data: { legDispatchId: 'alpha-leg-2' },
        auth: staffDispatchA.auth,
      });
      expect(removeRes.removed).toBe(true);

      // Verify Company Alpha was mutated
      const alphaLeg2 = await fs.collection('dispatches').doc('alpha-leg-2').get();
      expect(alphaLeg2.data()?.status).toBe('cancelled');
      expect(alphaLeg2.data()?.splitLegRemoved).toBe(true);

      // Verify Company Beta is BYTE-FOR-BYTE IDENTICAL
      const betaSnapshotAfter = await getTenantByteSnapshot('company-beta');
      expect(betaSnapshotAfter).toBe(betaSnapshotBefore);
    });

    it('operation: RESEQUENCE - proves Company B is byte-for-byte unchanged when Company A resequences legs', async () => {
      // First, add leg 3 to Company Alpha so we have 3 legs to reorder
      const addRes = await (addSplitLeg as any).run({
        data: {
          parentDispatchId: 'alpha-parent',
          commandId: 'cmd-alpha-add-leg-3-for-reseq',
          legSpec: { disposal: 'Alpha SWD Leg 3', bbls: 20 },
        },
        auth: staffDispatchA.auth,
      });
      const alphaLeg3Id = addRes.newDispatchId;

      // Capture Beta snapshot prior to resequencing
      const betaSnapshotBefore = await getTenantByteSnapshot('company-beta');

      // Company Alpha resequences: swap leg 2 and leg 3
      const reseqRes = await (resequenceSplitFamily as any).run({
        data: {
          splitGroupId: sharedGroupId,
          orderedLegIds: ['alpha-parent', alphaLeg3Id, 'alpha-leg-2'],
        },
        auth: staffDispatchA.auth,
      });
      expect(reseqRes.resequenced).toBe(true);

      // Verify Company Alpha leg 2 is now sequence 3
      const alphaLeg2 = await fs.collection('dispatches').doc('alpha-leg-2').get();
      expect(alphaLeg2.data()?.splitSequence).toBe(3);

      // Verify Company Beta is BYTE-FOR-BYTE IDENTICAL
      const betaSnapshotAfter = await getTenantByteSnapshot('company-beta');
      expect(betaSnapshotAfter).toBe(betaSnapshotBefore);
    });

    it('operation: INVOICE SYNCHRONIZATION - proves Company B invoices are byte-for-byte unchanged', async () => {
      const betaSnapshotBefore = await getTenantByteSnapshot('company-beta');

      // Company Alpha adds leg 3 (which triggers invoice total sync on Company Alpha)
      await (addSplitLeg as any).run({
        data: {
          parentDispatchId: 'alpha-parent',
          commandId: 'cmd-alpha-add-leg-3-inv-sync',
          legSpec: { disposal: 'Alpha SWD Leg 3', bbls: 20 },
        },
        auth: staffDispatchA.auth,
      });

      // Verify Company Alpha invoice was synced to total 3
      const alphaInv1 = await fs.collection('invoices').doc('inv-alpha-1').get();
      expect(alphaInv1.data()?.dispatchSplitTotal).toBe(3);

      // Verify Company Beta dispatches and invoices are BYTE-FOR-BYTE IDENTICAL
      const betaSnapshotAfter = await getTenantByteSnapshot('company-beta');
      expect(betaSnapshotAfter).toBe(betaSnapshotBefore);

      // Explicit check on Beta invoices
      const betaInv1 = await fs.collection('invoices').doc('inv-beta-1').get();
      const betaInv2 = await fs.collection('invoices').doc('inv-beta-2').get();
      expect(betaInv1.data()?.dispatchSplitTotal).toBe(2);
      expect(betaInv2.data()?.dispatchSplitTotal).toBe(2);
    });
  });

  // ── 8. Transaction Conflict & Retry: rapid sibling leg additions ──────────
  describe('8. Transaction Conflict & Retry: rapid sibling leg additions', () => {
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

  // ── 9. Unauthorized Actor Rejection ───────────────────────────────────────
  describe('9. Unauthorized Actor Rejection', () => {
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

  // ── 10. Invoice Synchronization Consistency ────────────────────────────────
  describe('10. Invoice Synchronization Consistency', () => {
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
