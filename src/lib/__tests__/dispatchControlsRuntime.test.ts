/**
 * RUNTIME control tests for the Phase-2 priority mutation controls.
 *
 * Unlike the static control-contract suite, these tests EXECUTE the real
 * adapter cores (firebase-free) through a mock invoker and assert the complete
 * wire contract by observing what actually happens at runtime:
 *   exact deployed callable name → exact payload → success unwrap → error surface.
 *
 * No Firebase, no network, no production calls — the invoker is a mock. This is
 * the genuine "exercise the mutation with mocks" proof; the UI-state half
 * (capability gate, disabled-while-busy, modal-persist-on-failure) is asserted
 * structurally in controlContracts.test.ts. Neither is a WORKING claim on its
 * own — a live callable is production and a DOM runner is not installed here.
 *
 * Run: node --test --experimental-strip-types src/lib/__tests__/dispatchControlsRuntime.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DELETE_PULL_CALLABLE,
  buildDeletePayload,
  runDeletePull,
  describeDeleteError,
  type DeletePullResult,
} from '../pullDeleteCore.ts';
import {
  STAFF_WRITE_DISPATCH_CALLABLE,
  jsonSafe,
  runCreateDispatch,
  runUpdateDispatch,
  runCancelDispatch,
} from '../staffWriteDispatchCore.ts';
import {
  DISMISS_DISPATCH_CALLABLE,
  runDismissDispatch,
  type DismissDispatchResult,
} from '../dismissDispatchCore.ts';

/** A recording mock invoker. */
function mock<T>(data: T) {
  const calls: unknown[] = [];
  const invoke = async (payload: unknown): Promise<{ data: T }> => {
    calls.push(payload);
    return { data };
  };
  return { invoke, calls };
}

// ── Pull Delete → staffDeletePull ────────────────────────────────────────────

test('Pull Delete: targets staffDeletePull with {packetId, wellName} and unwraps result', async () => {
  assert.equal(DELETE_PULL_CALLABLE, 'staffDeletePull');
  assert.deepEqual(buildDeletePayload('pk_1', 'Gabriel 3'), { packetId: 'pk_1', wellName: 'Gabriel 3' });

  const result: DeletePullResult = { ok: true, packetId: 'pk_1', queued: true, idempotent: false, alreadyApplied: false };
  const m = mock(result);
  const out = await runDeletePull(m.invoke, 'pk_1', 'Gabriel 3');
  assert.deepEqual(m.calls, [{ packetId: 'pk_1', wellName: 'Gabriel 3' }]);
  assert.deepEqual(out, result);
});

test('Pull Delete: a rejected invoker propagates (handler surfaces via describeDeleteError)', async () => {
  const boom = async () => { throw Object.assign(new Error('well_mismatch: changed'), { code: 'failed-precondition' }); };
  await assert.rejects(() => runDeletePull(boom as never, 'pk_1', 'W'), /well_mismatch/);
  assert.match(describeDeleteError(new Error('well_mismatch: x')), /already changed elsewhere/i);
  assert.match(describeDeleteError({ code: 'permission-denied', message: 'x' }), /do not have permission/i);
  assert.match(describeDeleteError({ code: 'unavailable', message: 'x' }), /was not deleted/i);
  assert.match(describeDeleteError(new Error('weird')), /was not changed/i);
});

// ── Dispatch Create/Update/Cancel → staffWriteDispatch ───────────────────────

test('Dispatch Create: op=create, record is jsonSafe, returns dispatchId', async () => {
  assert.equal(STAFF_WRITE_DISPATCH_CALLABLE, 'staffWriteDispatch');
  const m = mock({ dispatchId: 'd_99' });
  const ts = { toMillis: () => 1_700_000_000_000 };
  const inputRecord: Record<string, unknown> = {
    wellName: 'W', assignedAt: ts, companyId: ts, scheduledFor: ts, notes: 'hi', skip: undefined,
  };
  const out = await runCreateDispatch(m.invoke, inputRecord);
  const payload = m.calls[0] as { op: string; dispatchId: string; packetRef: unknown; record: Record<string, unknown> };
  assert.equal(payload.op, 'create');
  assert.ok(typeof payload.dispatchId === 'string' && payload.dispatchId.length > 0, 'auto-mints dispatchId');
  assert.equal(inputRecord.dispatchId, payload.dispatchId, 'stamps stable dispatchId on caller record for idempotency');
  assert.deepEqual(payload.packetRef, { packageId: 'water-hauling', revision: 1 }, 'supplies packetRef');
  assert.equal(payload.record.wellName, 'W');
  // Server-authoritative fields are omitted ONLY when Timestamp-like (jsonSafe
  // drops them so the server stamps/derives them).
  assert.ok(!('assignedAt' in payload.record), 'assignedAt (Timestamp) is omitted for the server to stamp');
  assert.ok(!('companyId' in payload.record), 'companyId (Timestamp) is omitted for the server to derive');
  assert.ok(!('skip' in payload.record), 'undefined fields are dropped');
  assert.deepEqual(payload.record.scheduledFor, { seconds: 1_700_000_000, nanoseconds: 0 }, 'Timestamp serialized, not dropped');
  assert.deepEqual(out, { dispatchId: 'd_99' });

  // Idempotent retry reuses the exact same dispatchId
  await runCreateDispatch(m.invoke, inputRecord);
  const retryPayload = m.calls[1] as { op: string; dispatchId: string };
  assert.equal(retryPayload.dispatchId, payload.dispatchId, 'immediate retry reuses identical stable dispatchId');
});

test('Dispatch Update: op=update carries dispatchId + jsonSafe record', async () => {
  const m = mock({});
  await runUpdateDispatch(m.invoke, 'd_1', { disposal: 'SWD A', notes: 'x' });
  assert.deepEqual(m.calls[0], { op: 'update', dispatchId: 'd_1', record: { disposal: 'SWD A', notes: 'x' } });
});

test('Dispatch Cancel: op=cancel carries only dispatchId (no record)', async () => {
  const m = mock({});
  await runCancelDispatch(m.invoke, 'd_2');
  assert.deepEqual(m.calls[0], { op: 'cancel', dispatchId: 'd_2' });
});

test('Dispatch write: decline fields are rejected before any invoke', async () => {
  const m = mock({ dispatchId: 'x' });
  await assert.rejects(() => runCreateDispatch(m.invoke, { declinedAt: 1 }), /decline_fields_immutable:declinedAt/);
  assert.equal(m.calls.length, 0, 'invoker never called when payload is illegal');
  assert.throws(() => jsonSafe({ declineReason: 'no' }), /decline_fields_immutable:declineReason/);
});

// ── Dispatch Dismiss → dismissDispatch ───────────────────────────────────────

test('Dispatch Dismiss: targets dismissDispatch with {dispatchId} and unwraps result', async () => {
  assert.equal(DISMISS_DISPATCH_CALLABLE, 'dismissDispatch');
  const result: DismissDispatchResult = { ok: true, idempotent: true, dispatchIds: ['d_3'] };
  const m = mock(result);
  const out = await runDismissDispatch(m.invoke, 'd_3');
  assert.deepEqual(m.calls, [{ dispatchId: 'd_3' }]);
  assert.deepEqual(out, result);
});
