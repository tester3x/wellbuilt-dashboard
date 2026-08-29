import { assembleCanonicalPatch, receiptPathFor, CANONICAL_STATUS_KEYS } from '../canonicalPatch';
import type { CommitReceipt } from '../chronoCommitCoordinator';

const receipt: CommitReceipt = {
  operationId: 'op1', mutationType: 'backdated_create', wellName: 'Gabriel 5', fence: 6, revision: 6,
  affectedPacketIds: ['am', 'p101'], committedAtMs: 0, patchHash: 'h1',
};

describe('assembleCanonicalPatch — one atomic patch incl. receipt', () => {
  test('composes every canonical location into a single update map', () => {
    const patch = assembleCanonicalPatch({
      processedUpdates: {
        'packets/processed/am/recoveryInches': 18,
        'packets/processed/p101/recoveryInches': 110,
      },
      outgoing: { deleteResponseIds: ['response_old_Gabriel5'], responseId: 'response_new_Gabriel5', response: { wellName: 'Gabriel 5', status: 'success' } },
      wellStatus: { wellName: 'Gabriel 5', status: { isDown: false } },
      performance: { wellKey: 'Gabriel_5', perfTimestamp: '20260826_193900', row: { d: '2026-08-26', a: 84, p: 52 }, wellName: 'Gabriel 5', updatedIso: '2026-08-27T13:00:00Z' },
      production: [{ wellKey: 'Gabriel_5', date: '2026-08-26', value: { afr: 139 } }],
      afr: { wellName: 'Gabriel 5', avgFlowRate: '3:27:47', avgFlowRateMinutes: 207.79 },
      fence: { wellName: 'Gabriel 5', revision: 6 },
      receipt, receiptPath: receiptPathFor('Gabriel 5', 'op1'),
    });

    expect(patch).toEqual({
      'packets/processed/am/recoveryInches': 18,
      'packets/processed/p101/recoveryInches': 110,
      'packets/outgoing/response_old_Gabriel5': null,           // prior response removed
      'packets/outgoing/response_new_Gabriel5': { wellName: 'Gabriel 5', status: 'success' },
      'wells/Gabriel 5/status/isDown': false,                   // status written as child keys, not a full-node set
      // This minimal status supplied only isDown → every OTHER owned key is nulled
      // (explicit replacement: obsolete canonical children cannot linger).
      'wells/Gabriel 5/status/wellName': null,
      'wells/Gabriel 5/status/config': null,
      'wells/Gabriel 5/status/current': null,
      'wells/Gabriel 5/status/lastPull': null,
      'wells/Gabriel 5/status/calculated': null,
      'wells/Gabriel 5/status/updatedAt': null,
      'performance/Gabriel_5/rows/20260826_193900': { d: '2026-08-26', a: 84, p: 52 },
      'performance/Gabriel_5/wellName': 'Gabriel 5',
      'performance/Gabriel_5/updated': '2026-08-27T13:00:00Z',
      'production/Gabriel_5/2026-08-26': { afr: 139 },
      'well_config/Gabriel 5/avgFlowRate': '3:27:47',
      'well_config/Gabriel 5/avgFlowRateMinutes': 207.79,
      'wells/Gabriel 5/status/chronoRevision': 6,
      'packets/incoming_revision_v2': { v: 2, token: 'op1', at: 0 }, // v2 refresh signal in the SAME patch (Phase 2)
      'wells/Gabriel 5/chronoReceipts/op1': receipt,            // receipt in the SAME patch
    });
  });

  test('edit crossing dates: old production date removed (null), new date added', () => {
    const patch = assembleCanonicalPatch({
      processedUpdates: {},
      production: [
        { wellKey: 'W_1', date: '2026-08-25', value: null },      // vacated date removed
        { wellKey: 'W_1', date: '2026-08-27', value: { afr: 100 } }, // new date added
      ],
      receipt, receiptPath: receiptPathFor('W 1', 'op2'),
    });
    expect(patch['production/W_1/2026-08-25']).toBeNull();
    expect(patch['production/W_1/2026-08-27']).toEqual({ afr: 100 });
    expect(patch['wells/W 1/chronoReceipts/op2']).toBe(receipt);
  });

  test('assembled patch has NO overlapping locations (real RTDB update() would reject them)', () => {
    // status full-node + status/chronoRevision child was the trap; prove the
    // whole composed patch is free of ancestor/descendant key pairs.
    const patch = assembleCanonicalPatch({
      processedUpdates: { 'packets/processed/am/recoveryInches': 18 },
      outgoing: { deleteResponseIds: ['r_old'], responseId: 'r_new', response: { ok: true } },
      wellStatus: { wellName: 'Gabriel 5', status: { isDown: false, current: { level: 60 }, lastPull: { p: 1 }, chronoRevision: 999 } },
      performance: { wellKey: 'Gabriel_5', perfTimestamp: 't', row: { d: 'x', a: 1, p: 2 }, wellName: 'Gabriel 5', updatedIso: 'iso' },
      production: [{ wellKey: 'Gabriel_5', date: '2026-08-26', value: { afr: 1 } }],
      afr: { wellName: 'Gabriel 5', avgFlowRate: '1:00', avgFlowRateMinutes: 60 },
      fence: { wellName: 'Gabriel 5', revision: 6 },
      receipt, receiptPath: receiptPathFor('Gabriel 5', 'op1'),
    });
    const keys = Object.keys(patch);
    // A status object carrying chronoRevision must NOT leak it as a child write
    // that collides with the fence's status/chronoRevision.
    expect(keys.filter((k) => k === 'wells/Gabriel 5/status/chronoRevision')).toHaveLength(1);
    for (const a of keys) for (const b of keys) {
      if (a === b) continue;
      expect(a.startsWith(b + '/')).toBe(false); // a is never a descendant of b
    }
  });

  describe('status replacement semantics (Gap 2)', () => {
    const fullStatus = {
      wellName: 'Gabriel 5', config: { tanks: 1 }, current: { level: 60 }, lastPull: { p: 1 },
      calculated: { flowRate: '1:00' }, isDown: false, updatedAt: 'iso',
    };
    const build = (status: Record<string, unknown>) => assembleCanonicalPatch({
      processedUpdates: {}, wellStatus: { wellName: 'Gabriel 5', status },
      fence: { wellName: 'Gabriel 5', revision: 6 },
      receipt, receiptPath: receiptPathFor('Gabriel 5', 'op1'),
    });

    test('a complete status writes every owned key and nulls none', () => {
      const patch = build(fullStatus);
      for (const k of CANONICAL_STATUS_KEYS) {
        expect(patch[`wells/Gabriel 5/status/${k}`]).not.toBeNull();
        expect(`wells/Gabriel 5/status/${k}` in patch).toBe(true);
      }
    });

    test('a removed canonical status field is nulled (never left stale)', () => {
      const { calculated: _omit, ...withoutCalculated } = fullStatus;
      const patch = build(withoutCalculated);
      expect(patch['wells/Gabriel 5/status/calculated']).toBeNull(); // explicitly removed
      expect(patch['wells/Gabriel 5/status/current']).toEqual({ level: 60 }); // still present
    });

    test('chronoLock is NEVER written by a status commit (survives the business commit)', () => {
      // Even if a status object somehow carried chronoLock, it is not emitted.
      const patch = build({ ...fullStatus, chronoLock: { token: 'x' } } as Record<string, unknown>);
      expect('wells/Gabriel 5/status/chronoLock' in patch).toBe(false);
    });

    test('chronoRevision is written exactly once (by the fence, not the status object)', () => {
      const patch = build({ ...fullStatus, chronoRevision: 999 } as Record<string, unknown>);
      const revKeys = Object.keys(patch).filter((k) => k === 'wells/Gabriel 5/status/chronoRevision');
      expect(revKeys).toHaveLength(1);
      expect(patch['wells/Gabriel 5/status/chronoRevision']).toBe(6); // the fence value, not 999
    });

    test('unrelated status children are left untouched (only owned keys are managed)', () => {
      // The patch only ever addresses owned keys + chronoRevision; it never writes
      // (or nulls) an unrelated child like status/adminNote, so RTDB preserves it.
      const patch = build(fullStatus);
      const managed = new Set<string>([
        ...CANONICAL_STATUS_KEYS.map((k) => `wells/Gabriel 5/status/${k}`),
        'wells/Gabriel 5/status/chronoRevision',
      ]);
      for (const key of Object.keys(patch)) {
        if (key.startsWith('wells/Gabriel 5/status/')) expect(managed.has(key)).toBe(true);
      }
    });

    test('no ancestor/descendant overlap with a full status + fence (real RTDB accepts it)', () => {
      const patch = build(fullStatus);
      const keys = Object.keys(patch);
      for (const a of keys) for (const b of keys) {
        if (a === b) continue;
        expect(a.startsWith(b + '/')).toBe(false);
      }
    });
  });

  test('minimal patch still carries the receipt and the v2 refresh signal', () => {
    const patch = assembleCanonicalPatch({ processedUpdates: { 'packets/processed/x/anomaly': true }, receipt, receiptPath: 'r/op1' });
    expect(Object.keys(patch).sort()).toEqual(['packets/incoming_revision_v2', 'packets/processed/x/anomaly', 'r/op1']);
    expect(patch['packets/incoming_revision_v2']).toEqual({ v: 2, token: 'op1', at: 0 });
  });
});
