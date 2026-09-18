import {
  SPLIT_TERMINAL_STATUSES,
  SPLIT_STARTED_STATUSES,
  numSeq,
  evaluateAddSplitLeg,
  evaluateRemoveSplitLeg,
  evaluateResequenceSplitFamily,
  resolveSplitActor,
  defaultSplitCapabilityAuthorizer,
  type SplitActor,
  type SplitCapabilityAuthorizer,
} from '../splitOps';

describe('splitOps module', () => {
  const driverActor: SplitActor = {
    kind: 'driver',
    uid: 'auth-driver-1',
    driverId: 'drv-uuid-1',
    driverHash: 'drv-hash-1',
    companyId: 'acme-hauling',
    displayName: 'John Doe',
  };

  const otherDriverActor: SplitActor = {
    kind: 'driver',
    uid: 'auth-driver-2',
    driverId: 'drv-uuid-2',
    driverHash: 'drv-hash-2',
    companyId: 'acme-hauling',
    displayName: 'Jane Smith',
  };

  const crossCompanyDriverActor: SplitActor = {
    kind: 'driver',
    uid: 'auth-driver-3',
    driverId: 'drv-uuid-3',
    companyId: 'other-company',
  };

  const staffActor: SplitActor = {
    kind: 'staff',
    uid: 'staff-user-1',
    companyId: 'acme-hauling',
    isPlatformAdmin: false,
    roles: ['dispatch'],
    caps: ['manageDrivers'],
  };

  const crossCompanyStaffActor: SplitActor = {
    kind: 'staff',
    uid: 'staff-user-2',
    companyId: 'other-company',
    isPlatformAdmin: false,
    roles: ['admin'],
    caps: ['manageDrivers'],
  };

  const platformAdminActor: SplitActor = {
    kind: 'staff',
    uid: 'platform-admin-1',
    companyId: undefined,
    isPlatformAdmin: true,
    roles: ['admin', 'it'],
    caps: ['manageDrivers', 'viewAllCompanies'],
  };

  const validParentDispatch = {
    id: 'disp-parent-1',
    companyId: 'acme-hauling',
    driverId: 'drv-uuid-1',
    driverHash: 'drv-hash-1',
    driverName: 'John Doe',
    wellName: 'Federal 1-23',
    ndicWellName: 'Federal 1-23',
    bbls: 150,
    status: 'accepted',
    operator: 'Oasis Petroleum',
  };

  // ── Status & Sequence Constants ───────────────────────────────────────────
  describe('constants and sequence helper', () => {
    it('defines terminal and started statuses correctly', () => {
      expect(SPLIT_TERMINAL_STATUSES.has('completed')).toBe(true);
      expect(SPLIT_TERMINAL_STATUSES.has('cancelled')).toBe(true);
      expect(SPLIT_TERMINAL_STATUSES.has('declined')).toBe(true);
      expect(SPLIT_TERMINAL_STATUSES.has('dismissed')).toBe(true);

      expect(SPLIT_STARTED_STATUSES.has('accepted')).toBe(true);
      expect(SPLIT_STARTED_STATUSES.has('in_progress')).toBe(true);
      expect(SPLIT_STARTED_STATUSES.has('paused')).toBe(true);
    });

    it('numSeq correctly parses numbers and defaults non-numbers to infinity', () => {
      expect(numSeq(1)).toBe(1);
      expect(numSeq(42)).toBe(42);
      expect(numSeq('invalid')).toBe(Number.POSITIVE_INFINITY);
      expect(numSeq(null)).toBe(Number.POSITIVE_INFINITY);
      expect(numSeq(undefined)).toBe(Number.POSITIVE_INFINITY);
    });
  });

  // ── evaluateAddSplitLeg ───────────────────────────────────────────────────
  describe('evaluateAddSplitLeg', () => {
    it('rejects missing or malformed arguments', () => {
      expect(
        evaluateAddSplitLeg({
          actor: driverActor,
          parent: validParentDispatch,
          parentDispatchId: '',
          siblings: [],
          legSpec: { disposal: 'SWD #1' },
        }),
      ).toMatchObject({ ok: false, code: 'invalid-argument', reason: 'parentDispatchId is required' });

      expect(
        evaluateAddSplitLeg({
          actor: driverActor,
          parent: null,
          parentDispatchId: 'disp-missing',
          siblings: [],
          legSpec: { disposal: 'SWD #1' },
        }),
      ).toMatchObject({ ok: false, code: 'not-found' });

      expect(
        evaluateAddSplitLeg({
          actor: driverActor,
          parent: validParentDispatch,
          parentDispatchId: 'disp-parent-1',
          siblings: [],
          legSpec: { disposal: '   ' },
        }),
      ).toMatchObject({ ok: false, code: 'invalid-argument', reason: 'legSpec.disposal is required' });
    });

    it('rejects parent with missing companyId (unscoped)', () => {
      const unscopedParent = { ...validParentDispatch, companyId: '' };
      expect(
        evaluateAddSplitLeg({
          actor: driverActor,
          parent: unscopedParent,
          parentDispatchId: 'disp-parent-1',
          siblings: [],
          legSpec: { disposal: 'SWD #1' },
        }),
      ).toMatchObject({ ok: false, code: 'failed-precondition', reason: 'Parent dispatch has no companyId' });
    });

    it('rejects cross-company access for drivers and tenant staff', () => {
      expect(
        evaluateAddSplitLeg({
          actor: crossCompanyDriverActor,
          parent: validParentDispatch,
          parentDispatchId: 'disp-parent-1',
          siblings: [],
          legSpec: { disposal: 'SWD #1' },
        }),
      ).toMatchObject({ ok: false, code: 'permission-denied', reason: 'Cross-company access denied' });

      expect(
        evaluateAddSplitLeg({
          actor: crossCompanyStaffActor,
          parent: validParentDispatch,
          parentDispatchId: 'disp-parent-1',
          siblings: [],
          legSpec: { disposal: 'SWD #1' },
        }),
      ).toMatchObject({ ok: false, code: 'permission-denied', reason: 'Cross-company access denied' });
    });

    it('allows platform admin caller even with undefined companyId', () => {
      const res = evaluateAddSplitLeg({
        actor: platformAdminActor,
        parent: validParentDispatch,
        parentDispatchId: 'disp-parent-1',
        siblings: [],
        legSpec: { disposal: 'SWD #1' },
      });
      expect(res.ok).toBe(true);
    });

    it('rejects driver who is not assigned to the parent dispatch', () => {
      expect(
        evaluateAddSplitLeg({
          actor: otherDriverActor,
          parent: validParentDispatch,
          parentDispatchId: 'disp-parent-1',
          siblings: [],
          legSpec: { disposal: 'SWD #1' },
        }),
      ).toMatchObject({ ok: false, code: 'permission-denied', reason: 'Caller is not assigned to this dispatch' });
    });

    it('rejects splitting a terminal single dispatch (illegal transition)', () => {
      for (const status of ['completed', 'cancelled', 'declined', 'dismissed']) {
        const terminalParent = { ...validParentDispatch, status, splitGroupId: undefined };
        expect(
          evaluateAddSplitLeg({
            actor: staffActor,
            parent: terminalParent,
            parentDispatchId: 'disp-parent-1',
            siblings: [],
            legSpec: { disposal: 'SWD #1' },
          }),
        ).toMatchObject({ ok: false, code: 'failed-precondition' });
      }
    });

    it('handles Single -> Split auto-minting correctly', () => {
      const singleParent = {
        ...validParentDispatch,
        splitGroupId: undefined,
        wellName: 'Origin Well Alpha',
      };
      const res = evaluateAddSplitLeg({
        actor: driverActor,
        parent: singleParent,
        parentDispatchId: 'disp-parent-1',
        siblings: [],
        legSpec: {
          disposal: 'Deep River SWD',
          destinationType: 'SWD',
          bbls: 50,
        },
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.isFirstSplit).toBe(true);
      expect(res.splitGroupId).toMatch(/^split_\d+_/);
      expect(res.nextSequence).toBe(2);
      expect(res.newTotal).toBe(2);
      expect(res.anchorWellName).toBe('Origin Well Alpha');
      expect(res.parentBblsBefore).toBe(150);
      expect(res.parentBblsAfter).toBe(100);
      expect(res.reduceBy).toBe(50);

      // Verify fields stamped on new leg
      expect(res.newDispatchFields.wellName).toBe('Deep River SWD');
      expect(res.newDispatchFields.pickupWellName).toBe('Origin Well Alpha');
      expect(res.newDispatchFields.destinationType).toBe('SWD');
      expect(res.newDispatchFields.legType).toBe('disposal');
      expect(res.newDispatchFields.bbls).toBe(50);
      expect(res.newDispatchFields.splitSequence).toBe(2);
      expect(res.newDispatchFields.splitTotal).toBe(2);
      expect(res.newDispatchFields.status).toBe('pending');
      expect(res.newDispatchFields.splitOriginatedAt).toBe('field');

      // Verify updates for parent
      expect(res.parentUpdateFields.splitGroupId).toBe(res.splitGroupId);
      expect(res.parentUpdateFields.splitSequence).toBe(1);
      expect(res.parentUpdateFields.splitTotal).toBe(2);
      expect(res.parentUpdateFields.bbls).toBe(100);
    });

    it('rejects a split family with mixed company members', () => {
      const parentInFamily = {
        ...validParentDispatch,
        splitGroupId: 'split-fam-1',
      };
      const mixedSiblings = [
        { id: 'disp-parent-1', companyId: 'acme-hauling', splitSequence: 1 },
        { id: 'disp-sib-2', companyId: 'evil-tenant', splitSequence: 2 },
      ];

      expect(
        evaluateAddSplitLeg({
          actor: staffActor,
          parent: parentInFamily,
          parentDispatchId: 'disp-parent-1',
          siblings: mixedSiblings,
          legSpec: { disposal: 'SWD #2' },
        }),
      ).toMatchObject({
        ok: false,
        code: 'failed-precondition',
        reason: 'Split family contains mixed company members',
      });
    });

    it('appends to an existing split family correctly', () => {
      const parentInFamily = {
        ...validParentDispatch,
        splitGroupId: 'split-fam-1',
      };
      const existingSiblings = [
        { id: 'disp-leg-1', companyId: 'acme-hauling', splitSequence: 1, wellName: 'Anchor Well' },
        { id: 'disp-leg-2', companyId: 'acme-hauling', splitSequence: 2, wellName: 'SWD 1' },
      ];

      const res = evaluateAddSplitLeg({
        actor: driverActor,
        parent: parentInFamily,
        parentDispatchId: 'disp-parent-1',
        siblings: existingSiblings,
        legSpec: { disposal: 'SWD 2' },
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.isFirstSplit).toBe(false);
      expect(res.splitGroupId).toBe('split-fam-1');
      expect(res.nextSequence).toBe(3);
      expect(res.newTotal).toBe(3);
      expect(res.anchorWellName).toBe('Anchor Well');
      expect(res.siblingUpdateFields.splitTotal).toBe(3);
    });

    it('safely preserves BBLs when legSpec.bbls is 0 or missing', () => {
      const res = evaluateAddSplitLeg({
        actor: staffActor,
        parent: validParentDispatch,
        parentDispatchId: 'disp-parent-1',
        siblings: [],
        legSpec: { disposal: 'SWD #1', bbls: 0 },
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.reduceBy).toBe(0);
      expect(res.parentBblsAfter).toBe(150);
      expect(res.parentUpdateFields.bbls).toBeUndefined();
    });
  });

  // ── evaluateRemoveSplitLeg ────────────────────────────────────────────────
  describe('evaluateRemoveSplitLeg', () => {
    const familyLegs = [
      { id: 'leg-1', companyId: 'acme-hauling', driverId: 'drv-uuid-1', splitGroupId: 'fam-1', splitSequence: 1, status: 'in_progress' },
      { id: 'leg-2', companyId: 'acme-hauling', driverId: 'drv-uuid-1', splitGroupId: 'fam-1', splitSequence: 2, status: 'pending' },
      { id: 'leg-3', companyId: 'acme-hauling', driverId: 'drv-uuid-1', splitGroupId: 'fam-1', splitSequence: 3, status: 'pending' },
    ];

    it('rejects missing or malformed inputs', () => {
      expect(
        evaluateRemoveSplitLeg({
          actor: driverActor,
          legDispatchId: '',
          leg: familyLegs[1],
          family: familyLegs,
        }),
      ).toMatchObject({ ok: false, code: 'invalid-argument' });

      expect(
        evaluateRemoveSplitLeg({
          actor: driverActor,
          legDispatchId: 'leg-missing',
          leg: null,
          family: familyLegs,
        }),
      ).toMatchObject({ ok: false, code: 'not-found' });
    });

    it('rejects dispatches not part of a split family', () => {
      const nonSplit = { ...familyLegs[1], splitGroupId: '' };
      expect(
        evaluateRemoveSplitLeg({
          actor: driverActor,
          legDispatchId: 'leg-2',
          leg: nonSplit,
          family: [nonSplit],
        }),
      ).toMatchObject({ ok: false, code: 'failed-precondition', reason: 'Dispatch is not part of a split family' });
    });

    it('rejects cross-company access', () => {
      expect(
        evaluateRemoveSplitLeg({
          actor: crossCompanyDriverActor,
          legDispatchId: 'leg-2',
          leg: familyLegs[1],
          family: familyLegs,
        }),
      ).toMatchObject({ ok: false, code: 'permission-denied', reason: 'Cross-company access denied' });
    });

    it('rejects mixed company family members', () => {
      const mixed = [
        familyLegs[0],
        familyLegs[1],
        { ...familyLegs[2], companyId: 'rogue-company' },
      ];
      expect(
        evaluateRemoveSplitLeg({
          actor: staffActor,
          legDispatchId: 'leg-2',
          leg: familyLegs[1],
          family: mixed,
        }),
      ).toMatchObject({ ok: false, code: 'failed-precondition', reason: 'Split family contains mixed company members' });
    });

    it('rejects removing the anchor leg (seq 1)', () => {
      expect(
        evaluateRemoveSplitLeg({
          actor: staffActor,
          legDispatchId: 'leg-1',
          leg: familyLegs[0],
          family: familyLegs,
        }),
      ).toMatchObject({
        ok: false,
        code: 'failed-precondition',
        reason: 'Cannot remove the anchor leg (A) — cancel the family instead.',
      });
    });

    it('rejects removing a started leg (accepted/in_progress/paused)', () => {
      const startedLeg = { ...familyLegs[1], status: 'in_progress' };
      const famWithStarted = [familyLegs[0], startedLeg, familyLegs[2]];
      expect(
        evaluateRemoveSplitLeg({
          actor: staffActor,
          legDispatchId: 'leg-2',
          leg: startedLeg,
          family: famWithStarted,
        }),
      ).toMatchObject({
        ok: false,
        code: 'failed-precondition',
        reason: 'Cannot remove a started leg (status in_progress).',
      });
    });

    it('handles idempotent call when leg is already cancelled and marked splitLegRemoved', () => {
      const alreadyRemoved = { ...familyLegs[1], status: 'cancelled', splitLegRemoved: true };
      const fam = [familyLegs[0], alreadyRemoved, familyLegs[2]];
      const res = evaluateRemoveSplitLeg({
        actor: staffActor,
        legDispatchId: 'leg-2',
        leg: alreadyRemoved,
        family: fam,
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.idempotent).toBe(true);
      expect(res.removedId).toBe('leg-2');
    });

    it('removes a pending unstarted leg and resequences remaining siblings contiguously', () => {
      const res = evaluateRemoveSplitLeg({
        actor: driverActor,
        legDispatchId: 'leg-2',
        leg: familyLegs[1],
        family: familyLegs,
        reason: 'Customer cancelled stop',
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.removedId).toBe('leg-2');
      expect(res.newTotal).toBe(2);
      expect(res.order).toEqual([
        { id: 'leg-1', splitSequence: 1 },
        { id: 'leg-3', splitSequence: 2 },
      ]);
      expect(res.cancelFields.status).toBe('cancelled');
      expect(res.cancelFields.splitLegRemoved).toBe(true);
      expect(res.cancelFields.splitRemoveReason).toBe('Customer cancelled stop');
      expect(res.cancelFields.splitRemovedBy).toBe('drv-uuid-1');
    });
  });

  // ── evaluateResequenceSplitFamily ─────────────────────────────────────────
  describe('evaluateResequenceSplitFamily', () => {
    const liveFamily = [
      { id: 'leg-A', companyId: 'acme-hauling', driverId: 'drv-uuid-1', splitSequence: 1, status: 'accepted' },
      { id: 'leg-B', companyId: 'acme-hauling', driverId: 'drv-uuid-1', splitSequence: 2, status: 'pending' },
      { id: 'leg-C', companyId: 'acme-hauling', driverId: 'drv-uuid-1', splitSequence: 3, status: 'pending' },
      { id: 'leg-D', companyId: 'acme-hauling', driverId: 'drv-uuid-1', splitSequence: 4, status: 'completed' }, // terminal
    ];

    it('rejects malformed arguments', () => {
      expect(
        evaluateResequenceSplitFamily({
          actor: driverActor,
          splitGroupId: '',
          orderedLegIds: ['leg-A', 'leg-B', 'leg-C'],
          family: liveFamily,
        }),
      ).toMatchObject({ ok: false, code: 'invalid-argument' });

      expect(
        evaluateResequenceSplitFamily({
          actor: driverActor,
          splitGroupId: 'fam-1',
          orderedLegIds: [],
          family: liveFamily,
        }),
      ).toMatchObject({ ok: false, code: 'invalid-argument' });
    });

    it('rejects empty family (not found)', () => {
      expect(
        evaluateResequenceSplitFamily({
          actor: driverActor,
          splitGroupId: 'fam-empty',
          orderedLegIds: ['leg-A'],
          family: [],
        }),
      ).toMatchObject({ ok: false, code: 'not-found' });
    });

    it('rejects cross-company access and mixed family', () => {
      expect(
        evaluateResequenceSplitFamily({
          actor: crossCompanyDriverActor,
          splitGroupId: 'fam-1',
          orderedLegIds: ['leg-A', 'leg-B', 'leg-C'],
          family: liveFamily,
        }),
      ).toMatchObject({ ok: false, code: 'permission-denied', reason: 'Cross-company access denied' });

      const mixed = [
        liveFamily[0],
        { ...liveFamily[1], companyId: 'other-company' },
        liveFamily[2],
      ];
      expect(
        evaluateResequenceSplitFamily({
          actor: staffActor,
          splitGroupId: 'fam-1',
          orderedLegIds: ['leg-A', 'leg-B', 'leg-C'],
          family: mixed,
        }),
      ).toMatchObject({ ok: false, code: 'failed-precondition', reason: 'Split family contains mixed company members' });
    });

    it('rejects driver who is not assigned to all legs', () => {
      const differentDriverFam = [
        liveFamily[0],
        { ...liveFamily[1], driverId: 'different-drv' },
        liveFamily[2],
      ];
      expect(
        evaluateResequenceSplitFamily({
          actor: driverActor,
          splitGroupId: 'fam-1',
          orderedLegIds: ['leg-A', 'leg-B', 'leg-C'],
          family: differentDriverFam,
        }),
      ).toMatchObject({ ok: false, code: 'permission-denied' });
    });

    it('rejects if orderedLegIds does not match the exact set of live non-terminal legs', () => {
      // Extra leg or terminal leg included
      expect(
        evaluateResequenceSplitFamily({
          actor: driverActor,
          splitGroupId: 'fam-1',
          orderedLegIds: ['leg-A', 'leg-B', 'leg-C', 'leg-D'],
          family: liveFamily,
        }),
      ).toMatchObject({ ok: false, code: 'failed-precondition' });

      // Missing leg
      expect(
        evaluateResequenceSplitFamily({
          actor: driverActor,
          splitGroupId: 'fam-1',
          orderedLegIds: ['leg-A', 'leg-B'],
          family: liveFamily,
        }),
      ).toMatchObject({ ok: false, code: 'failed-precondition' });

      // Duplicate leg IDs
      expect(
        evaluateResequenceSplitFamily({
          actor: driverActor,
          splitGroupId: 'fam-1',
          orderedLegIds: ['leg-A', 'leg-B', 'leg-B'],
          family: liveFamily,
        }),
      ).toMatchObject({ ok: false, code: 'failed-precondition' });
    });

    it('rejects moving anchor leg (A)', () => {
      expect(
        evaluateResequenceSplitFamily({
          actor: driverActor,
          splitGroupId: 'fam-1',
          orderedLegIds: ['leg-B', 'leg-A', 'leg-C'],
          family: liveFamily,
        }),
      ).toMatchObject({ ok: false, code: 'failed-precondition', reason: 'Anchor leg (A) cannot move' });
    });

    it('rejects moving a started leg', () => {
      const famWithStarted = [
        liveFamily[0], // accepted (anchor)
        { ...liveFamily[1], status: 'in_progress' }, // started leg at index 1
        liveFamily[2], // pending at index 2
      ];
      expect(
        evaluateResequenceSplitFamily({
          actor: driverActor,
          splitGroupId: 'fam-1',
          orderedLegIds: ['leg-A', 'leg-C', 'leg-B'],
          family: famWithStarted,
        }),
      ).toMatchObject({
        ok: false,
        code: 'failed-precondition',
        reason: 'A started/anchor leg cannot change position (index 1).',
      });
    });

    it('is idempotent when requested order matches current order', () => {
      const res = evaluateResequenceSplitFamily({
        actor: driverActor,
        splitGroupId: 'fam-1',
        orderedLegIds: ['leg-A', 'leg-B', 'leg-C'],
        family: liveFamily,
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.idempotent).toBe(true);
      expect(res.updates).toEqual([]);
    });

    it('successfully resequences unstarted legs in a family', () => {
      const res = evaluateResequenceSplitFamily({
        actor: driverActor,
        splitGroupId: 'fam-1',
        orderedLegIds: ['leg-A', 'leg-C', 'leg-B'],
        family: liveFamily,
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.idempotent).toBeUndefined();
      expect(res.newTotal).toBe(3);
      expect(res.order).toEqual([
        { id: 'leg-A', splitSequence: 1 },
        { id: 'leg-C', splitSequence: 2 },
        { id: 'leg-B', splitSequence: 3 },
      ]);
      expect(res.updates).toEqual([
        { id: 'leg-A', splitSequence: 1, splitTotal: 3 },
        { id: 'leg-C', splitSequence: 2, splitTotal: 3 },
        { id: 'leg-B', splitSequence: 3, splitTotal: 3 },
      ]);
    });
  });

  // ── Capability Enforcement Seam ───────────────────────────────────────────
  describe('capability enforcement seam', () => {
    it('default authorizer permits valid split operations', async () => {
      const res = await defaultSplitCapabilityAuthorizer.authorizeSplitOperation({
        operation: 'add',
        actor: driverActor,
      });
      expect(res.allowed).toBe(true);
    });

    it('allows custom authorizer to reject split operations', async () => {
      const restrictingAuthorizer: SplitCapabilityAuthorizer = {
        async authorizeSplitOperation(context) {
          if (context.operation === 'resequence') {
            return { allowed: false, reason: 'Split resequencing disabled for this tenant packet' };
          }
          return { allowed: true };
        },
      };

      const res = await restrictingAuthorizer.authorizeSplitOperation({
        operation: 'resequence',
        actor: driverActor,
      });
      expect(res.allowed).toBe(false);
      expect(res.reason).toBe('Split resequencing disabled for this tenant packet');
    });
  });

  // ── resolveSplitActor ─────────────────────────────────────────────────────
  describe('resolveSplitActor', () => {
    it('rejects unauthenticated caller', async () => {
      await expect(
        resolveSplitActor({ auth: null } as any),
      ).rejects.toThrow('Authentication required');
    });

    it('resolves active driver with custom claims', async () => {
      const request = {
        auth: {
          uid: 'auth-uid-1',
          token: { kind: 'driver', driverId: 'drv-1', companyId: 'acme' },
        },
      } as any;
      const readers = {
        getDriverProfile: async () => ({
          exists: true,
          active: true,
          companyId: 'acme',
          displayName: 'Driver Joe',
        }),
      };
      const actor = await resolveSplitActor(request, null, readers);
      expect(actor).toEqual({
        kind: 'driver',
        uid: 'auth-uid-1',
        driverId: 'drv-1',
        driverHash: 'drv-1',
        companyId: 'acme',
        displayName: 'Driver Joe',
      });
    });

    it('rejects deactivated driver with custom claims', async () => {
      const request = {
        auth: {
          uid: 'auth-uid-1',
          token: { kind: 'driver', driverId: 'drv-1', companyId: 'acme' },
        },
      } as any;
      const readers = {
        getDriverProfile: async () => ({
          exists: true,
          active: false,
          companyId: 'acme',
        }),
      };
      await expect(resolveSplitActor(request, null, readers)).rejects.toThrow('Driver deactivated');
    });

    it('rejects driver without company', async () => {
      const request = {
        auth: {
          uid: 'auth-uid-1',
          token: { kind: 'driver', driverId: 'drv-1' },
        },
      } as any;
      const readers = {
        getDriverProfile: async () => ({
          exists: true,
          active: true,
          companyId: null,
        }),
      };
      await expect(resolveSplitActor(request, null, readers)).rejects.toThrow('Driver has no assigned company');
    });

    it('rejects spoofed callerDriverHash for driver', async () => {
      const request = {
        auth: {
          uid: 'auth-uid-1',
          token: { kind: 'driver', driverId: 'drv-1', companyId: 'acme' },
        },
      } as any;
      const readers = {
        getDriverProfile: async () => ({
          exists: true,
          active: true,
          companyId: 'acme',
          legacyDriverHash: 'leg-hash-1',
        }),
      };
      await expect(
        resolveSplitActor(request, 'spoofed-attacker-hash', readers),
      ).rejects.toThrow('Spoofed driver hash: does not match authenticated driver');
    });

    it('accepts matching callerDriverHash', async () => {
      const request = {
        auth: {
          uid: 'auth-uid-1',
          token: { kind: 'driver', driverId: 'drv-1', companyId: 'acme' },
        },
      } as any;
      const readers = {
        getDriverProfile: async () => ({
          exists: true,
          active: true,
          companyId: 'acme',
          legacyDriverHash: 'leg-hash-1',
        }),
      };
      const actor = await resolveSplitActor(request, 'leg-hash-1', readers);
      expect(actor.kind).toBe('driver');
      if (actor.kind === 'driver') {
        expect(actor.driverHash).toBe('leg-hash-1');
      }
    });

    it('resolves driver via direct profile by uid', async () => {
      const request = {
        auth: {
          uid: 'direct-driver-uid',
          token: {},
        },
      } as any;
      const readers = {
        getDriverProfile: async (id: string) => ({
          exists: id === 'direct-driver-uid',
          active: true,
          companyId: 'acme-direct',
          displayName: 'Direct Driver',
        }),
      };
      const actor = await resolveSplitActor(request, null, readers);
      expect(actor).toEqual({
        kind: 'driver',
        uid: 'direct-driver-uid',
        driverId: 'direct-driver-uid',
        driverHash: 'direct-driver-uid',
        companyId: 'acme-direct',
        displayName: 'Direct Driver',
      });
    });

    it('resolves dashboard staff caller with dispatch role', async () => {
      const request = {
        auth: {
          uid: 'staff-dispatcher-1',
          token: {},
        },
      } as any;
      const readers = {
        getDriverProfile: async () => ({ exists: false }),
        getDashboardUser: async () => ({
          uid: 'staff-dispatcher-1',
          roles: ['dispatch'],
          companyId: 'acme',
          caps: [],
          isPlatformAdmin: false,
        }),
      };
      const actor = await resolveSplitActor(request, null, readers);
      expect(actor).toEqual({
        kind: 'staff',
        uid: 'staff-dispatcher-1',
        companyId: 'acme',
        isPlatformAdmin: false,
        roles: ['dispatch'],
        caps: [],
      });
    });

    it('resolves dashboard staff caller with manageDrivers capability', async () => {
      const request = {
        auth: {
          uid: 'staff-manager-1',
          token: {},
        },
      } as any;
      const readers = {
        getDriverProfile: async () => ({
          exists: false,
        }),
        getDashboardUser: async () => ({
          uid: 'staff-manager-1',
          roles: ['custom_role'],
          companyId: 'acme',
          caps: ['manageDrivers'],
          isPlatformAdmin: false,
        }),
      };
      const actor = await resolveSplitActor(request, null, readers);
      expect(actor.kind).toBe('staff');
    });

    it('rejects dashboard user with unprivileged viewer role', async () => {
      const request = {
        auth: {
          uid: 'viewer-uid',
          token: {},
        },
      } as any;
      const readers = {
        getDriverProfile: async () => ({ exists: false }),
        getDashboardUser: async () => ({
          uid: 'viewer-uid',
          roles: ['viewer'],
          companyId: 'acme',
          caps: [],
          isPlatformAdmin: false,
        }),
      };
      await expect(resolveSplitActor(request, null, readers)).rejects.toThrow('Caller lacks required staff permissions');
    });
  });

  // ── Callable Export & Source Verification ─────────────────────────────────
  describe('callable export and source verification', () => {
    const fs = require('fs');
    const path = require('path');

    it('verifies index.ts exports all three split callables', () => {
      const indexSrc = fs.readFileSync(path.join(__dirname, '../../../../src/index.ts'), 'utf8');
      expect(indexSrc).toMatch(/\baddSplitLeg\b/);
      expect(indexSrc).toMatch(/\bremoveSplitLeg\b/);
      expect(indexSrc).toMatch(/\bresequenceSplitFamily\b/);
    });

    it('verifies security/index.ts exports all three split callables', () => {
      const secSrc = fs.readFileSync(path.join(__dirname, '../../../security/index.ts'), 'utf8');
      expect(secSrc).toMatch(/\baddSplitLeg\b/);
      expect(secSrc).toMatch(/\bremoveSplitLeg\b/);
      expect(secSrc).toMatch(/\bresequenceSplitFamily\b/);
    });

    it('verifies operational/index.ts exports all three split callables', () => {
      const opSrc = fs.readFileSync(path.join(__dirname, '../index.ts'), 'utf8');
      expect(opSrc).toMatch(/\baddSplitLeg\b/);
      expect(opSrc).toMatch(/\bremoveSplitLeg\b/);
      expect(opSrc).toMatch(/\bresequenceSplitFamily\b/);
    });

    it('verifies splitOps.ts implements transactional tenant-scoped updates', () => {
      const splitOpsSrc = fs.readFileSync(path.join(__dirname, '../splitOps.ts'), 'utf8');
      // Transaction check
      expect(splitOpsSrc).toContain('runTransaction');
      // Tenant-scoped queries
      expect(splitOpsSrc).toContain("where('companyId', '==',");
      expect(splitOpsSrc).toContain("where('splitGroupId', '==',");
      // Actor resolution check
      expect(splitOpsSrc).toContain('resolveSplitActor');
      // Audit log check
      expect(splitOpsSrc).toContain('writeSecurityAudit');
    });
  });
});
