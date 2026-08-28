import { assembleCanonicalPatch, receiptPathFor } from '../canonicalPatch';
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
      'wells/Gabriel 5/status': { isDown: false },
      'performance/Gabriel_5/rows/20260826_193900': { d: '2026-08-26', a: 84, p: 52 },
      'performance/Gabriel_5/wellName': 'Gabriel 5',
      'performance/Gabriel_5/updated': '2026-08-27T13:00:00Z',
      'production/Gabriel_5/2026-08-26': { afr: 139 },
      'well_config/Gabriel 5/avgFlowRate': '3:27:47',
      'well_config/Gabriel 5/avgFlowRateMinutes': 207.79,
      'wells/Gabriel 5/status/chronoRevision': 6,
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

  test('minimal patch still carries the receipt', () => {
    const patch = assembleCanonicalPatch({ processedUpdates: { 'packets/processed/x/anomaly': true }, receipt, receiptPath: 'r/op1' });
    expect(Object.keys(patch).sort()).toEqual(['packets/processed/x/anomaly', 'r/op1']);
  });
});
