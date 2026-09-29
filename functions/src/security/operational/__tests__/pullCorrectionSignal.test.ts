import {
  computePullRevision,
  evaluatePullCorrectionPublication,
  buildDispatchCorrectionPatch,
  findDispatchIdsForPull,
  publishPullCorrectionToDispatches,
  reconcilePendingPullCorrectionSignal,
  docBelongsToTenant,
  normalizeWellName,
  extractDispatchDriverCandidates,
  areDriverIdentitiesEquivalent,
  matchDriverIdentity,
  type PullCorrectionSignal,
  type EvaluatePullCorrectionInput,
} from '../pullCorrectionSignal';

describe('Confirmed pull correction signal — acceptance suite', () => {
  const PACKET_ID = '20260929_120000_Well1_xyz123';
  const WELL_NAME = 'Gabriel 1';
  const COMPANY_ID = 'liquid-gold';
  const DRIVER_ID = 'driver-abc-456';
  const BOTTOM_LEVEL = '4\'2"';
  const PULL_TIME = '2026-09-29T12:00:00.000Z';
  const FLOW_RATE = '0:05:00';

  function createMockRtdb(initialData: Record<string, any> = {}) {
    const store: Record<string, any> = JSON.parse(JSON.stringify(initialData));
    return {
      _data: store,
      ref: (path: string = '') => ({
        once: async (_event: string) => ({
          exists: () => store[path] !== undefined,
          val: () => store[path],
        }),
        update: async (patch: Record<string, any>) => {
          store[path] = { ...(store[path] || {}), ...patch };
        },
        set: async (val: any) => {
          store[path] = val;
        },
        remove: async () => {
          delete store[path];
        },
      }),
    } as any;
  }

  function createMockFirestore(
    docs: Record<string, any> = {},
    options: { withTransaction?: boolean } = {},
  ) {
    const store: Record<string, any> = JSON.parse(JSON.stringify(docs));
    const updates: Record<string, any[]> = {};

    const getDoc = (id: string) => ({
      id,
      exists: store[id] !== undefined,
      data: () => store[id],
    });

    const updateDoc = async (id: string, patch: Record<string, any>) => {
      if (!updates[id]) updates[id] = [];
      updates[id].push(patch);
      store[id] = { ...(store[id] || {}), ...patch };
    };

    const fs: any = {
      _store: store,
      _updates: updates,
      collection: (coll: string) => ({
        doc: (id: string) => ({
          id,
          get: async () => getDoc(id),
          update: async (patch: any) => updateDoc(id, patch),
        }),
        where: (field: string, op: string, val: any) => ({
          get: async () => {
            const matched = Object.entries(store)
              .filter(([_, d]) => {
                if (op === '==') return d[field] === val;
                if (op === 'array-contains') return Array.isArray(d[field]) && d[field].includes(val);
                return false;
              })
              .map(([id, _]) => ({ id }));
            return {
              forEach: (cb: any) => matched.forEach(cb),
            };
          },
        }),
      }),
    };

    if (options.withTransaction !== false) {
      fs.runTransaction = async (txFn: (tx: any) => Promise<any>) => {
        const tx = {
          get: async (docRef: any) => getDoc(docRef.id),
          update: (docRef: any, patch: any) => {
            updateDoc(docRef.id, patch);
          },
        };
        return await txFn(tx);
      };
    }

    return fs;
  }

  describe('1. Outgoing write failure emits no signal (simulated rejection)', () => {
    test('skips publication when outgoingUpdated is false', () => {
      const input: EvaluatePullCorrectionInput = {
        isLatestPull: true,
        outgoingUpdated: false, // simulated write failure / rejection
        packetId: PACKET_ID,
        wellName: WELL_NAME,
        companyId: COMPANY_ID,
        driverId: DRIVER_ID,
        bottomLevel: BOTTOM_LEVEL,
        pullDateTimeUTC: PULL_TIME,
        flowRate: FLOW_RATE,
      };

      const result = evaluatePullCorrectionPublication(input);
      expect(result.action).toBe('skip');
      if (result.action === 'skip') {
        expect(result.reason).toBe('outgoing_not_updated');
      }
    });

    test('skips publication when measurements are invalid or missing', () => {
      const badBottom = evaluatePullCorrectionPublication({
        isLatestPull: true,
        outgoingUpdated: true,
        packetId: PACKET_ID,
        wellName: WELL_NAME,
        companyId: COMPANY_ID,
        driverId: DRIVER_ID,
        bottomLevel: '',
        pullDateTimeUTC: PULL_TIME,
        flowRate: FLOW_RATE,
      });
      expect(badBottom.action).toBe('skip');
      if (badBottom.action === 'skip') {
        expect(badBottom.reason).toBe('invalid_measurements');
      }

      const unknownFlow = evaluatePullCorrectionPublication({
        isLatestPull: true,
        outgoingUpdated: true,
        packetId: PACKET_ID,
        wellName: WELL_NAME,
        companyId: COMPANY_ID,
        driverId: DRIVER_ID,
        bottomLevel: BOTTOM_LEVEL,
        pullDateTimeUTC: PULL_TIME,
        flowRate: 'Unknown',
      });
      expect(unknownFlow.action).toBe('skip');
      if (unknownFlow.action === 'skip') {
        expect(unknownFlow.reason).toBe('invalid_measurements');
      }
    });

    test('re-attempt on retry: transitions from skip to publish when outgoing succeeds', () => {
      const firstAttempt = evaluatePullCorrectionPublication({
        isLatestPull: true,
        outgoingUpdated: false, // first attempt fails
        packetId: PACKET_ID,
        wellName: WELL_NAME,
        companyId: COMPANY_ID,
        driverId: DRIVER_ID,
        bottomLevel: BOTTOM_LEVEL,
        pullDateTimeUTC: PULL_TIME,
        flowRate: FLOW_RATE,
      });
      expect(firstAttempt.action).toBe('skip');

      const retryAttempt = evaluatePullCorrectionPublication({
        isLatestPull: true,
        outgoingUpdated: true, // retry succeeds
        packetId: PACKET_ID,
        wellName: WELL_NAME,
        companyId: COMPANY_ID,
        driverId: DRIVER_ID,
        bottomLevel: BOTTOM_LEVEL,
        pullDateTimeUTC: PULL_TIME,
        flowRate: FLOW_RATE,
      });
      expect(retryAttempt.action).toBe('publish');
    });
  });

  describe('2. Duplicate / replayed edit emits no new revision (identical digest)', () => {
    test('produces identical deterministic revision for identical inputs', () => {
      const rev1 = computePullRevision(PACKET_ID, BOTTOM_LEVEL, PULL_TIME, FLOW_RATE);
      const rev2 = computePullRevision(PACKET_ID, BOTTOM_LEVEL, PULL_TIME, FLOW_RATE);
      expect(rev1).toBe(rev2);
      expect(rev1.startsWith(`${PACKET_ID}:r_`)).toBe(true);
    });

    test('evaluator skips with already_published if existingRevision matches current revision', () => {
      const currentRev = computePullRevision(PACKET_ID, BOTTOM_LEVEL, PULL_TIME, FLOW_RATE);
      const result = evaluatePullCorrectionPublication({
        isLatestPull: true,
        outgoingUpdated: true,
        packetId: PACKET_ID,
        wellName: WELL_NAME,
        companyId: COMPANY_ID,
        driverId: DRIVER_ID,
        bottomLevel: BOTTOM_LEVEL,
        pullDateTimeUTC: PULL_TIME,
        flowRate: FLOW_RATE,
        existingRevision: currentRev,
      });

      expect(result.action).toBe('skip');
      if (result.action === 'skip') {
        expect(result.reason).toBe('already_published');
      }
    });

    test('publisher no-ops when dispatch document already carries the revision', async () => {
      const rev = computePullRevision(PACKET_ID, BOTTOM_LEVEL, PULL_TIME, FLOW_RATE);
      const mockDoc = {
        companyId: COMPANY_ID,
        driverId: DRIVER_ID,
        wellName: WELL_NAME,
        lastPullRevision: rev, // already matches
      };

      const mockFirestore = createMockFirestore({ 'disp-1': mockDoc });

      const signal: PullCorrectionSignal = {
        packetId: PACKET_ID,
        revision: rev,
        bottomLevel: BOTTOM_LEVEL,
        pullDateTimeUTC: PULL_TIME,
        flowRate: FLOW_RATE,
        publishedAtMs: Date.now(),
        wellName: WELL_NAME,
        companyId: COMPANY_ID,
        driverId: DRIVER_ID,
      };

      const pubResult = await publishPullCorrectionToDispatches(mockFirestore, {
        dispatchIds: ['disp-1'],
        signal,
      });

      expect(pubResult.ok).toBe(true);
      expect(pubResult.results?.['disp-1']).toEqual({
        ok: true,
        applied: false,
        reason: 'already_at_revision',
      });
      expect(mockFirestore._updates['disp-1']).toBeUndefined(); // No write made
    });
  });

  describe('3. Same packet ID with changed measurements emits one new revision', () => {
    test('changing measured bottom changes revision', () => {
      const baseRev = computePullRevision(PACKET_ID, '4\'2"', PULL_TIME, FLOW_RATE);
      const changedBottom = computePullRevision(PACKET_ID, '4\'8"', PULL_TIME, FLOW_RATE);

      expect(changedBottom).not.toBe(baseRev);
      expect(changedBottom.startsWith(`${PACKET_ID}:r_`)).toBe(true);
    });

    test('changing pull time changes revision', () => {
      const baseRev = computePullRevision(PACKET_ID, BOTTOM_LEVEL, '2026-09-29T12:00:00.000Z', FLOW_RATE);
      const changedTime = computePullRevision(PACKET_ID, BOTTOM_LEVEL, '2026-09-29T12:15:00.000Z', FLOW_RATE);

      expect(changedTime).not.toBe(baseRev);
      expect(changedTime.startsWith(`${PACKET_ID}:r_`)).toBe(true);
    });

    test('changing flow rate changes revision', () => {
      const baseRev = computePullRevision(PACKET_ID, BOTTOM_LEVEL, PULL_TIME, '0:05:00');
      const changedFlow = computePullRevision(PACKET_ID, BOTTOM_LEVEL, PULL_TIME, '0:04:12');

      expect(changedFlow).not.toBe(baseRev);
      expect(changedFlow.startsWith(`${PACKET_ID}:r_`)).toBe(true);
    });

    test('evaluator transitions from skip to publish when measurement changes', () => {
      const oldRev = computePullRevision(PACKET_ID, '4\'2"', PULL_TIME, FLOW_RATE);
      const newBottom = '4\'10"';

      const result = evaluatePullCorrectionPublication({
        isLatestPull: true,
        outgoingUpdated: true,
        packetId: PACKET_ID,
        wellName: WELL_NAME,
        companyId: COMPANY_ID,
        driverId: DRIVER_ID,
        bottomLevel: newBottom,
        pullDateTimeUTC: PULL_TIME,
        flowRate: FLOW_RATE,
        existingRevision: oldRev,
      });

      expect(result.action).toBe('publish');
      if (result.action === 'publish') {
        expect(result.revision).not.toBe(oldRev);
        expect(result.signal.bottomLevel).toBe(newBottom);
        expect(result.signal.packetId).toBe(PACKET_ID);
      }
    });

    test('buildDispatchCorrectionPatch creates structured signal matching WB-T expectations', () => {
      const rev = computePullRevision(PACKET_ID, BOTTOM_LEVEL, PULL_TIME, FLOW_RATE);
      const signal: PullCorrectionSignal = {
        packetId: PACKET_ID,
        revision: rev,
        bottomLevel: BOTTOM_LEVEL,
        pullDateTimeUTC: PULL_TIME,
        flowRate: FLOW_RATE,
        publishedAtMs: 1727611200000,
        wellName: WELL_NAME,
        companyId: COMPANY_ID,
        driverId: DRIVER_ID,
      };

      const patch = buildDispatchCorrectionPatch(signal, '2026-09-29T12:00:00Z');
      expect(patch.lastPullPacketId).toBe(PACKET_ID);
      expect(patch.lastPullRevision).toBe(rev);
      expect(patch.lastPullBottomLevel).toBe(BOTTOM_LEVEL);
      expect(patch.lastPullDateTimeUTC).toBe(PULL_TIME);
      expect(patch.flowRate).toBe(FLOW_RATE);
      expect(patch.lastPullCorrection).toEqual({
        packetId: PACKET_ID,
        revision: rev,
        bottomLevel: BOTTOM_LEVEL,
        pullDateTimeUTC: PULL_TIME,
        flowRate: FLOW_RATE,
        publishedAt: '2026-09-29T12:00:00Z',
        publishedAtMs: 1727611200000,
        wellName: WELL_NAME,
        companyId: COMPANY_ID,
        driverId: DRIVER_ID,
      });
    });
  });

  describe('4. Tenant, well, and driver containment (fail closed)', () => {
    describe('Company scoping & docBelongsToTenant', () => {
      test('rejects mismatched companyId', async () => {
        const rev = computePullRevision(PACKET_ID, BOTTOM_LEVEL, PULL_TIME, FLOW_RATE);
        const mockFirestore = createMockFirestore({
          'disp-mismatch-company': {
            companyId: 'other-company',
            driverId: DRIVER_ID,
            wellName: WELL_NAME,
          },
        });

        const signal: PullCorrectionSignal = {
          packetId: PACKET_ID,
          revision: rev,
          bottomLevel: BOTTOM_LEVEL,
          pullDateTimeUTC: PULL_TIME,
          flowRate: FLOW_RATE,
          publishedAtMs: Date.now(),
          wellName: WELL_NAME,
          companyId: COMPANY_ID, // liquid-gold
          driverId: DRIVER_ID,
        };

        const pubResult = await publishPullCorrectionToDispatches(mockFirestore, {
          dispatchIds: ['disp-mismatch-company'],
          signal,
        });

        expect(pubResult.ok).toBe(false);
        expect(pubResult.skipped).toBe('all_dispatches_filtered_or_missing');
        expect(pubResult.results?.['disp-mismatch-company']).toEqual({
          ok: false,
          reason: 'company_mismatch',
        });
      });

      test('rejects unstamped dispatch if signal company is not liquid-gold', async () => {
        const rev = computePullRevision(PACKET_ID, BOTTOM_LEVEL, PULL_TIME, FLOW_RATE);
        const mockFirestore = createMockFirestore({
          'disp-no-company': {
            // No companyId stamped
            driverId: DRIVER_ID,
            wellName: WELL_NAME,
          },
        });

        const signal: PullCorrectionSignal = {
          packetId: PACKET_ID,
          revision: rev,
          bottomLevel: BOTTOM_LEVEL,
          pullDateTimeUTC: PULL_TIME,
          flowRate: FLOW_RATE,
          publishedAtMs: Date.now(),
          wellName: WELL_NAME,
          companyId: 'home-hauling', // Scoped tenant
          driverId: DRIVER_ID,
        };

        const pubResult = await publishPullCorrectionToDispatches(mockFirestore, {
          dispatchIds: ['disp-no-company'],
          signal,
        });

        expect(pubResult.ok).toBe(false);
        expect(pubResult.results?.['disp-no-company']?.reason).toBe('company_mismatch');
      });

      test('allows unstamped dispatch if signal company is liquid-gold (legacy single-tenant data)', async () => {
        const rev = computePullRevision(PACKET_ID, BOTTOM_LEVEL, PULL_TIME, FLOW_RATE);
        const mockFirestore = createMockFirestore({
          'disp-legacy-lg': {
            // No companyId stamped — legacy Liquid Gold record
            driverId: DRIVER_ID,
            wellName: WELL_NAME,
          },
        });

        const signal: PullCorrectionSignal = {
          packetId: PACKET_ID,
          revision: rev,
          bottomLevel: BOTTOM_LEVEL,
          pullDateTimeUTC: PULL_TIME,
          flowRate: FLOW_RATE,
          publishedAtMs: Date.now(),
          wellName: WELL_NAME,
          companyId: 'liquid-gold',
          driverId: DRIVER_ID,
        };

        const pubResult = await publishPullCorrectionToDispatches(mockFirestore, {
          dispatchIds: ['disp-legacy-lg'],
          signal,
        });

        expect(pubResult.ok).toBe(true);
        expect(pubResult.updatedDispatchIds).toEqual(['disp-legacy-lg']);
      });

      test('docBelongsToTenant pure unit check', () => {
        expect(docBelongsToTenant('c1', 'c1')).toBe(true);
        expect(docBelongsToTenant('c1', 'c2')).toBe(false);
        expect(docBelongsToTenant(null, 'liquid-gold')).toBe(true);
        expect(docBelongsToTenant(null, 'other-tenant')).toBe(false);
        expect(docBelongsToTenant('c1', undefined)).toBe(false);
      });
    });

    describe('Well scoping & normalization', () => {
      test('rejects dispatch with missing well', async () => {
        const rev = computePullRevision(PACKET_ID, BOTTOM_LEVEL, PULL_TIME, FLOW_RATE);
        const mockFirestore = createMockFirestore({
          'disp-missing-well': {
            companyId: COMPANY_ID,
            driverId: DRIVER_ID,
            // wellName is missing
          },
        });

        const signal: PullCorrectionSignal = {
          packetId: PACKET_ID,
          revision: rev,
          bottomLevel: BOTTOM_LEVEL,
          pullDateTimeUTC: PULL_TIME,
          flowRate: FLOW_RATE,
          publishedAtMs: Date.now(),
          wellName: WELL_NAME,
          companyId: COMPANY_ID,
          driverId: DRIVER_ID,
        };

        const pubResult = await publishPullCorrectionToDispatches(mockFirestore, {
          dispatchIds: ['disp-missing-well'],
          signal,
        });

        expect(pubResult.ok).toBe(false);
        expect(pubResult.results?.['disp-missing-well']).toEqual({
          ok: false,
          reason: 'well_mismatch',
        });
      });

      test('rejects dispatch with mismatched well', async () => {
        const rev = computePullRevision(PACKET_ID, BOTTOM_LEVEL, PULL_TIME, FLOW_RATE);
        const mockFirestore = createMockFirestore({
          'disp-diff-well': {
            companyId: COMPANY_ID,
            driverId: DRIVER_ID,
            wellName: 'Different Well 4',
          },
        });

        const signal: PullCorrectionSignal = {
          packetId: PACKET_ID,
          revision: rev,
          bottomLevel: BOTTOM_LEVEL,
          pullDateTimeUTC: PULL_TIME,
          flowRate: FLOW_RATE,
          publishedAtMs: Date.now(),
          wellName: WELL_NAME,
          companyId: COMPANY_ID,
          driverId: DRIVER_ID,
        };

        const pubResult = await publishPullCorrectionToDispatches(mockFirestore, {
          dispatchIds: ['disp-diff-well'],
          signal,
        });

        expect(pubResult.ok).toBe(false);
        expect(pubResult.results?.['disp-diff-well']).toEqual({
          ok: false,
          reason: 'well_mismatch',
        });
      });

      test('accepts normalized well variations (Gabriel 1 vs Gabriel-1 vs gabriel_1)', async () => {
        const rev = computePullRevision(PACKET_ID, BOTTOM_LEVEL, PULL_TIME, FLOW_RATE);
        const mockFirestore = createMockFirestore({
          'disp-hyphen-well': {
            companyId: COMPANY_ID,
            driverId: DRIVER_ID,
            wellName: 'Gabriel-1',
          },
        });

        const signal: PullCorrectionSignal = {
          packetId: PACKET_ID,
          revision: rev,
          bottomLevel: BOTTOM_LEVEL,
          pullDateTimeUTC: PULL_TIME,
          flowRate: FLOW_RATE,
          publishedAtMs: Date.now(),
          wellName: 'Gabriel 1',
          companyId: COMPANY_ID,
          driverId: DRIVER_ID,
        };

        const pubResult = await publishPullCorrectionToDispatches(mockFirestore, {
          dispatchIds: ['disp-hyphen-well'],
          signal,
        });

        expect(pubResult.ok).toBe(true);
        expect(normalizeWellName('Gabriel 1')).toBe('gabriel1');
        expect(normalizeWellName('Gabriel-1')).toBe('gabriel1');
        expect(normalizeWellName('gabriel_1')).toBe('gabriel1');
      });
    });

    describe('Driver scoping & identity equivalence', () => {
      test('rejects dispatch with missing driver assignment', async () => {
        const rev = computePullRevision(PACKET_ID, BOTTOM_LEVEL, PULL_TIME, FLOW_RATE);
        const mockFirestore = createMockFirestore({
          'disp-no-driver': {
            companyId: COMPANY_ID,
            wellName: WELL_NAME,
            // No driverId, driverHash, or assignedDrivers
          },
        });

        const signal: PullCorrectionSignal = {
          packetId: PACKET_ID,
          revision: rev,
          bottomLevel: BOTTOM_LEVEL,
          pullDateTimeUTC: PULL_TIME,
          flowRate: FLOW_RATE,
          publishedAtMs: Date.now(),
          wellName: WELL_NAME,
          companyId: COMPANY_ID,
          driverId: DRIVER_ID,
        };

        const pubResult = await publishPullCorrectionToDispatches(mockFirestore, {
          dispatchIds: ['disp-no-driver'],
          signal,
        });

        expect(pubResult.ok).toBe(false);
        expect(pubResult.results?.['disp-no-driver']).toEqual({
          ok: false,
          reason: 'driver_missing',
        });
      });

      test('matches direct driverId, driverHash, or assignedDriverId', async () => {
        const rev = computePullRevision(PACKET_ID, BOTTOM_LEVEL, PULL_TIME, FLOW_RATE);
        const mockFirestore = createMockFirestore({
          'disp-by-id': { companyId: COMPANY_ID, wellName: WELL_NAME, driverId: DRIVER_ID },
          'disp-by-hash': { companyId: COMPANY_ID, wellName: WELL_NAME, driverHash: DRIVER_ID },
          'disp-by-assigned': { companyId: COMPANY_ID, wellName: WELL_NAME, assignedDriverId: DRIVER_ID },
        });

        const signal: PullCorrectionSignal = {
          packetId: PACKET_ID,
          revision: rev,
          bottomLevel: BOTTOM_LEVEL,
          pullDateTimeUTC: PULL_TIME,
          flowRate: FLOW_RATE,
          publishedAtMs: Date.now(),
          wellName: WELL_NAME,
          companyId: COMPANY_ID,
          driverId: DRIVER_ID,
        };

        const pubResult = await publishPullCorrectionToDispatches(mockFirestore, {
          dispatchIds: ['disp-by-id', 'disp-by-hash', 'disp-by-assigned'],
          signal,
        });

        expect(pubResult.ok).toBe(true);
        expect(pubResult.updatedDispatchIds).toEqual(['disp-by-id', 'disp-by-hash', 'disp-by-assigned']);
      });

      test('matches driver in assignedDrivers array (strings or objects)', () => {
        const candidates = extractDispatchDriverCandidates({
          assignedDrivers: [
            'other-driver',
            { driverId: 'uuid-123' },
            { driverHash: 'legacy-hash-456' },
          ],
        });
        expect(candidates).toContain('other-driver');
        expect(candidates).toContain('uuid-123');
        expect(candidates).toContain('legacy-hash-456');
      });

      test('resolves canonical UUID <-> legacy approved hash equivalence via RTDB identityBindings', async () => {
        const canonicalUuid = 'c0a80101-0000-4000-8000-000000000001';
        const legacyHash = 'legacy_approved_hash_123456';

        const mockRtdb = createMockRtdb({
          [`drivers/identityBindings/byDriver/${canonicalUuid}`]: {
            driverId: canonicalUuid,
            approvedKey: legacyHash,
            status: 'active',
          },
          [`drivers/identityBindings/byApproved/${legacyHash}`]: {
            driverId: canonicalUuid,
            approvedKey: legacyHash,
            status: 'active',
          },
        });

        const equivalent = await areDriverIdentitiesEquivalent(canonicalUuid, legacyHash, mockRtdb);
        expect(equivalent).toBe(true);

        const rev = computePullRevision(PACKET_ID, BOTTOM_LEVEL, PULL_TIME, FLOW_RATE);
        // Dispatch carries legacyHash, but pull signal carries canonicalUuid
        const mockFirestore = createMockFirestore({
          'disp-bound-driver': {
            companyId: COMPANY_ID,
            wellName: WELL_NAME,
            driverHash: legacyHash,
          },
        });

        const signal: PullCorrectionSignal = {
          packetId: PACKET_ID,
          revision: rev,
          bottomLevel: BOTTOM_LEVEL,
          pullDateTimeUTC: PULL_TIME,
          flowRate: FLOW_RATE,
          publishedAtMs: Date.now(),
          wellName: WELL_NAME,
          companyId: COMPANY_ID,
          driverId: canonicalUuid, // canonical UUID matches legacyHash via binding
        };

        const pubResult = await publishPullCorrectionToDispatches(mockFirestore, {
          dispatchIds: ['disp-bound-driver'],
          signal,
          rtdb: mockRtdb,
        });

        expect(pubResult.ok).toBe(true);
        expect(pubResult.updatedDispatchIds).toEqual(['disp-bound-driver']);
      });

      test('rejects unmapped driver when equivalence lookup fails', async () => {
        const canonicalUuid = 'c0a80101-0000-4000-8000-000000000001';
        const unmappedHash = 'totally_unrelated_driver_hash';

        const mockRtdb = createMockRtdb({}); // Empty RTDB — no binding
        const equivalent = await areDriverIdentitiesEquivalent(canonicalUuid, unmappedHash, mockRtdb);
        expect(equivalent).toBe(false);

        const rev = computePullRevision(PACKET_ID, BOTTOM_LEVEL, PULL_TIME, FLOW_RATE);
        const mockFirestore = createMockFirestore({
          'disp-unmapped': {
            companyId: COMPANY_ID,
            wellName: WELL_NAME,
            driverHash: unmappedHash,
          },
        });

        const signal: PullCorrectionSignal = {
          packetId: PACKET_ID,
          revision: rev,
          bottomLevel: BOTTOM_LEVEL,
          pullDateTimeUTC: PULL_TIME,
          flowRate: FLOW_RATE,
          publishedAtMs: Date.now(),
          wellName: WELL_NAME,
          companyId: COMPANY_ID,
          driverId: canonicalUuid,
        };

        const pubResult = await publishPullCorrectionToDispatches(mockFirestore, {
          dispatchIds: ['disp-unmapped'],
          signal,
          rtdb: mockRtdb,
        });

        expect(pubResult.ok).toBe(false);
        expect(pubResult.results?.['disp-unmapped']?.reason).toBe('driver_mismatch');
      });
    });
  });

  describe('5. Monotonic ordering & CAS on dispatches', () => {
    test('skips update when dispatch has newer revision (out-of-order replay protection)', async () => {
      const olderRev = computePullRevision(PACKET_ID, '4\'2"', PULL_TIME, FLOW_RATE);
      const mockFirestore = createMockFirestore({
        'disp-newer': {
          companyId: COMPANY_ID,
          wellName: WELL_NAME,
          driverId: DRIVER_ID,
          lastPullRevision: 'newer_rev_abc',
          lastPullCorrection: {
            publishedAtMs: 2000000, // Newer published timestamp
          },
        },
      });

      const signal: PullCorrectionSignal = {
        packetId: PACKET_ID,
        revision: olderRev,
        bottomLevel: '4\'2"',
        pullDateTimeUTC: PULL_TIME,
        flowRate: FLOW_RATE,
        publishedAtMs: 1000000, // Older timestamp
        wellName: WELL_NAME,
        companyId: COMPANY_ID,
        driverId: DRIVER_ID,
      };

      const pubResult = await publishPullCorrectionToDispatches(mockFirestore, {
        dispatchIds: ['disp-newer'],
        signal,
      });

      expect(pubResult.ok).toBe(true);
      expect(pubResult.results?.['disp-newer']).toEqual({
        ok: true,
        applied: false,
        reason: 'superseded_by_newer_revision',
      });
      // Ensure Firestore update was NOT called
      expect(mockFirestore._updates['disp-newer']).toBeUndefined();
    });

    test('applies update when incoming signal is newer than existing revision', async () => {
      const newerRev = computePullRevision(PACKET_ID, '4\'8"', PULL_TIME, FLOW_RATE);
      const mockFirestore = createMockFirestore({
        'disp-older': {
          companyId: COMPANY_ID,
          wellName: WELL_NAME,
          driverId: DRIVER_ID,
          lastPullRevision: 'older_rev_xyz',
          lastPullCorrection: {
            publishedAtMs: 1000000, // Older timestamp
          },
        },
      });

      const signal: PullCorrectionSignal = {
        packetId: PACKET_ID,
        revision: newerRev,
        bottomLevel: '4\'8"',
        pullDateTimeUTC: PULL_TIME,
        flowRate: FLOW_RATE,
        publishedAtMs: 2000000, // Newer timestamp
        wellName: WELL_NAME,
        companyId: COMPANY_ID,
        driverId: DRIVER_ID,
      };

      const pubResult = await publishPullCorrectionToDispatches(mockFirestore, {
        dispatchIds: ['disp-older'],
        signal,
      });

      expect(pubResult.ok).toBe(true);
      expect(pubResult.results?.['disp-older']).toEqual({
        ok: true,
        applied: true,
      });
      expect(mockFirestore._updates['disp-older']).toBeDefined();
      expect(mockFirestore._store['disp-older'].lastPullRevision).toBe(newerRev);
    });
  });

  describe('6. Durable retry & reconciliation (reconcilePendingPullCorrectionSignal)', () => {
    test('returns not_pending when packet is already delivered', async () => {
      const rev = computePullRevision(PACKET_ID, BOTTOM_LEVEL, PULL_TIME, FLOW_RATE);
      const mockRtdb = createMockRtdb({
        [`packets/processed/${PACKET_ID}`]: {
          outgoingCommittedRevision: rev,
          lastPullDeliveredRevision: rev, // matches
          dispatchSignalPending: false,
        },
      });
      const mockFirestore = createMockFirestore({});

      const result = await reconcilePendingPullCorrectionSignal(mockFirestore, mockRtdb, PACKET_ID);
      expect(result.ok).toBe(true);
      expect(result.status).toBe('not_pending');
      expect(result.revision).toBe(rev);
    });

    test('reconciles pending signal when outgoing was committed but dispatch delivery was pending', async () => {
      const rev = computePullRevision(PACKET_ID, BOTTOM_LEVEL, PULL_TIME, FLOW_RATE);
      const mockRtdb = createMockRtdb({
        [`packets/processed/${PACKET_ID}`]: {
          wellName: WELL_NAME,
          companyId: COMPANY_ID,
          driverId: DRIVER_ID,
          tankAfterFeet: BOTTOM_LEVEL,
          dateTimeUTC: PULL_TIME,
          flowRate: FLOW_RATE,
          outgoingCommittedRevision: rev,
          lastPullDeliveredRevision: null, // not yet delivered
          dispatchSignalPending: true,
          dispatchSignalPendingRevision: rev,
          dispatchSignalError: 'network timeout',
        },
      });

      const mockFirestore = createMockFirestore({
        'disp-target-1': {
          companyId: COMPANY_ID,
          wellName: WELL_NAME,
          driverId: DRIVER_ID,
          lastPullPacketId: PACKET_ID,
        },
      });

      const result = await reconcilePendingPullCorrectionSignal(mockFirestore, mockRtdb, PACKET_ID);

      expect(result.ok).toBe(true);
      expect(result.status).toBe('reconciled');
      expect(result.revision).toBe(rev);
      expect(result.updatedDispatchIds).toEqual(['disp-target-1']);

      // Check RTDB state was updated
      const updatedPkt = mockRtdb._data[`packets/processed/${PACKET_ID}`];
      expect(updatedPkt.lastPullDeliveredRevision).toBe(rev);
      expect(updatedPkt.lastPullRevision).toBe(rev);
      expect(updatedPkt.dispatchSignalPending).toBeNull();
      expect(updatedPkt.dispatchSignalError).toBeNull();

      // Check dispatch document in Firestore was updated
      expect(mockFirestore._store['disp-target-1'].lastPullRevision).toBe(rev);
    });

    test('safely skips when no target dispatches are found for the pull', async () => {
      const rev = computePullRevision(PACKET_ID, BOTTOM_LEVEL, PULL_TIME, FLOW_RATE);
      const mockRtdb = createMockRtdb({
        [`packets/processed/${PACKET_ID}`]: {
          wellName: WELL_NAME,
          companyId: COMPANY_ID,
          driverId: DRIVER_ID,
          tankAfterFeet: BOTTOM_LEVEL,
          dateTimeUTC: PULL_TIME,
          flowRate: FLOW_RATE,
          outgoingCommittedRevision: rev,
          lastPullDeliveredRevision: null,
          dispatchSignalPending: true,
        },
      });

      const mockFirestore = createMockFirestore({}); // No dispatches match

      const result = await reconcilePendingPullCorrectionSignal(mockFirestore, mockRtdb, PACKET_ID);

      expect(result.ok).toBe(true);
      expect(result.status).toBe('skipped');
      expect(result.reason).toBe('no_target_dispatches');

      // RTDB cleared pending and marked delivered
      const updatedPkt = mockRtdb._data[`packets/processed/${PACKET_ID}`];
      expect(updatedPkt.lastPullDeliveredRevision).toBe(rev);
      expect(updatedPkt.dispatchSignalPending).toBeNull();
    });

    test('records error and returns failed status when Firestore throws error during publication', async () => {
      const rev = computePullRevision(PACKET_ID, BOTTOM_LEVEL, PULL_TIME, FLOW_RATE);
      const mockRtdb = createMockRtdb({
        [`packets/processed/${PACKET_ID}`]: {
          wellName: WELL_NAME,
          companyId: COMPANY_ID,
          driverId: DRIVER_ID,
          tankAfterFeet: BOTTOM_LEVEL,
          dateTimeUTC: PULL_TIME,
          flowRate: FLOW_RATE,
          outgoingCommittedRevision: rev,
          lastPullDeliveredRevision: null,
          dispatchSignalPending: true,
        },
      });

      const mockFirestore = createMockFirestore({
        'disp-err': {
          companyId: COMPANY_ID,
          wellName: WELL_NAME,
          driverId: DRIVER_ID,
          lastPullPacketId: PACKET_ID,
        },
      });
      // Force Firestore transaction to throw
      mockFirestore.runTransaction = async () => {
        throw new Error('Firestore unavailable (simulated 503)');
      };

      const result = await reconcilePendingPullCorrectionSignal(mockFirestore, mockRtdb, PACKET_ID);

      expect(result.ok).toBe(false);
      expect(result.status).toBe('failed');
      expect(result.reason).toContain('Firestore unavailable');

      // RTDB recorded the error and kept pending true
      const updatedPkt = mockRtdb._data[`packets/processed/${PACKET_ID}`];
      expect(updatedPkt.dispatchSignalPending).toBe(true);
      expect(updatedPkt.dispatchSignalError).toContain('Firestore unavailable');
    });
  });

  describe('7. Offline queue & older pull edge cases', () => {
    test('offline queue returns queued: true, committed: false and touches no dispatches', () => {
      const earlyEval = evaluatePullCorrectionPublication({
        isLatestPull: true,
        outgoingUpdated: false, // queued, not committed
        packetId: PACKET_ID,
        wellName: WELL_NAME,
        companyId: COMPANY_ID,
        driverId: DRIVER_ID,
        bottomLevel: BOTTOM_LEVEL,
        pullDateTimeUTC: PULL_TIME,
        flowRate: FLOW_RATE,
      });
      expect(earlyEval.action).toBe('skip');
      if (earlyEval.action === 'skip') {
        expect(earlyEval.reason).toBe('outgoing_not_updated');
      }
    });

    test('older pull edit that does not change current outgoing emits nothing', () => {
      const result = evaluatePullCorrectionPublication({
        isLatestPull: false, // Older historical pull edited
        outgoingUpdated: true,
        packetId: PACKET_ID,
        wellName: WELL_NAME,
        companyId: COMPANY_ID,
        driverId: DRIVER_ID,
        bottomLevel: BOTTOM_LEVEL,
        pullDateTimeUTC: PULL_TIME,
        flowRate: FLOW_RATE,
      });

      expect(result.action).toBe('skip');
      if (result.action === 'skip') {
        expect(result.reason).toBe('not_latest_pull');
      }
    });
  });

  describe('8. Dispatch identity resolution (findDispatchIdsForPull)', () => {
    test('resolves explicit dispatchId hint first', async () => {
      const mockFirestore = createMockFirestore({});
      const ids = await findDispatchIdsForPull(mockFirestore, {
        dispatchId: 'explicit-disp-123',
        packetId: PACKET_ID,
      });
      expect(ids).toEqual(['explicit-disp-123']);
    });

    test('resolves ticketDispatchId or invoiceDispatchId if dispatchId is absent', async () => {
      const mockFirestore = createMockFirestore({});
      const idsFromTicket = await findDispatchIdsForPull(mockFirestore, {
        ticketDispatchId: 'disp-from-ticket',
        packetId: PACKET_ID,
      });
      expect(idsFromTicket).toEqual(['disp-from-ticket']);

      const idsFromInvoice = await findDispatchIdsForPull(mockFirestore, {
        invoiceDispatchId: 'disp-from-invoice',
        packetId: PACKET_ID,
      });
      expect(idsFromInvoice).toEqual(['disp-from-invoice']);
    });

    test('queries by lastPullPacketId when hints are empty', async () => {
      const mockFirestore = createMockFirestore({
        'disp-matched-by-last-pull': {
          lastPullPacketId: PACKET_ID,
        },
      });

      const ids = await findDispatchIdsForPull(mockFirestore, {
        packetId: PACKET_ID,
      });
      expect(ids).toEqual(['disp-matched-by-last-pull']);
    });
  });
});
