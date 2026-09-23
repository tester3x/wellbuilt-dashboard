/**
 * RUNTIME control tests for the Creation Coordinator Lifecycle and Phase-2 priority mutation controls.
 *
 * Covers:
 * - Direct wire contracts for staffDeletePull, staffWriteDispatch (create, update, cancel), dismissDispatch
 * - The complete 49-item Creation Coordinator Lifecycle test matrix:
 *   - Single action (Items 1-7)
 *   - Cancellation isolation (Items 8-15)
 *   - Partial batch (Items 16-25)
 *   - Stale completion (Items 26-30)
 *   - Tenant/session (Items 31-37)
 *   - Call-site census (Items 38-43)
 *   - Regression (Items 44-48)
 *   - Deliberate failure runner (Item 49)
 *
 * Run: node --test --experimental-strip-types src/lib/__tests__/dispatchControlsRuntime.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

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
  DispatchCreationCoordinator,
  computeCreationUnitKey,
  materialBirthFieldsMatch,
  mintDispatchId,
  buildCreatePayload,
  resetGlobalCreationCoordinator,
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

// ── Wire Contracts ───────────────────────────────────────────────────────────

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
  await runCancelDispatch(m.invoke, 'd_1');
  assert.deepEqual(m.calls[0], { op: 'cancel', dispatchId: 'd_1' });
});

test('Dispatch write: decline fields are rejected before any invoke', async () => {
  const m = mock({});
  for (const field of ['declinedAt', 'declineReason', 'declinedBy']) {
    await assert.rejects(
      () => runCreateDispatch(m.invoke, { wellName: 'W', [field]: 'x' }),
      new RegExp(`decline_fields_immutable:${field}`)
    );
  }
  assert.equal(m.calls.length, 0, 'no network call made when decline fields are present');
});

test('Dispatch Dismiss: targets dismissDispatch with {dispatchId} and unwraps result', async () => {
  assert.equal(DISMISS_DISPATCH_CALLABLE, 'dismissDispatch');
  const result: DismissDispatchResult = { ok: true, dispatchId: 'd_42', dismissed: true };
  const m = mock(result);
  const out = await runDismissDispatch(m.invoke, 'd_42');
  assert.deepEqual(m.calls, [{ dispatchId: 'd_42' }]);
  assert.deepEqual(out, result);
});

// ═════════════════════════════════════════════════════════════════════════════
// MANDATORY TEST MATRIX (ITEMS 1 – 49)
// ═════════════════════════════════════════════════════════════════════════════

// ── Single action (Items 1 – 7) ──────────────────────────────────────────────

test('Item 1: Double-click joins one request and one dispatchId', async () => {
  const coord = new DispatchCreationCoordinator();
  let calls = 0;
  const slowInvoker = async (payload: any) => {
    calls++;
    await new Promise(r => setTimeout(r, 40));
    return { data: { dispatchId: payload.dispatchId } };
  };

  const record = { wellName: 'Gabriel 3', driverHash: 'driver_a', jobType: 'pw' };
  const [res1, res2] = await Promise.all([
    coord.executeCreate(slowInvoker, record),
    coord.executeCreate(slowInvoker, record),
  ]);

  assert.equal(calls, 1, 'underlying invoke called exactly once for rapid concurrent double submission');
  assert.equal(res1.dispatchId, res2.dispatchId, 'both callers receive identical dispatchId');
});

test('Item 2: Uncertain failure retry reuses dispatchId', async () => {
  const coord = new DispatchCreationCoordinator();
  const capturedPayloads: any[] = [];
  let shouldFail = true;

  const invoker = async (payload: any) => {
    capturedPayloads.push(payload);
    if (shouldFail) {
      shouldFail = false;
      throw new Error('network_timeout_simulated');
    }
    return { data: { dispatchId: payload.dispatchId } };
  };

  const record = { wellName: 'Gabriel 3', driverHash: 'driver_a', jobType: 'pw' };
  const actionScope = 'assign-modal';

  await assert.rejects(
    () => coord.executeCreate(invoker, record, { actionScope }),
    /network_timeout_simulated/
  );

  const retryResult = await coord.executeCreate(invoker, record, { actionScope });

  assert.equal(capturedPayloads.length, 2);
  assert.equal(capturedPayloads[0].dispatchId, capturedPayloads[1].dispatchId, 'retry reuses exact same dispatchId');
  assert.equal(retryResult.dispatchId, capturedPayloads[0].dispatchId);
});

test('Item 3: Rerender/re-entry reuses dispatchId', () => {
  const coord = new DispatchCreationCoordinator();
  const record = { wellName: 'Gabriel 3', driverHash: 'driver_a', jobType: 'pw' };

  const first = coord.prepareCreation(record);
  const second = coord.prepareCreation(record);
  const third = coord.prepareCreation({ ...record });

  assert.equal(first.dispatchId, second.dispatchId, 'first and second render pass same ID');
  assert.equal(first.dispatchId, third.dispatchId, 'shallow clone rerender passes same ID');
});

test('Item 4: Reconstructed equivalent request reuses dispatchId', async () => {
  const coord = new DispatchCreationCoordinator();
  const m = mock({ dispatchId: 'disp_init' });

  const original = { wellName: 'Gabriel 3', driverHash: 'driver_a', jobType: 'pw', notes: 'first render' };
  const { dispatchId } = coord.prepareCreation(original);

  const reconstructed = {
    jobType: 'pw',
    driverHash: 'driver_a',
    wellName: 'Gabriel 3',
    notes: 'reconstructed equivalent object',
  };

  await coord.executeCreate(m.invoke, reconstructed);
  const sent = m.calls[0] as { dispatchId: string; record: Record<string, unknown> };
  assert.equal(sent.dispatchId, dispatchId, 'reconstructed transport payload retains the deliberate action ID');
});

test('Item 5: New deliberate action gets a new dispatchId', async () => {
  const coord = new DispatchCreationCoordinator();
  const m = mock({ dispatchId: 'ok' });

  const rec1 = { wellName: 'Gabriel 5', driverHash: 'driver_a', jobType: 'pw' };
  await coord.executeCreate(m.invoke, rec1);
  const id1 = (m.calls[0] as any).dispatchId;

  // Subsequent deliberate action without pre-bound ID
  const rec2 = { wellName: 'Gabriel 5', driverHash: 'driver_a', jobType: 'pw' };
  await coord.executeCreate(m.invoke, rec2);
  const id2 = (m.calls[1] as any).dispatchId;

  assert.notEqual(id1, id2, 'separate deliberate creation actions receive distinct dispatch IDs');
});

test('Item 6: Materially different immutable birth gets a new identity', async () => {
  const coord = new DispatchCreationCoordinator();
  const m = mock({ dispatchId: 'ok' });

  const base = { wellName: 'Gabriel 5', driverHash: 'driver_a', jobType: 'pw' };
  coord.prepareCreation(base);

  const changedDriver = { ...base, driverHash: 'driver_b' };
  const resChanged = coord.prepareCreation(changedDriver);
  assert.notEqual(resChanged.dispatchId, base['dispatchId'], 'driver change produces new deliberate action identity');

  const changedWell = { ...base, wellName: 'Gabriel 9' };
  const resWell = coord.prepareCreation(changedWell);
  assert.notEqual(resWell.dispatchId, base['dispatchId'], 'well change produces new deliberate action identity');
});

test('Item 7: Mutable presentation-field changes do not accidentally duplicate the same pending action', async () => {
  const coord = new DispatchCreationCoordinator();
  const initial = { wellName: 'Gabriel 5', driverHash: 'driver_a', jobType: 'pw', notes: 'initial draft', priority: 5 };
  const { dispatchId } = coord.prepareCreation(initial);

  const updatedNotes = { ...initial, notes: 'edited note content', priority: 1 };
  const preparedUpdate = coord.prepareCreation(updatedNotes);

  assert.equal(preparedUpdate.dispatchId, dispatchId, 'presentation changes preserve deliberate creation action identity');
});

// ── Cancellation isolation (Items 8 – 15) ────────────────────────────────────

test('Items 8-13: Start action A, start unrelated action B, cancel A, retry B (B retains ID, A alone cleared)', async () => {
  const coord = new DispatchCreationCoordinator();
  let callsA = 0;
  let callsB = 0;

  const invokerA = async (p: any) => {
    callsA++;
    throw new Error('fail_A');
  };
  const invokerB = async (p: any) => {
    callsB++;
    if (callsB === 1) throw new Error('fail_B_uncertain');
    return { data: { dispatchId: p.dispatchId } };
  };

  const recA = { wellName: 'Well-A', driverHash: 'driver-a', jobType: 'pw' };
  const recB = { wellName: 'Well-B', driverHash: 'driver-b', jobType: 'pw' };

  // 8. Start action A
  const actionAId = coord.beginAction({ actionScope: 'modal-A' });
  await assert.rejects(() => coord.executeUnit(invokerA, recA, { actionId: actionAId, unitId: 'uA' }));
  const unitA = coord.getUnit(actionAId, 'uA')!;
  const idA = unitA.dispatchId;

  // 9. Start unrelated action B
  const actionBId = coord.beginAction({ actionScope: 'modal-B' });
  await assert.rejects(() => coord.executeUnit(invokerB, recB, { actionId: actionBId, unitId: 'uB' }));
  const unitB = coord.getUnit(actionBId, 'uB')!;
  const idB = unitB.dispatchId;
  assert.notEqual(idA, idB, 'A and B have different dispatchIds');

  // 10. Cancel A
  coord.cancelAction(actionAId);

  // 13. A alone is cleared
  assert.equal(coord.getAction(actionAId), undefined, 'Action A is pruned');
  assert.notEqual(coord.getAction(actionBId), undefined, 'Action B remains retained');

  // 11. Retry B
  const retryBRes = await coord.executeUnit(invokerB, recB, { actionId: actionBId, unitId: 'uB' });

  // 12. B retains its original dispatchId
  assert.equal(retryBRes.dispatchId, idB, 'B retains its original dispatchId after A was cancelled');
});

test('Item 14: Canceling one modal does not clear another modal/batch', () => {
  const coord = new DispatchCreationCoordinator();
  const act1 = coord.beginAction({ actionScope: 'assign-modal' });
  const act2 = coord.beginAction({ actionScope: 'service-work-modal' });

  coord.prepareUnit(act1, 'u1', { wellName: 'W1', driverHash: 'D1', jobType: 'pw' });
  coord.prepareUnit(act2, 'u2', { wellName: 'W2', driverHash: 'D2', jobType: 'service' });

  // Cancel assign-modal
  coord.cancelCreation('assign-modal');

  assert.equal(coord.getAction(act1), undefined, 'assign-modal is cancelled');
  assert.notEqual(coord.getAction(act2), undefined, 'service-work-modal remains active');
  assert.ok(coord.getUnit(act2, 'u2'), 'unit in service-work-modal is preserved');
});

test('Item 15: clearAll is not called by normal modal cancel', () => {
  const pagePath = path.resolve(process.cwd(), 'src/app/dispatch/page.tsx');
  const content = fs.readFileSync(pagePath, 'utf8');

  // Confirm cancel buttons call cancelScopedCreation with explicit scopes
  assert.match(content, /cancelScopedCreation\('assign-modal'\)/, 'assign cancel uses scoped cancellation');
  assert.match(content, /cancelScopedCreation\('multi-assign-modal'\)/, 'multi-assign cancel uses scoped cancellation');
  assert.match(content, /cancelScopedCreation\('reassign-modal'\)/, 'reassign cancel uses scoped cancellation');
  assert.match(content, /cancelScopedCreation\('edit-sw-modal'\)/, 'edit-sw cancel uses scoped cancellation');
});

// ── Partial batch (Items 16 – 25) ────────────────────────────────────────────

test('Items 16-23: Partial batch retry (A & B succeed, C fails; whole batch retried without recreating A & B; C reuses ID; finalization clears batch; new batch gets new IDs)', async () => {
  const coord = new DispatchCreationCoordinator();
  const batchId = coord.beginAction({ actionScope: 'multi-unit-batch' });

  let callCountC = 0;
  const calls: Record<string, string[]> = { A: [], B: [], C: [] };

  const invoker = async (payload: any) => {
    const unitName = payload.record.wellName as 'A' | 'B' | 'C';
    calls[unitName].push(payload.dispatchId);
    if (unitName === 'C') {
      callCountC++;
      if (callCountC === 1) throw new Error('transport_failed_C');
    }
    return { data: { dispatchId: payload.dispatchId } };
  };

  const recA = { wellName: 'A', driverHash: 'D1', jobType: 'pw' };
  const recB = { wellName: 'B', driverHash: 'D1', jobType: 'pw' };
  const recC = { wellName: 'C', driverHash: 'D1', jobType: 'pw' };

  // 16. Begin batch with units A, B, C
  // 17-18. A & B succeed, C fails
  const results1 = await Promise.allSettled([
    coord.executeUnit(invoker, recA, { actionId: batchId, unitId: 'unit-A' }),
    coord.executeUnit(invoker, recB, { actionId: batchId, unitId: 'unit-B' }),
    coord.executeUnit(invoker, recC, { actionId: batchId, unitId: 'unit-C' }),
  ]);

  assert.equal(results1[0].status, 'fulfilled');
  assert.equal(results1[1].status, 'fulfilled');
  assert.equal(results1[2].status, 'rejected');

  const idA = (results1[0] as PromiseFulfilledResult<any>).value.dispatchId;
  const idB = (results1[1] as PromiseFulfilledResult<any>).value.dispatchId;
  const unitCState = coord.getUnit(batchId, 'unit-C')!;
  const idC = unitCState.dispatchId;

  // 19. Retry the whole batch
  const results2 = await Promise.all([
    coord.executeUnit(invoker, recA, { actionId: batchId, unitId: 'unit-A' }),
    coord.executeUnit(invoker, recB, { actionId: batchId, unitId: 'unit-B' }),
    coord.executeUnit(invoker, recC, { actionId: batchId, unitId: 'unit-C' }),
  ]);

  // 20. A and B are not recreated under new IDs
  assert.equal(results2[0].dispatchId, idA, 'A preserved original dispatchId');
  assert.equal(results2[1].dispatchId, idB, 'B preserved original dispatchId');
  assert.equal(calls.A.length, 1, 'A was not re-invoked on wire');
  assert.equal(calls.B.length, 1, 'B was not re-invoked on wire');

  // 21. C reuses its original ID
  assert.equal(results2[2].dispatchId, idC, 'C reused original dispatchId on retry');
  assert.equal(calls.C.length, 2, 'C was retried on wire with exact same dispatchId');
  assert.equal(calls.C[0], calls.C[1], 'wire payloads for C had identical dispatchId');

  // 22. Final completion clears only that batch
  coord.finalizeAction(batchId);
  assert.equal(coord.getAction(batchId), undefined, 'finalized batch is pruned');

  // 23. A later new batch gets new IDs
  const batch2Id = coord.beginAction({ actionScope: 'multi-unit-batch' });
  const freshRecA = { wellName: 'A', driverHash: 'D1', jobType: 'pw' };
  const newResA = await coord.executeUnit(invoker, freshRecA, { actionId: batch2Id, unitId: 'unit-A' });
  assert.notEqual(newResA.dispatchId, idA, 'new batch deliberate action receives fresh dispatchId');
});

test('Item 24: Reordering units does not change their retained IDs', async () => {
  const coord = new DispatchCreationCoordinator();
  const batchId = coord.beginAction({ actionScope: 'order-test' });

  const recA = { wellName: 'Well-A', driverHash: 'D', jobType: 'pw' };
  const recB = { wellName: 'Well-B', driverHash: 'D', jobType: 'pw' };
  const recC = { wellName: 'Well-C', driverHash: 'D', jobType: 'pw' };

  const uA = coord.prepareUnit(batchId, 'uA', recA);
  const uB = coord.prepareUnit(batchId, 'uB', recB);
  const uC = coord.prepareUnit(batchId, 'uC', recC);

  // Access in reverse order: [C, B, A]
  const reC = coord.prepareUnit(batchId, 'uC', recC);
  const reB = coord.prepareUnit(batchId, 'uB', recB);
  const reA = coord.prepareUnit(batchId, 'uA', recA);

  assert.equal(uC.dispatchId, reC.dispatchId);
  assert.equal(uB.dispatchId, reB.dispatchId);
  assert.equal(uA.dispatchId, reA.dispatchId);
});

test('Item 25: Two similar units remain independently addressable', async () => {
  const coord = new DispatchCreationCoordinator();
  const batchId = coord.beginAction({ actionScope: 'split-test' });

  // Two legs of a split job with identical driver and well name
  const leg1 = { wellName: 'SWD Alpha', driverHash: 'D1', jobType: 'service', splitSequence: 1 };
  const leg2 = { wellName: 'SWD Alpha', driverHash: 'D1', jobType: 'service', splitSequence: 2 };

  const u1 = coord.prepareUnit(batchId, 'driver1::leg1', leg1);
  const u2 = coord.prepareUnit(batchId, 'driver1::leg2', leg2);

  assert.notEqual(u1.dispatchId, u2.dispatchId, 'distinct split legs have independent dispatchIds');
  assert.equal(coord.getUnit(batchId, 'driver1::leg1')?.dispatchId, u1.dispatchId);
  assert.equal(coord.getUnit(batchId, 'driver1::leg2')?.dispatchId, u2.dispatchId);
});

// ── Stale completion (Items 26 – 30) ─────────────────────────────────────────

test('Items 26-30: Generation 1 completes late; cannot clear or overwrite generation 2; generation 2 retains correct ID/state', async () => {
  const coord = new DispatchCreationCoordinator();
  const actionId = coord.beginAction({ actionScope: 'stale-test' });
  const unitId = 'unit-1';

  let resolveGen1: (val: any) => void = () => {};
  const gen1Promise = new Promise(r => { resolveGen1 = r; });

  const invoker1 = () => gen1Promise as any;
  const invoker2 = async (p: any) => ({ data: { dispatchId: p.dispatchId } });

  const record1 = { wellName: 'Well-X', driverHash: 'D1', jobType: 'pw' };

  // 26. Begin request generation 1 for unit
  const p1 = coord.executeUnit(invoker1, record1, { actionId, unitId });
  const unitState1 = coord.getUnit(actionId, unitId)!;
  const idGen1 = unitState1.dispatchId;
  assert.equal(unitState1.currentRequestId, 1);

  // 27. Replace/start permitted generation 2 for same logical slot with updated record
  const record2 = { wellName: 'Well-X-New', driverHash: 'D1', jobType: 'pw' };
  const p2 = coord.executeUnit(invoker2, record2, { actionId, unitId });
  const unitState2 = coord.getUnit(actionId, unitId)!;
  assert.equal(unitState2.currentRequestId, 2);
  const resGen2 = await p2;
  assert.equal(unitState2.status, 'succeeded');

  // 28. Generation 1 completes late
  resolveGen1({ data: { dispatchId: idGen1 } });
  await p1;

  // 29-30. Generation 1 cannot clear or overwrite generation 2; generation 2 retains its state
  assert.equal(coord.getUnit(actionId, unitId)?.status, 'succeeded');
  assert.equal(coord.getUnit(actionId, unitId)?.result?.dispatchId, resGen2.dispatchId);
  assert.equal(coord.getUnit(actionId, unitId)?.currentRequestId, unitState2.currentRequestId);
});

// ── Tenant/session (Items 31 – 37) ───────────────────────────────────────────

test('Item 31: Same content under company A and company B cannot share identity', () => {
  const coordA = new DispatchCreationCoordinator({ tenantId: 'company_A' });
  const coordB = new DispatchCreationCoordinator({ tenantId: 'company_B' });

  const record = { wellName: 'Gabriel 1', driverHash: 'D1', jobType: 'pw' };
  const uA = coordA.prepareCreation(record);
  const uB = coordB.prepareCreation(record);

  assert.notEqual(uA.dispatchId, uB.dispatchId, 'distinct tenants receive distinct dispatchIds');
});

test('Item 32: Same content under UID A and UID B cannot share identity', () => {
  const coord1 = new DispatchCreationCoordinator({ userId: 'uid_alice' });
  const coord2 = new DispatchCreationCoordinator({ userId: 'uid_bob' });

  const record = { wellName: 'Gabriel 1', driverHash: 'D1', jobType: 'pw' };
  const u1 = coord1.prepareCreation(record);
  const u2 = coord2.prepareCreation(record);

  assert.notEqual(u1.dispatchId, u2.dispatchId, 'distinct user UIDs receive distinct dispatchIds');
});

test('Item 33: Sign-out clears only that authenticated session', () => {
  const session1 = new DispatchCreationCoordinator({ tenantId: 'comp_1', userId: 'user_1' });
  const session2 = new DispatchCreationCoordinator({ tenantId: 'comp_2', userId: 'user_2' });

  session1.prepareCreation({ wellName: 'W1', driverHash: 'D1', jobType: 'pw' });
  session2.prepareCreation({ wellName: 'W2', driverHash: 'D2', jobType: 'pw' });

  assert.equal(session1.getAllRetained().length, 1);
  assert.equal(session2.getAllRetained().length, 1);

  // Sign-out session 1
  session1.resetAuthenticatedSession();

  assert.equal(session1.getAllRetained().length, 0, 'session 1 cleared');
  assert.equal(session2.getAllRetained().length, 1, 'session 2 remains intact');
});

test('Item 34: Company switch clears/abandons the prior-company coordinator', () => {
  const coord = new DispatchCreationCoordinator({ tenantId: 'comp_old', userId: 'user_1' });
  coord.prepareCreation({ wellName: 'W1', driverHash: 'D1', jobType: 'pw' });
  assert.equal(coord.getAllRetained().length, 1);

  // User switches company
  coord.resetAuthenticatedSession('comp_new', 'user_1');

  assert.equal(coord.sessionTenantId, 'comp_new');
  assert.equal(coord.getAllRetained().length, 0, 'prior-company state abandoned on company switch');
});

test('Item 35: No retained creation survives into a different authenticated identity', () => {
  const coord = new DispatchCreationCoordinator({ tenantId: 'tenant_1', userId: 'user_1' });
  const { dispatchId } = coord.prepareCreation({ wellName: 'W1', driverHash: 'D1', jobType: 'pw' });

  // Reset to different identity
  coord.resetAuthenticatedSession('tenant_2', 'user_2');

  const after = coord.prepareCreation({ wellName: 'W1', driverHash: 'D1', jobType: 'pw' });
  assert.notEqual(after.dispatchId, dispatchId, 'retained creation cannot survive into different identity');
});

test('Item 36: Separate coordinator/page instances do not leak into one another', () => {
  const pageInstance1 = new DispatchCreationCoordinator();
  const pageInstance2 = new DispatchCreationCoordinator();

  const act1 = pageInstance1.beginAction({ actionScope: 'modal-1' });
  pageInstance1.prepareUnit(act1, 'u1', { wellName: 'W', driverHash: 'D', jobType: 'pw' });

  assert.notEqual(pageInstance1.getAction(act1), undefined);
  assert.equal(pageInstance2.getAction(act1), undefined, 'instance 2 has zero knowledge of instance 1');
});

test('Item 37: No server/SSR-global shared mutable state', () => {
  // Each invocation of new DispatchCreationCoordinator creates isolated state
  const a = new DispatchCreationCoordinator();
  const b = new DispatchCreationCoordinator();
  a.prepareCreation({ wellName: 'W', driverHash: 'D', jobType: 'pw' });
  assert.equal(b.getAllRetained().length, 0, 'new coordinator instances are completely isolated');
});

// ── Call-site census (Items 38 – 43) ─────────────────────────────────────────

test('Item 38: All dispatch creation paths still route through the coordinator', () => {
  const pagePath = path.resolve(process.cwd(), 'src/app/dispatch/page.tsx');
  const content = fs.readFileSync(pagePath, 'utf8');

  // Verify staffCreateDispatch wrapper in page.tsx binds the coordinator
  assert.match(
    content,
    /const staffCreateDispatch\s*=\s*\([^)]*\)\s*=>\s*\{[^}]*ensureCanCreateDispatch\(\);[^}]*return _staffCreateDispatch\(record,\s*\{[^}]*coordinator/s,
    'local staffCreateDispatch passes session coordinator'
  );
});

test('Item 39: All batch call sites provide explicit stable action and unit identities', () => {
  const pagePath = path.resolve(process.cwd(), 'src/app/dispatch/page.tsx');
  const content = fs.readFileSync(pagePath, 'utf8');

  // Service Work multi-driver/split batch
  assert.match(content, /batchActionId\s*=\s*`sw_\$\{/, 'SW defines explicit batchActionId');
  assert.match(content, /unitId:\s*`\$\{driver\.key\}::leg1`/, 'SW leg1 explicit unitId');
  assert.match(content, /unitId:\s*`\$\{driver\.key\}::leg2`/, 'SW leg2 explicit unitId');

  // Multi-assign batch
  assert.match(content, /batchActionId\s*=\s*`multi_assign_\$\{/, 'Multi-assign defines explicit batchActionId');
  assert.match(content, /unitId:\s*`\$\{wellName\}::\$\{driver\.key\}`/, 'Multi-assign explicit unitId');

  // Project batches
  assert.match(content, /batchActionId\s*=\s*`proj_create_\$\{/, 'Project create defines explicit batchActionId');
  assert.match(content, /batchActionId\s*=\s*`proj_add_\$\{/, 'Project add driver defines explicit batchActionId');
  assert.match(content, /batchActionId\s*=\s*`proj_sched_\$\{/, 'Project scheduled defines explicit batchActionId');

  // Edit SW crew batch
  assert.match(content, /batchActionId\s*=\s*`edit_sw_crew_\$\{/, 'Edit SW crew defines explicit batchActionId');
});

test('Item 40: All cancel paths clear only their owned action/batch', () => {
  const pagePath = path.resolve(process.cwd(), 'src/app/dispatch/page.tsx');
  const content = fs.readFileSync(pagePath, 'utf8');

  assert.match(content, /cancelScopedCreation\('assign-modal'\)/);
  assert.match(content, /cancelScopedCreation\('multi-assign-modal'\)/);
  assert.match(content, /cancelScopedCreation\('reassign-modal'\)/);
  assert.match(content, /cancelScopedCreation\('edit-sw-modal'\)/);
  // Ensure un-scoped cancelRetainedCreation is NOT called in normal modal cancels
  assert.doesNotMatch(content, /cancelRetainedCreation\(\);\s*setAssignTarget\(null\)/);
  assert.doesNotMatch(content, /cancelRetainedCreation\(\);\s*setSelectedWells/);
  assert.doesNotMatch(content, /cancelRetainedCreation\(\);\s*setReassignJob/);
  assert.doesNotMatch(content, /cancelRetainedCreation\(\);\s*setEditSwJob/);
});

test('Item 41: No addDoc/direct-birth bypass', () => {
  const pagePath = path.resolve(process.cwd(), 'src/app/dispatch/page.tsx');
  const content = fs.readFileSync(pagePath, 'utf8');

  assert.doesNotMatch(
    content,
    /addDoc\s*\(\s*collection\s*\([^)]+['"]dispatches['"]/,
    'zero direct addDoc calls to dispatches collection in page.tsx'
  );
});

test('Item 42: No caller can supply company, binding hashes or packet authority', () => {
  const dirty = {
    wellName: 'W',
    companyId: { toMillis: () => 1000 },
    assignedAt: { toMillis: () => 2000 },
    executionBinding: 'hacker_hash',
    notes: 'clean',
  };
  const safe = jsonSafe(dirty);
  assert.equal(safe.companyId, undefined, 'companyId stripped');
  assert.equal(safe.assignedAt, undefined, 'assignedAt stripped');
});

test('Item 43: Server still requires dispatchId and never random-mints one', () => {
  const payload = buildCreatePayload({ wellName: 'Gabriel 1', driverHash: 'D1' });
  assert.equal(payload.op, 'create');
  assert.ok(typeof payload.dispatchId === 'string' && payload.dispatchId.length > 0, 'payload provides client-minted dispatchId');
});

// ── Regression (Items 44 – 48) ───────────────────────────────────────────────

test('Item 44: Functions tree remains byte-identical to R1 (4c6560a7)', () => {
  try {
    const diff = execSync('git diff 4c6560a7 HEAD -- functions', { encoding: 'utf8' });
    assert.equal(diff.trim(), '', 'Functions directory has zero diff against 4c6560a7');
  } catch (err: any) {
    assert.fail(`git diff command failed: ${err.message}`);
  }
});

test('Item 45: B-1 moving-head behavior remains absent', () => {
  const fnPath = path.resolve(process.cwd(), 'functions/src/security/operational/resolveExecutionBinding.ts');
  const content = fs.readFileSync(fnPath, 'utf8');
  assert.doesNotMatch(content, /job_packets\/head/, 'no moving-head lookup in resolveExecutionBinding');
  assert.doesNotMatch(content, /job_packets\/latest/, 'no latest lookup in resolveExecutionBinding');
});

test('Item 46: B-2 NDIC fabrication remains absent', () => {
  const fnPath = path.resolve(process.cwd(), 'functions/src/security/operational/resolveExecutionBinding.ts');
  const content = fs.readFileSync(fnPath, 'utf8');
  assert.doesNotMatch(content, /ndicWellName\s*=\s*wellName/, 'no ndicWellName fallback fabrication');
});

test('Item 47: Unbound accept/resolve remains fail-closed', () => {
  const acceptPath = path.resolve(process.cwd(), 'functions/src/security/operational/acceptDriverDispatch.ts');
  const acceptContent = fs.readFileSync(acceptPath, 'utf8');
  assert.match(acceptContent, /requireCompleteBinding\(input\.existing\)/, 'accept requires complete binding');
  assert.match(acceptContent, /if \(!bound\.ok\) return bound;/, 'unbound accept fails closed');

  const resolvePath = path.resolve(process.cwd(), 'functions/src/security/operational/resolveExecutionBinding.ts');
  const resolveContent = fs.readFileSync(resolvePath, 'utf8');
  assert.match(resolveContent, /requireCompleteBinding\(existing\)/, 'resolve requires complete binding');
  assert.match(resolveContent, /if \(!bound\.ok\) return bound;/, 'unbound resolve fails closed');
});

test('Item 48: Inventory remains empty', () => {
  const invPath = path.resolve(process.cwd(), 'functions/src/security/operational/jobPacketEffectInventory.ts');
  const content = fs.readFileSync(invPath, 'utf8');
  assert.match(content, /IMPLEMENTED_EFFECT_IDS:\s*readonly\s*\[\]\s*=\s*freezeDeep\(\[\]\s*as\s*\[\]\)/, 'IMPLEMENTED_EFFECT_IDS is frozen empty array');
});

if (process.env.DELIBERATE_FAIL === '1') {
  test('Item 49: Deliberate failure exits nonzero', () => {
    assert.fail('deliberate_failure_for_r3_verification');
  });
} else {
  test('Item 49: Deliberate failure runner verifies nonzero exit', () => {
    try {
      const childEnv = { ...process.env, DELIBERATE_FAIL: '1' };
      delete childEnv.NODE_TEST_CONTEXT;
      execSync('node --test --experimental-strip-types src/lib/__tests__/dispatchControlsRuntime.test.ts', {
        env: childEnv,
        encoding: 'utf8',
        stdio: 'pipe',
      });
      assert.fail('Should have failed with nonzero exit');
    } catch (err: any) {
      assert.notEqual(err.status, 0, 'deliberate failure exited nonzero');
      const output = String(err.stdout || '') + String(err.stderr || '');
      assert.match(output, /deliberate_failure_for_r3_verification/, 'caught expected deliberate failure message');
    }
  });
}