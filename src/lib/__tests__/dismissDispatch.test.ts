/**
 * dismissDispatch client core tests. Run:
 * node --test src/lib/__tests__/dismissDispatch.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DISMISS_DISPATCH_CALLABLE,
  buildDismissPayload,
  runDismissDispatch,
  type DismissDispatchResult,
} from '../dismissDispatchCore.ts';

test('buildDismissPayload formats the dispatchId correctly', () => {
  assert.deepEqual(buildDismissPayload('W0Om3TsAHAJ4bu8d8K49'), { dispatchId: 'W0Om3TsAHAJ4bu8d8K49' });
});

test('runDismissDispatch targets the dismissDispatch callable', async () => {
  let calledWith: unknown = null;
  const mockInvoker = async (payload: unknown) => {
    calledWith = payload;
    return { data: { ok: true, idempotent: false, dispatchIds: ['W0Om3TsAHAJ4bu8d8K49'] } as DismissDispatchResult };
  };

  const result = await runDismissDispatch(mockInvoker, 'W0Om3TsAHAJ4bu8d8K49');
  assert.equal(DISMISS_DISPATCH_CALLABLE, 'dismissDispatch');
  assert.deepEqual(calledWith, { dispatchId: 'W0Om3TsAHAJ4bu8d8K49' });
  assert.deepEqual(result, { ok: true, idempotent: false, dispatchIds: ['W0Om3TsAHAJ4bu8d8K49'] });
});

test('runDismissDispatch handles driver-created dispatch removal', async () => {
  const mockInvoker = async (payload: unknown) => {
    return { data: { ok: true, idempotent: false, dispatchIds: ['dplan_mu360zoo2paignsw_01'] } as DismissDispatchResult };
  };

  const result = await runDismissDispatch(mockInvoker, 'dplan_mu360zoo2paignsw_01');
  assert.equal(result.ok, true);
  assert.deepEqual(result.dispatchIds, ['dplan_mu360zoo2paignsw_01']);
});

test('runDismissDispatch reports idempotent response on repeated removal', async () => {
  const mockInvoker = async () => {
    return { data: { ok: true, idempotent: true, dispatchIds: ['W0Om3TsAHAJ4bu8d8K49'] } as DismissDispatchResult };
  };

  const result = await runDismissDispatch(mockInvoker, 'W0Om3TsAHAJ4bu8d8K49');
  assert.equal(result.ok, true);
  assert.equal(result.idempotent, true);
});

test('runDismissDispatch surfaces errors visibly (never a silent no-op)', async () => {
  const mockInvoker = async () => {
    throw new Error('FirebaseError: cross_company');
  };

  await assert.rejects(
    async () => {
      await runDismissDispatch(mockInvoker, 'cross-company-job');
    },
    { message: /cross_company/ },
  );
});
