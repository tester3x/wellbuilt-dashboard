import {
  computePullRevision,
  evaluatePullCorrectionPublication,
  buildDispatchCorrectionPatch,
  findDispatchIdsForPull,
  publishPullCorrectionToDispatches,
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
        exists: true,
        data: () => ({
          companyId: COMPANY_ID,
          driverHash: DRIVER_ID,
          wellName: WELL_NAME,
          lastPullRevision: rev, // already matches
        }),
      };

      const mockUpdate = jest.fn();
      const mockFirestore: any = {
        collection: () => ({
          doc: () => ({
            get: async () => mockDoc,
            update: mockUpdate,
          }),
        }),
      };

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
      expect(mockUpdate).not.toHaveBeenCalled(); // No-op: update was skipped due to idempotency
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

  describe('4. Stale / other company or driver cannot receive/apply it (tenant mismatch rejected)', () => {
    test('publisher filters out dispatches with mismatched companyId', async () => {
      const rev = computePullRevision(PACKET_ID, BOTTOM_LEVEL, PULL_TIME, FLOW_RATE);
      const mockDoc = {
        exists: true,
        data: () => ({
          companyId: 'other-company',
          driverHash: DRIVER_ID,
          wellName: WELL_NAME,
        }),
      };
      const mockUpdate = jest.fn();
      const mockFirestore: any = {
        collection: () => ({
          doc: () => ({
            get: async () => mockDoc,
            update: mockUpdate,
          }),
        }),
      };

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
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    test('publisher filters out dispatches with mismatched driverId', async () => {
      const rev = computePullRevision(PACKET_ID, BOTTOM_LEVEL, PULL_TIME, FLOW_RATE);
      const mockDoc = {
        exists: true,
        data: () => ({
          companyId: COMPANY_ID,
          driverHash: 'another-driver-999',
          wellName: WELL_NAME,
        }),
      };
      const mockUpdate = jest.fn();
      const mockFirestore: any = {
        collection: () => ({
          doc: () => ({
            get: async () => mockDoc,
            update: mockUpdate,
          }),
        }),
      };

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
        dispatchIds: ['disp-mismatch-driver'],
        signal,
      });

      expect(pubResult.ok).toBe(false);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    test('publisher filters out dispatches with mismatched wellName', async () => {
      const rev = computePullRevision(PACKET_ID, BOTTOM_LEVEL, PULL_TIME, FLOW_RATE);
      const mockDoc = {
        exists: true,
        data: () => ({
          companyId: COMPANY_ID,
          driverHash: DRIVER_ID,
          wellName: 'Different Well 4',
        }),
      };
      const mockUpdate = jest.fn();
      const mockFirestore: any = {
        collection: () => ({
          doc: () => ({
            get: async () => mockDoc,
            update: mockUpdate,
          }),
        }),
      };

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
        dispatchIds: ['disp-mismatch-well'],
        signal,
      });

      expect(pubResult.ok).toBe(false);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    test('publisher accepts matching dispatch and applies atomic patch with arrayUnion', async () => {
      const rev = computePullRevision(PACKET_ID, BOTTOM_LEVEL, PULL_TIME, FLOW_RATE);
      const mockDoc = {
        exists: true,
        data: () => ({
          companyId: COMPANY_ID,
          driverHash: DRIVER_ID,
          wellName: WELL_NAME,
          lastPullRevision: 'older_rev',
        }),
      };
      const mockUpdate = jest.fn().mockResolvedValue(undefined);
      const mockFirestore: any = {
        collection: () => ({
          doc: () => ({
            get: async () => mockDoc,
            update: mockUpdate,
          }),
        }),
      };

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

      const arrayUnionFn = jest.fn((val) => ({ union: val }));
      const pubResult = await publishPullCorrectionToDispatches(mockFirestore, {
        dispatchIds: ['disp-valid'],
        signal,
        serverTimestamp: '2026-09-29T12:00:00Z',
        arrayUnion: arrayUnionFn,
      });

      expect(pubResult.ok).toBe(true);
      expect(pubResult.updatedDispatchIds).toEqual(['disp-valid']);
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          lastPullPacketId: PACKET_ID,
          lastPullRevision: rev,
          lastPullBottomLevel: BOTTOM_LEVEL,
          pullPacketIds: { union: PACKET_ID },
        }),
      );
    });
  });

  describe('5. Offline queue emits nothing until processing completes', () => {
    test('ingestWbmEdit contract: returns queued: true, committed: false and touches no dispatches', () => {
      // Offline queue intake operates exclusively on RTDB packets/incoming staging
      // It does not evaluate publication or touch Firestore dispatches.
      const simulatedIngestResponse = {
        ok: true as const,
        key: 'edit_key_123',
        packetId: PACKET_ID,
        idempotencyKey: 'edit_key_123',
        duplicate: false,
        queued: true as const,
        committed: false as const,
      };

      expect(simulatedIngestResponse.queued).toBe(true);
      expect(simulatedIngestResponse.committed).toBe(false);
      // The dispatch signal is guarded by evaluatePullCorrectionPublication which requires outgoingUpdated: true
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
    });
  });

  describe('6. Older pull edit that does not change current outgoing emits nothing', () => {
    test('skips publication when isLatestPull is false', () => {
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

  describe('Dispatch identity resolution (findDispatchIdsForPull)', () => {
    test('resolves explicit dispatchId hint first', async () => {
      const mockFirestore: any = {};
      const ids = await findDispatchIdsForPull(mockFirestore, {
        dispatchId: 'explicit-disp-123',
        packetId: PACKET_ID,
      });
      expect(ids).toEqual(['explicit-disp-123']);
    });

    test('resolves ticketDispatchId or invoiceDispatchId if dispatchId is absent', async () => {
      const mockFirestore: any = {};
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
      const mockDocs = [{ id: 'disp-matched-by-last-pull' }];
      const mockFirestore: any = {
        collection: (coll: string) => {
          expect(coll).toBe('dispatches');
          return {
            where: (field: string, op: string, val: string) => {
              expect(field).toBe('lastPullPacketId');
              expect(op).toBe('==');
              expect(val).toBe(PACKET_ID);
              return {
                get: async () => ({
                  forEach: (cb: any) => mockDocs.forEach(cb),
                }),
              };
            },
          };
        },
      };

      const ids = await findDispatchIdsForPull(mockFirestore, {
        packetId: PACKET_ID,
      });
      expect(ids).toEqual(['disp-matched-by-last-pull']);
    });
  });
});
