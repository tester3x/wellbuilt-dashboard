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
  DispatchCreationCoordinator,
  computeCreationUnitKey,
  materialBirthFieldsMatch,
  mintDispatchId,
  resetGlobalCreationCoordinator,
} from '../staffWriteDispatchCore.ts';
import {
  DISMISS_DISPATCH_CALLABLE,
  runDismissDispatch,
  type DismissDispatchResult,
} from '../dismissDispatchCore.ts';
import fs from 'node:fs';
import path from 'node:path';

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

// ── F-1 Deliberate Creation Action & Idempotency Behavioral Proofs ─────────────

test('F-1 Proof: rapid double submission invokes creation once or uses identical dispatchId', async () => {
  const coord = new DispatchCreationCoordinator();
  let calls = 0;
  let delayResolve: (val: unknown) => void;
  const delayedInvoker = async (payload: any) => {
    calls++;
    await new Promise((resolve) => { delayResolve = resolve; setTimeout(resolve, 25); });
    return { data: { dispatchId: payload.dispatchId } };
  };

  const record = { wellName: 'Gabriel 5', driverHash: 'mike_hash', jobType: 'pw' };
  // Trigger rapid double submission concurrently
  const [res1, res2] = await Promise.all([
    coord.executeCreate(delayedInvoker, { ...record }),
    coord.executeCreate(delayedInvoker, { ...record }),
  ]);

  assert.equal(calls, 1, 'in-flight request joined: callable invoked only ONCE during double submission');
  assert.equal(res1.dispatchId, res2.dispatchId, 'both callers receive the identical dispatchId');
  assert.ok(typeof res1.dispatchId === 'string' && res1.dispatchId.length > 0);
});

test('F-1 Proof: retry following simulated uncertain network failure resends identical dispatchId', async () => {
  const coord = new DispatchCreationCoordinator();
  const capturedPayloads: any[] = [];
  let attempt = 0;
  const flakyInvoker = async (payload: any) => {
    attempt++;
    capturedPayloads.push(payload);
    if (attempt === 1) {
      throw new Error('network timeout / uncertain delivery');
    }
    return { data: { dispatchId: payload.dispatchId } };
  };

  const recordAttempt1 = { wellName: 'Thor 1', driverHash: 'd_1', jobType: 'pw' };
  // Attempt 1 fails with network timeout
  await assert.rejects(
    () => coord.executeCreate(flakyInvoker, recordAttempt1),
    /network timeout/
  );

  assert.equal(capturedPayloads.length, 1);
  const firstDispatchId = capturedPayloads[0].dispatchId;
  assert.ok(firstDispatchId, 'first attempt minted stable dispatchId');

  // Attempt 2 (retry): caller creates a BRAND NEW object literal without dispatchId
  const recordAttempt2 = { wellName: 'Thor 1', driverHash: 'd_1', jobType: 'pw' };
  const res2 = await coord.executeCreate(flakyInvoker, recordAttempt2);

  assert.equal(capturedPayloads.length, 2);
  const secondDispatchId = capturedPayloads[1].dispatchId;
  assert.equal(secondDispatchId, firstDispatchId, 'retry resends the identical dispatchId');
  assert.equal(res2.dispatchId, firstDispatchId, 'caller unwraps the identical dispatchId');
});

test('F-1 Proof: rerender does not change pending dispatchId', () => {
  const coord = new DispatchCreationCoordinator();
  // Rerender 1: component renders form state
  const p1 = coord.prepareCreation({ wellName: 'Gabriel 5', driverHash: 'mike_hash', jobType: 'pw' });
  // Rerender 2: another render pass constructs a new object literal with identical state
  const p2 = coord.prepareCreation({ wellName: 'Gabriel 5', driverHash: 'mike_hash', jobType: 'pw' });
  // Rerender 3: third render pass
  const p3 = coord.prepareCreation({ wellName: 'Gabriel 5', driverHash: 'mike_hash', jobType: 'pw' });

  assert.equal(p1.dispatchId, p2.dispatchId, 'rerender 1 and 2 share identical dispatchId');
  assert.equal(p2.dispatchId, p3.dispatchId, 'rerender 2 and 3 share identical dispatchId');
});

test('F-1 Proof: reconstructed transport payload retains deliberate action ID', async () => {
  const coord = new DispatchCreationCoordinator();
  const { dispatchId, unitKey } = coord.prepareCreation({ wellName: 'Well A', driverHash: 'd_a', jobType: 'pw' });

  const m = mock({ dispatchId });
  // Handler executes with newly constructed object
  const newObj = { wellName: 'Well A', driverHash: 'd_a', jobType: 'pw', notes: 'fresh reconstructed' };
  await coord.executeCreate(m.invoke, newObj);

  const sent = m.calls[0] as { op: string; dispatchId: string; record: Record<string, unknown> };
  assert.equal(sent.dispatchId, dispatchId, 'reconstructed transport payload retains the deliberate action ID');
  assert.equal(sent.record.notes, 'fresh reconstructed');
});

test('F-1 Proof: separate deliberate creation actions receive different IDs', async () => {
  const coord = new DispatchCreationCoordinator();
  const m = mock({ dispatchId: 'ok' });

  // Action 1: succeeds definitively
  const rec1 = { wellName: 'Gabriel 5', driverHash: 'mike_hash', jobType: 'pw' };
  const res1 = await coord.executeCreate(m.invoke, rec1);
  const id1 = (m.calls[0] as any).dispatchId;

  // Action 2: Later, user deliberately dispatches Gabriel 5 to Mike again (second load)
  const rec2 = { wellName: 'Gabriel 5', driverHash: 'mike_hash', jobType: 'pw' };
  const res2 = await coord.executeCreate(m.invoke, rec2);
  const id2 = (m.calls[1] as any).dispatchId;

  assert.notEqual(id1, id2, 'separate deliberate creation actions receive distinct dispatch IDs');

  // Material change test: change driver
  const rec3 = { wellName: 'Gabriel 5', driverHash: 'john_hash', jobType: 'pw' };
  const res3 = await coord.executeCreate(m.invoke, rec3);
  const id3 = (m.calls[2] as any).dispatchId;

  assert.notEqual(id3, id2, 'material change (driver change) mints a new distinct dispatch ID');
});

test('F-1 Proof: multi-leg creation produces stable, unique IDs per intended leg', async () => {
  const coord = new DispatchCreationCoordinator();
  const captured: any[] = [];
  const invoker = async (payload: any) => {
    captured.push(payload);
    return { data: { dispatchId: payload.dispatchId } };
  };

  const splitGroupId = 'sg_fieldtest_1';
  const leg1 = {
    wellName: 'Gabriel 5',
    driverHash: 'mike_hash',
    jobType: 'service',
    serviceType: 'Water Transfer',
    splitGroupId,
    splitSequence: 1,
  };
  const leg2 = {
    wellName: 'Dropoff SWD',
    driverHash: 'mike_hash',
    jobType: 'service',
    serviceType: 'Water Transfer',
    splitGroupId,
    splitSequence: 2,
  };
  const leg3 = {
    wellName: 'Disposal Station B',
    driverHash: 'mike_hash',
    jobType: 'service',
    serviceType: 'Water Transfer',
    splitGroupId,
    splitSequence: 3,
  };

  // Execute all 3 legs
  await Promise.all([
    coord.executeCreate(invoker, leg1),
    coord.executeCreate(invoker, leg2),
    coord.executeCreate(invoker, leg3),
  ]);

  assert.equal(captured.length, 3);
  const idLeg1 = captured[0].dispatchId;
  const idLeg2 = captured[1].dispatchId;
  const idLeg3 = captured[2].dispatchId;

  assert.notEqual(idLeg1, idLeg2, 'leg 1 and leg 2 have unique dispatch IDs');
  assert.notEqual(idLeg2, idLeg3, 'leg 2 and leg 3 have unique dispatch IDs');
  assert.notEqual(idLeg1, idLeg3, 'leg 1 and leg 3 have unique dispatch IDs');
});

test('F-1 Proof: static audit confirms all production dispatch creates in dispatch/page.tsx use stable action identity', () => {
  const pagePath = path.resolve(process.cwd(), 'src/app/dispatch/page.tsx');
  const content = fs.readFileSync(pagePath, 'utf8');

  // 1. Confirm staffCreateDispatch is imported from @/lib/staffWriteDispatch
  assert.match(
    content,
    /import\s*\{[^}]*staffCreateDispatch as _staffCreateDispatch[^}]*\}\s*from\s*['"]@\/lib\/staffWriteDispatch['"]/,
    'imports _staffCreateDispatch from @/lib/staffWriteDispatch'
  );

  // 2. Confirm cancelRetainedCreation is imported
  assert.match(
    content,
    /import\s*\{[^}]*cancelRetainedCreation[^}]*\}\s*from\s*['"]@\/lib\/staffWriteDispatch['"]/,
    'imports cancelRetainedCreation from @/lib/staffWriteDispatch'
  );

  // 3. Confirm local staffCreateDispatch delegates to _staffCreateDispatch
  assert.match(
    content,
    /const staffCreateDispatch\s*=\s*\([^)]*\)\s*=>\s*\{[^}]*ensureCanCreateDispatch\(\);[^}]*return _staffCreateDispatch\(record,\s*options\);[^}]*\};/,
    'local staffCreateDispatch delegates to coordinated _staffCreateDispatch'
  );

  // 4. Confirm zero raw addDoc(collection(..., 'dispatches')) calls
  assert.doesNotMatch(
    content,
    /addDoc\s*\(\s*collection\s*\([^)]+['"]dispatches['"]/,
    'zero direct addDoc calls to dispatches collection in page.tsx'
  );

  // 5. Confirm cancel buttons invoke cancelRetainedCreation
  assert.match(content, /cancelRetainedCreation\(\);\s*setAssignTarget\(null\)/, 'assign cancel clears retained creation');
  assert.match(content, /cancelRetainedCreation\(\);\s*setSelectedWells/, 'bulk clear clears retained creation');
  assert.match(content, /cancelRetainedCreation\(\);\s*setReassignJob\(null\)/, 'reassign cancel clears retained creation');
  assert.match(content, /cancelRetainedCreation\(\);\s*setEditSwJob\(null\)/, 'editSwJob close clears retained creation');
});
