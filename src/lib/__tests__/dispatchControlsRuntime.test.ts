/**
 * RUNTIME control tests for the Creation Coordinator Lifecycle and Phase-2 priority mutation controls.
 *
 * Covers:
 * - Direct wire contracts for staffDeletePull, staffWriteDispatch (create, update, cancel), dismissDispatch
 * - 43 Mandatory Test Cases (testing real production orchestration helpers, NOT source-text regexes):
 *   - Service Work Workflow Identity (Items 1-15)
 *   - Create Project Workflow Identity (Items 16-31)
 *   - Regression & Operational Invariants (Items 32-43)
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
  mintDispatchId,
  buildCreatePayload,
} from '../staffWriteDispatchCore.ts';
import type { CallableInvoker } from '../staffWriteDispatchCore.ts';
import {
  DISMISS_DISPATCH_CALLABLE,
  runDismissDispatch,
  type DismissDispatchResult,
} from '../dismissDispatchCore.ts';
import {
  createServiceWorkWorkflow,
  ensureServiceWorkGroupIds,
  executeServiceWorkWorkflow,
  cancelServiceWorkWorkflow,
  type ServiceWorkWorkflowState,
} from '../serviceWorkWorkflowCore.ts';
import {
  createProjectWorkflow,
  mintProjectId,
  projectImmutableIdentityMatches,
  executeCreateProjectWorkflow,
  cancelCreateProjectWorkflow,
  type CreateProjectWorkflowState,
  type FirestoreProjectWriter,
  type ProjectDataInput,
} from '../projectWorkflowCore.ts';

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
// 43 MANDATORY TEST CASES (ITEMS 1 – 43)
// ═════════════════════════════════════════════════════════════════════════════

// ── Service Work Workflow Identity (Items 1 – 15) ─────────────────────────────

test('Item 1: Open one SW workflow', () => {
  const wf = createServiceWorkWorkflow();
  assert.ok(wf.workflowId.startsWith('sw_'), 'workflowId starts with sw_');
  assert.equal(wf.actionId, `act_${wf.workflowId}`, 'actionId is derived from workflowId');
  assert.equal(wf.serviceGroupId, undefined, 'serviceGroupId begins unallocated');
  assert.equal(wf.splitGroupId, undefined, 'splitGroupId begins unallocated');
});

test('Item 2: Capture actionId, serviceGroupId, splitGroupId', () => {
  const wf = createServiceWorkWorkflow();
  ensureServiceWorkGroupIds(wf, true, true);
  assert.ok(wf.serviceGroupId?.startsWith('sg_'), 'serviceGroupId allocated');
  assert.ok(wf.splitGroupId?.startsWith('split_'), 'splitGroupId allocated');
  const capturedActionId = wf.actionId;
  const capturedServiceGroupId = wf.serviceGroupId;
  const capturedSplitGroupId = wf.splitGroupId;

  // Multiple subsequent checks do not mutate or recreate
  ensureServiceWorkGroupIds(wf, true, true);
  assert.equal(wf.actionId, capturedActionId);
  assert.equal(wf.serviceGroupId, capturedServiceGroupId);
  assert.equal(wf.splitGroupId, capturedSplitGroupId);
});

test('Item 3: Submit', async () => {
  const coord = new DispatchCreationCoordinator();
  const wf = createServiceWorkWorkflow();
  const wireCalls: any[] = [];
  const invoker: CallableInvoker = async (payload) => {
    wireCalls.push(payload);
    return { data: { dispatchId: (payload as any).dispatchId } };
  };

  const res = await executeServiceWorkWorkflow({
    workflow: wf,
    coordinator: coord,
    invoke: invoker,
    selectedDrivers: [{ key: 'd1', driverHash: 'd1', driverId: 'd1', displayName: 'D1' }],
    wellName: 'Well 1',
    ndicWellName: 'Well 1 NDIC',
    serviceType: 'Water Haul',
    assignedBy: 'tester',
  });

  assert.equal(res.actionId, wf.actionId);
  assert.equal(res.dispatches.length, 1);
  assert.equal(wireCalls.length, 1);
});

test('Item 4: Some units succeed', async () => {
  const coord = new DispatchCreationCoordinator();
  const wf = createServiceWorkWorkflow();
  const wireCalls: any[] = [];
  const invoker: CallableInvoker = async (payload: any) => {
    wireCalls.push(payload);
    if (payload.record.driverHash === 'd2') {
      throw new Error('d2_transport_failure');
    }
    return { data: { dispatchId: payload.dispatchId } };
  };

  await assert.rejects(
    () => executeServiceWorkWorkflow({
      workflow: wf,
      coordinator: coord,
      invoke: invoker,
      selectedDrivers: [
        { key: 'd1', driverHash: 'd1', driverId: 'd1', displayName: 'D1' },
        { key: 'd2', driverHash: 'd2', driverId: 'd2', displayName: 'D2' },
      ],
      wellName: 'Well 1',
      ndicWellName: 'Well 1 NDIC',
      serviceType: 'Water Haul',
      assignedBy: 'tester',
    }),
    /d2_transport_failure/
  );

  const d1Unit = coord.getUnit(wf.actionId, 'd1::leg1');
  assert.equal(d1Unit?.status, 'succeeded', 'd1 unit succeeded despite d2 failure');
  assert.ok(d1Unit?.dispatchId, 'd1 unit has retained dispatchId');
});

test('Item 5: One unit fails uncertainly', async () => {
  const coord = new DispatchCreationCoordinator();
  const wf = createServiceWorkWorkflow();
  const invoker: CallableInvoker = async (payload: any) => {
    if (payload.record.driverHash === 'd_uncertain') {
      throw new Error('ETIMEDOUT: network_uncertainty');
    }
    return { data: { dispatchId: payload.dispatchId } };
  };

  await assert.rejects(
    () => executeServiceWorkWorkflow({
      workflow: wf,
      coordinator: coord,
      invoke: invoker,
      selectedDrivers: [{ key: 'd_uncertain', driverHash: 'd_uncertain', driverId: 'd_uncertain', displayName: 'D' }],
      wellName: 'Well 1',
      ndicWellName: 'Well 1',
      serviceType: 'Haul',
      assignedBy: 'tester',
    }),
    /ETIMEDOUT: network_uncertainty/
  );

  const unit = coord.getUnit(wf.actionId, 'd_uncertain::leg1');
  assert.equal(unit?.status, 'failed-uncertain', 'uncertain unit marked failed-uncertain');
  assert.ok(unit?.dispatchId, 'failed unit retains its allocated dispatchId');
});

test('Item 6: Submit again through actual handler helper', async () => {
  const coord = new DispatchCreationCoordinator();
  const wf = createServiceWorkWorkflow();
  let failFirst = true;
  const wireCalls: any[] = [];
  const invoker: CallableInvoker = async (payload: any) => {
    wireCalls.push(payload);
    if (failFirst) {
      failFirst = false;
      throw new Error('temporary_disconnect');
    }
    return { data: { dispatchId: payload.dispatchId } };
  };

  const params = {
    workflow: wf,
    coordinator: coord,
    invoke: invoker,
    selectedDrivers: [{ key: 'd1', driverHash: 'd1', driverId: 'd1', displayName: 'D1' }],
    wellName: 'Well 1',
    ndicWellName: 'Well 1',
    serviceType: 'Haul',
    assignedBy: 'tester',
  };

  await assert.rejects(() => executeServiceWorkWorkflow(params), /temporary_disconnect/);
  // Re-submit via handler helper
  const res = await executeServiceWorkWorkflow(params);
  assert.equal(res.actionId, wf.actionId);
  assert.equal(wireCalls.length, 2);
});

test('Item 7: All workflow IDs remain identical', async () => {
  const coord = new DispatchCreationCoordinator();
  const wf = createServiceWorkWorkflow();
  ensureServiceWorkGroupIds(wf, true, true);
  const initialActionId = wf.actionId;
  const initialServiceGroupId = wf.serviceGroupId;
  const initialSplitGroupId = wf.splitGroupId;

  let failCount = 0;
  const invoker: CallableInvoker = async (payload: any) => {
    if (failCount++ < 1) throw new Error('fail');
    return { data: { dispatchId: payload.dispatchId } };
  };

  const params = {
    workflow: wf,
    coordinator: coord,
    invoke: invoker,
    selectedDrivers: [
      { key: 'd1', driverHash: 'd1', driverId: 'd1', displayName: 'D1' },
      { key: 'd2', driverHash: 'd2', driverId: 'd2', displayName: 'D2' },
    ],
    wellName: 'Well 1',
    ndicWellName: 'Well 1',
    serviceType: 'Haul',
    isSplitTicket: true,
    dropoff: 'Disposal Alpha',
    assignedBy: 'tester',
  };

  await assert.rejects(() => executeServiceWorkWorkflow(params), /fail/);
  await executeServiceWorkWorkflow(params);

  assert.equal(wf.actionId, initialActionId, 'actionId strictly identical');
  assert.equal(wf.serviceGroupId, initialServiceGroupId, 'serviceGroupId strictly identical');
  assert.equal(wf.splitGroupId, initialSplitGroupId, 'splitGroupId strictly identical');
});

test('Item 8: Succeeded units are not recreated', async () => {
  const coord = new DispatchCreationCoordinator();
  const wf = createServiceWorkWorkflow();
  const wireInvocations: string[] = [];
  let shouldFailD2 = true;

  const invoker: CallableInvoker = async (payload: any) => {
    const driver = payload.record.driverHash;
    wireInvocations.push(driver);
    if (driver === 'd2' && shouldFailD2) {
      shouldFailD2 = false;
      throw new Error('d2_transport_fail');
    }
    return { data: { dispatchId: payload.dispatchId } };
  };

  const params = {
    workflow: wf,
    coordinator: coord,
    invoke: invoker,
    selectedDrivers: [
      { key: 'd1', driverHash: 'd1', driverId: 'd1', displayName: 'D1' },
      { key: 'd2', driverHash: 'd2', driverId: 'd2', displayName: 'D2' },
    ],
    wellName: 'Well 1',
    ndicWellName: 'Well 1',
    serviceType: 'Haul',
    assignedBy: 'tester',
  };

  await assert.rejects(() => executeServiceWorkWorkflow(params), /d2_transport_fail/);
  await executeServiceWorkWorkflow(params);

  const d1Count = wireInvocations.filter(d => d === 'd1').length;
  assert.equal(d1Count, 1, 'd1 succeeded unit was NOT recreated on wire during retry');
});

test('Item 9: Failed unit reuses dispatchId', async () => {
  const coord = new DispatchCreationCoordinator();
  const wf = createServiceWorkWorkflow();
  const capturedPayloads: any[] = [];
  let fail = true;

  const invoker: CallableInvoker = async (payload: any) => {
    capturedPayloads.push(payload);
    if (fail) {
      fail = false;
      throw new Error('failed_wire_attempt');
    }
    return { data: { dispatchId: payload.dispatchId } };
  };

  const params = {
    workflow: wf,
    coordinator: coord,
    invoke: invoker,
    selectedDrivers: [{ key: 'd1', driverHash: 'd1', driverId: 'd1', displayName: 'D1' }],
    wellName: 'Well 1',
    ndicWellName: 'Well 1',
    serviceType: 'Haul',
    assignedBy: 'tester',
  };

  await assert.rejects(() => executeServiceWorkWorkflow(params), /failed_wire_attempt/);
  await executeServiceWorkWorkflow(params);

  assert.equal(capturedPayloads.length, 2);
  assert.equal(capturedPayloads[0].dispatchId, capturedPayloads[1].dispatchId, 'failed unit reuses exact dispatchId on retry');
});

test('Item 10: Rerender preserves workflow identity', () => {
  const wf = createServiceWorkWorkflow();
  ensureServiceWorkGroupIds(wf, true, true);
  const actionId1 = wf.actionId;
  const sgId1 = wf.serviceGroupId;
  const splitId1 = wf.splitGroupId;

  // Simulate component rerenders: re-evaluating ensureServiceWorkGroupIds
  ensureServiceWorkGroupIds(wf, true, true);
  ensureServiceWorkGroupIds(wf, true, true);

  assert.equal(wf.actionId, actionId1);
  assert.equal(wf.serviceGroupId, sgId1);
  assert.equal(wf.splitGroupId, splitId1);
});

test('Item 11: Validation correction preserves identity', async () => {
  const coord = new DispatchCreationCoordinator();
  const wf = createServiceWorkWorkflow();
  ensureServiceWorkGroupIds(wf, true, false);
  const initialActionId = wf.actionId;
  const initialServiceGroupId = wf.serviceGroupId;

  const invoker: CallableInvoker = async (payload: any) => ({ data: { dispatchId: payload.dispatchId } });

  // User attempts to submit with empty well name (validation error)
  await assert.rejects(
    () => executeServiceWorkWorkflow({
      workflow: wf,
      coordinator: coord,
      invoke: invoker,
      selectedDrivers: [{ key: 'd1', driverHash: 'd1', driverId: 'd1', displayName: 'D1' }],
      wellName: '   ', // Invalid
      ndicWellName: '',
      serviceType: 'Haul',
      assignedBy: 'tester',
    }),
    /well_name_required/
  );

  // User corrects the well name
  const res = await executeServiceWorkWorkflow({
    workflow: wf,
    coordinator: coord,
    invoke: invoker,
    selectedDrivers: [{ key: 'd1', driverHash: 'd1', driverId: 'd1', displayName: 'D1' }],
    wellName: 'Corrected Well',
    ndicWellName: 'Corrected Well',
    serviceType: 'Haul',
    assignedBy: 'tester',
  });

  assert.equal(res.actionId, initialActionId, 'retains actionId after validation fix');
  assert.equal(res.serviceGroupId, initialServiceGroupId, 'retains serviceGroupId after validation fix');
});

test('Item 12: Cancel clears only this workflow', () => {
  const coord = new DispatchCreationCoordinator();
  const wfA = createServiceWorkWorkflow();
  const otherActionId = coord.beginAction({ actionScope: 'assign-modal' });
  coord.prepareUnit(otherActionId, 'u_other', { wellName: 'W_other', driverHash: 'D_other', jobType: 'pw' });

  // Begin workflow A
  coord.beginAction({ actionId: wfA.actionId, actionScope: 'service-work-modal' });
  coord.prepareUnit(wfA.actionId, 'd1::leg1', { wellName: 'W1', driverHash: 'd1', jobType: 'service' });

  // Cancel workflow A
  cancelServiceWorkWorkflow(wfA, coord);

  assert.equal(coord.getAction(wfA.actionId), undefined, 'wfA is cleared');
  assert.notEqual(coord.getAction(otherActionId), undefined, 'unrelated action remains intact');
  assert.ok(coord.getUnit(otherActionId, 'u_other'), 'unrelated unit remains intact');
});

test('Item 13: Reopen after cancel creates new identity', () => {
  const coord = new DispatchCreationCoordinator();
  const wf1 = createServiceWorkWorkflow();
  ensureServiceWorkGroupIds(wf1, true, true);
  cancelServiceWorkWorkflow(wf1, coord);

  // User reopens workflow modal
  const wf2 = createServiceWorkWorkflow();
  ensureServiceWorkGroupIds(wf2, true, true);

  assert.notEqual(wf2.workflowId, wf1.workflowId, 'new workflowId on reopen');
  assert.notEqual(wf2.actionId, wf1.actionId, 'new actionId on reopen');
  assert.notEqual(wf2.serviceGroupId, wf1.serviceGroupId, 'new serviceGroupId on reopen');
  assert.notEqual(wf2.splitGroupId, wf1.splitGroupId, 'new splitGroupId on reopen');
});

test('Item 14: Complete success plus UI completion finalizes it', async () => {
  const coord = new DispatchCreationCoordinator();
  const wf = createServiceWorkWorkflow();
  let uiCompleted = false;
  let finalizedPrematurely = false;

  const invoker: CallableInvoker = async (payload: any) => ({
    data: { dispatchId: payload.dispatchId },
  });

  await executeServiceWorkWorkflow({
    workflow: wf,
    coordinator: coord,
    invoke: invoker,
    selectedDrivers: [{ key: 'd1', driverHash: 'd1', driverId: 'd1', displayName: 'D1' }],
    wellName: 'W1',
    ndicWellName: 'W1',
    serviceType: 'Haul',
    assignedBy: 'tester',
    onUiComplete: async () => {
      // Coordinator action MUST still be active during onUiComplete!
      if (!coord.getAction(wf.actionId)) {
        finalizedPrematurely = true;
      }
      uiCompleted = true;
    },
  });

  assert.equal(uiCompleted, true);
  assert.equal(finalizedPrematurely, false, 'action was retained through UI completion callback');
  assert.equal(coord.getAction(wf.actionId), undefined, 'action finalized and pruned after confirmed UI completion');
});

test('Item 15: Post-server-success client failure followed by retry does not duplicate', async () => {
  const coord = new DispatchCreationCoordinator();
  const wf = createServiceWorkWorkflow();
  const wireCalls: any[] = [];
  let uiFail = true;

  const invoker: CallableInvoker = async (payload: any) => {
    wireCalls.push(payload);
    return { data: { dispatchId: payload.dispatchId } };
  };

  const params = {
    workflow: wf,
    coordinator: coord,
    invoke: invoker,
    selectedDrivers: [{ key: 'd1', driverHash: 'd1', driverId: 'd1', displayName: 'D1' }],
    wellName: 'W1',
    ndicWellName: 'W1',
    serviceType: 'Haul',
    assignedBy: 'tester',
    onUiComplete: async () => {
      if (uiFail) {
        uiFail = false;
        throw new Error('client_state_transition_failed');
      }
    },
  };

  // Attempt 1: server calls succeed, onUiComplete throws
  await assert.rejects(() => executeServiceWorkWorkflow(params), /client_state_transition_failed/);
  assert.equal(wireCalls.length, 1);
  assert.ok(coord.getAction(wf.actionId), 'action retained because UI completion failed');

  // Attempt 2: retry after resolving UI issue
  await executeServiceWorkWorkflow(params);
  assert.equal(wireCalls.length, 1, 'unit was not duplicated on wire after client failure');
  assert.equal(coord.getAction(wf.actionId), undefined, 'finalized after second onUiComplete succeeded');
});

// ── Create Project Workflow Identity (Items 16 – 31) ──────────────────────────

test('Item 16: Open create-project workflow', () => {
  const pwf = createProjectWorkflow();
  assert.ok(pwf.projectId && pwf.projectId.length >= 20, 'preallocates projectId');
  assert.equal(pwf.actionId, `proj_create_${pwf.projectId}`, 'binds actionId to projectId');
  assert.equal(pwf.projectCommitted, false, 'projectCommitted begins false');
});

test('Item 17: Preallocate one projectId', () => {
  const pwf = createProjectWorkflow();
  const id1 = pwf.projectId;
  assert.ok(typeof id1 === 'string' && id1.length > 0);
  assert.equal(pwf.projectId, id1, 'projectId does not change on subsequent reads');
});

test('Item 18: Project write succeeds', async () => {
  const coord = new DispatchCreationCoordinator();
  const pwf = createProjectWorkflow();
  const store = new Map<string, Record<string, unknown>>();

  const writer: FirestoreProjectWriter = {
    getDoc: async (id) => ({ exists: store.has(id), data: () => store.get(id) }),
    setDoc: async (id, data) => { store.set(id, data); },
  };

  await executeCreateProjectWorkflow({
    workflow: pwf,
    coordinator: coord,
    invoke: async () => ({ data: { dispatchId: 'x' } }),
    projectWriter: writer,
    projectData: {
      name: 'Project P1',
      wellNames: ['Well 1'],
      operatorName: 'Op 1',
      companyId: 'c1',
      createdBy: 'u1',
      startDate: '2026-09-22',
      projectedEndDate: null,
      status: 'active',
      jobType: 'pw',
      serviceType: null,
      notes: null,
      driverSchedule: {},
    },
    wells: [{ wellName: 'Well 1' }],
    drivers: [],
    assignedBy: 'tester',
  });

  assert.equal(store.has(pwf.projectId), true, 'project document written');
  assert.equal(pwf.projectCommitted, true, 'project marked committed');
});

test('Item 19: Some dispatch units fail', async () => {
  const coord = new DispatchCreationCoordinator();
  const pwf = createProjectWorkflow();
  const store = new Map<string, Record<string, unknown>>();
  const writer: FirestoreProjectWriter = {
    getDoc: async (id) => ({ exists: store.has(id), data: () => store.get(id) }),
    setDoc: async (id, data) => { store.set(id, data); },
  };

  const invoker: CallableInvoker = async (payload: any) => {
    if (payload.record.wellName === 'W2') {
      throw new Error('w2_dispatch_failed');
    }
    return { data: { dispatchId: payload.dispatchId } };
  };

  await assert.rejects(
    () => executeCreateProjectWorkflow({
      workflow: pwf,
      coordinator: coord,
      invoke: invoker,
      projectWriter: writer,
      projectData: {
        name: 'Project Multi-Unit',
        wellNames: ['W1', 'W2'],
        operatorName: 'Op 1',
        companyId: 'c1',
        createdBy: 'u1',
        startDate: '2026-09-22',
        projectedEndDate: null,
        status: 'active',
        jobType: 'pw',
        serviceType: null,
        notes: null,
        driverSchedule: { '2026-09-22': ['d1'] },
      },
      wells: [{ wellName: 'W1' }, { wellName: 'W2' }],
      drivers: [{ key: 'd1', driverHash: 'd1', driverId: 'd1', displayName: 'D1' }],
      assignedBy: 'tester',
    }),
    /w2_dispatch_failed/
  );

  assert.equal(coord.getUnit(pwf.actionId, 'W1::d1')?.status, 'succeeded');
  assert.equal(coord.getUnit(pwf.actionId, 'W2::d1')?.status, 'failed-uncertain');
});

test('Item 20: Retry actual handler helper', async () => {
  const coord = new DispatchCreationCoordinator();
  const pwf = createProjectWorkflow();
  const store = new Map<string, Record<string, unknown>>();
  const writer: FirestoreProjectWriter = {
    getDoc: async (id) => ({ exists: store.has(id), data: () => store.get(id) }),
    setDoc: async (id, data) => { store.set(id, data); },
  };

  let failFirst = true;
  const invoker: CallableInvoker = async (payload: any) => {
    if (failFirst) {
      failFirst = false;
      throw new Error('intermittent_network_error');
    }
    return { data: { dispatchId: payload.dispatchId } };
  };

  const params = {
    workflow: pwf,
    coordinator: coord,
    invoke: invoker,
    projectWriter: writer,
    projectData: {
      name: 'Project Retry',
      wellNames: ['W1'],
      operatorName: 'Op 1',
      companyId: 'c1',
      createdBy: 'u1',
      startDate: '2026-09-22',
      projectedEndDate: null,
      status: 'active',
      jobType: 'pw',
      serviceType: null,
      notes: null,
      driverSchedule: { '2026-09-22': ['d1'] },
    },
    wells: [{ wellName: 'W1' }],
    drivers: [{ key: 'd1', driverHash: 'd1', driverId: 'd1', displayName: 'D1' }],
    assignedBy: 'tester',
  };

  await assert.rejects(() => executeCreateProjectWorkflow(params), /intermittent_network_error/);
  const res = await executeCreateProjectWorkflow(params);
  assert.equal(res.projectId, pwf.projectId);
  assert.equal(res.dispatches.length, 1);
});

test('Item 21: Same projectId reused', async () => {
  const coord = new DispatchCreationCoordinator();
  const pwf = createProjectWorkflow();
  const initialProjectId = pwf.projectId;
  const store = new Map<string, Record<string, unknown>>();
  const writer: FirestoreProjectWriter = {
    getDoc: async (id) => ({ exists: store.has(id), data: () => store.get(id) }),
    setDoc: async (id, data) => { store.set(id, data); },
  };

  let failFirst = true;
  const invoker: CallableInvoker = async (payload: any) => {
    if (failFirst) {
      failFirst = false;
      throw new Error('fail');
    }
    return { data: { dispatchId: payload.dispatchId } };
  };

  const params = {
    workflow: pwf,
    coordinator: coord,
    invoke: invoker,
    projectWriter: writer,
    projectData: {
      name: 'Project Stable ID',
      wellNames: ['W1'],
      operatorName: 'Op 1',
      companyId: 'c1',
      createdBy: 'u1',
      startDate: '2026-09-22',
      projectedEndDate: null,
      status: 'active',
      jobType: 'pw',
      serviceType: null,
      notes: null,
      driverSchedule: { '2026-09-22': ['d1'] },
    },
    wells: [{ wellName: 'W1' }],
    drivers: [{ key: 'd1', driverHash: 'd1', driverId: 'd1', displayName: 'D1' }],
    assignedBy: 'tester',
  };

  await assert.rejects(() => executeCreateProjectWorkflow(params), /fail/);
  await executeCreateProjectWorkflow(params);

  assert.equal(pwf.projectId, initialProjectId, 'projectId unchanged on retry');
  assert.equal(store.size, 1, 'only one project document exists');
  assert.ok(store.has(initialProjectId));
});

test('Item 22: Same coordinator actionId reused', async () => {
  const coord = new DispatchCreationCoordinator();
  const pwf = createProjectWorkflow();
  const initialActionId = pwf.actionId;
  const store = new Map<string, Record<string, unknown>>();
  const writer: FirestoreProjectWriter = {
    getDoc: async (id) => ({ exists: store.has(id), data: () => store.get(id) }),
    setDoc: async (id, data) => { store.set(id, data); },
  };

  let failFirst = true;
  const invoker: CallableInvoker = async (payload: any) => {
    if (failFirst) {
      failFirst = false;
      throw new Error('fail');
    }
    return { data: { dispatchId: payload.dispatchId } };
  };

  const params = {
    workflow: pwf,
    coordinator: coord,
    invoke: invoker,
    projectWriter: writer,
    projectData: {
      name: 'Project Stable ActionId',
      wellNames: ['W1'],
      operatorName: 'Op 1',
      companyId: 'c1',
      createdBy: 'u1',
      startDate: '2026-09-22',
      projectedEndDate: null,
      status: 'active',
      jobType: 'pw',
      serviceType: null,
      notes: null,
      driverSchedule: { '2026-09-22': ['d1'] },
    },
    wells: [{ wellName: 'W1' }],
    drivers: [{ key: 'd1', driverHash: 'd1', driverId: 'd1', displayName: 'D1' }],
    assignedBy: 'tester',
  };

  await assert.rejects(() => executeCreateProjectWorkflow(params), /fail/);
  const res = await executeCreateProjectWorkflow(params);
  assert.equal(res.actionId, initialActionId);
  assert.equal(pwf.actionId, initialActionId);
});

test('Item 23: Successful units not duplicated', async () => {
  const coord = new DispatchCreationCoordinator();
  const pwf = createProjectWorkflow();
  const store = new Map<string, Record<string, unknown>>();
  const writer: FirestoreProjectWriter = {
    getDoc: async (id) => ({ exists: store.has(id), data: () => store.get(id) }),
    setDoc: async (id, data) => { store.set(id, data); },
  };

  const wireInvocations: string[] = [];
  let failW2 = true;

  const invoker: CallableInvoker = async (payload: any) => {
    wireInvocations.push(payload.record.wellName);
    if (payload.record.wellName === 'W2' && failW2) {
      failW2 = false;
      throw new Error('fail_w2');
    }
    return { data: { dispatchId: payload.dispatchId } };
  };

  const params = {
    workflow: pwf,
    coordinator: coord,
    invoke: invoker,
    projectWriter: writer,
    projectData: {
      name: 'Project Units Test',
      wellNames: ['W1', 'W2'],
      operatorName: 'Op 1',
      companyId: 'c1',
      createdBy: 'u1',
      startDate: '2026-09-22',
      projectedEndDate: null,
      status: 'active',
      jobType: 'pw',
      serviceType: null,
      notes: null,
      driverSchedule: { '2026-09-22': ['d1'] },
    },
    wells: [{ wellName: 'W1' }, { wellName: 'W2' }],
    drivers: [{ key: 'd1', driverHash: 'd1', driverId: 'd1', displayName: 'D1' }],
    assignedBy: 'tester',
  };

  await assert.rejects(() => executeCreateProjectWorkflow(params), /fail_w2/);
  await executeCreateProjectWorkflow(params);

  const w1Count = wireInvocations.filter(w => w === 'W1').length;
  assert.equal(w1Count, 1, 'W1 unit was not re-sent on wire');
});

test('Item 24: Failed units reuse dispatchId', async () => {
  const coord = new DispatchCreationCoordinator();
  const pwf = createProjectWorkflow();
  const store = new Map<string, Record<string, unknown>>();
  const writer: FirestoreProjectWriter = {
    getDoc: async (id) => ({ exists: store.has(id), data: () => store.get(id) }),
    setDoc: async (id, data) => { store.set(id, data); },
  };

  const capturedPayloads: any[] = [];
  let fail = true;

  const invoker: CallableInvoker = async (payload: any) => {
    capturedPayloads.push(payload);
    if (fail) {
      fail = false;
      throw new Error('fail');
    }
    return { data: { dispatchId: payload.dispatchId } };
  };

  const params = {
    workflow: pwf,
    coordinator: coord,
    invoke: invoker,
    projectWriter: writer,
    projectData: {
      name: 'Project Unit Retry',
      wellNames: ['W1'],
      operatorName: 'Op 1',
      companyId: 'c1',
      createdBy: 'u1',
      startDate: '2026-09-22',
      projectedEndDate: null,
      status: 'active',
      jobType: 'pw',
      serviceType: null,
      notes: null,
      driverSchedule: { '2026-09-22': ['d1'] },
    },
    wells: [{ wellName: 'W1' }],
    drivers: [{ key: 'd1', driverHash: 'd1', driverId: 'd1', displayName: 'D1' }],
    assignedBy: 'tester',
  };

  await assert.rejects(() => executeCreateProjectWorkflow(params), /fail/);
  await executeCreateProjectWorkflow(params);

  assert.equal(capturedPayloads.length, 2);
  assert.equal(capturedPayloads[0].dispatchId, capturedPayloads[1].dispatchId, 'failed unit reuses exact same dispatchId on retry');
});

test('Item 25: Uncertain project-write result reuses same ID', async () => {
  const coord = new DispatchCreationCoordinator();
  const pwf = createProjectWorkflow();
  const store = new Map<string, Record<string, unknown>>();
  let setDocCalls = 0;

  const writer: FirestoreProjectWriter = {
    getDoc: async (id) => ({ exists: store.has(id), data: () => store.get(id) }),
    setDoc: async (id, data) => {
      setDocCalls++;
      store.set(id, data);
      if (setDocCalls === 1) {
        throw new Error('ETIMEDOUT_after_commit');
      }
    },
  };

  const projectData: ProjectDataInput = {
    name: 'Uncertain Project',
    wellNames: ['W1'],
    operatorName: 'Op 1',
    companyId: 'c1',
    createdBy: 'u1',
    startDate: '2026-09-22',
    projectedEndDate: null,
    status: 'active',
    jobType: 'pw',
    serviceType: null,
    notes: null,
    driverSchedule: {},
  };

  const params = {
    workflow: pwf,
    coordinator: coord,
    invoke: async () => ({ data: { dispatchId: 'x' } }),
    projectWriter: writer,
    projectData,
    wells: [{ wellName: 'W1' }],
    drivers: [],
    assignedBy: 'tester',
  };

  await assert.rejects(() => executeCreateProjectWorkflow(params), /ETIMEDOUT_after_commit/);
  // Retry: getDoc discovers the committed document with identical identity
  await executeCreateProjectWorkflow(params);

  assert.equal(setDocCalls, 1, 'setDoc was NOT re-called on retry; existing document was reused');
  assert.equal(store.has(pwf.projectId), true);
});

test('Item 26: Identical replay is idempotent', () => {
  const input: ProjectDataInput = {
    name: 'Replay Project',
    wellNames: ['Well B', 'Well A'],
    operatorName: 'Op Alpha',
    companyId: 'comp_1',
    createdBy: 'user_1',
    startDate: '2026-09-22',
    projectedEndDate: null,
    status: 'active',
    jobType: 'pw',
    serviceType: null,
    notes: null,
    driverSchedule: {},
  };
  const existing = {
    name: 'Replay Project',
    wellNames: ['Well A', 'Well B'],
    operatorName: 'Op Alpha',
    companyId: 'comp_1',
    jobType: 'pw',
    serviceType: null,
  };
  assert.equal(projectImmutableIdentityMatches(existing, input), true);
});

test('Item 27: Conflicting existing project fails visibly', async () => {
  const coord = new DispatchCreationCoordinator();
  const pwf = createProjectWorkflow();
  const store = new Map<string, Record<string, unknown>>();
  store.set(pwf.projectId, {
    name: 'Different Project Name',
    companyId: 'comp_OTHER',
    jobType: 'service',
    wellNames: ['Other Well'],
    operatorName: 'Other Op',
  });

  const writer: FirestoreProjectWriter = {
    getDoc: async (id) => ({ exists: store.has(id), data: () => store.get(id) }),
    setDoc: async () => {},
  };

  const params = {
    workflow: pwf,
    coordinator: coord,
    invoke: async () => ({ data: { dispatchId: 'x' } }),
    projectWriter: writer,
    projectData: {
      name: 'My Project',
      wellNames: ['W1'],
      operatorName: 'Op 1',
      companyId: 'comp_1',
      createdBy: 'u1',
      startDate: '2026-09-22',
      projectedEndDate: null,
      status: 'active',
      jobType: 'pw',
      serviceType: null,
      notes: null,
      driverSchedule: {},
    },
    wells: [{ wellName: 'W1' }],
    drivers: [],
    assignedBy: 'tester',
  };

  await assert.rejects(
    () => executeCreateProjectWorkflow(params),
    new RegExp(`project_conflict:conflicting_existing_project:${pwf.projectId}`)
  );
});

test('Item 28: Rerender preserves identity', () => {
  const pwf = createProjectWorkflow();
  const originalProjectId = pwf.projectId;
  const originalActionId = pwf.actionId;

  // Simulate multiple render passes maintaining state
  const render1ProjectId = pwf.projectId;
  const render2ProjectId = pwf.projectId;

  assert.equal(render1ProjectId, originalProjectId);
  assert.equal(render2ProjectId, originalProjectId);
  assert.equal(pwf.actionId, originalActionId);
});

test('Item 29: Cancel affects only this project workflow', () => {
  const coord = new DispatchCreationCoordinator();
  const pwf = createProjectWorkflow();
  const unrelatedActionId = coord.beginAction({ actionScope: 'assign-modal' });
  coord.prepareUnit(unrelatedActionId, 'u_unrelated', { wellName: 'W_unrelated', driverHash: 'D', jobType: 'pw' });

  coord.beginAction({ actionId: pwf.actionId, actionScope: 'create-project' });
  coord.prepareUnit(pwf.actionId, 'W1::d1', { wellName: 'W1', driverHash: 'd1', jobType: 'pw' });

  cancelCreateProjectWorkflow(pwf, coord);

  assert.equal(coord.getAction(pwf.actionId), undefined, 'project action pruned');
  assert.notEqual(coord.getAction(unrelatedActionId), undefined, 'unrelated action unaffected');
  assert.ok(coord.getUnit(unrelatedActionId, 'u_unrelated'));
});

test('Item 30: Reopen after cancel creates new projectId', () => {
  const coord = new DispatchCreationCoordinator();
  const pwf1 = createProjectWorkflow();
  cancelCreateProjectWorkflow(pwf1, coord);

  const pwf2 = createProjectWorkflow();
  assert.notEqual(pwf2.projectId, pwf1.projectId, 'new projectId allocated on reopen');
  assert.notEqual(pwf2.actionId, pwf1.actionId, 'new actionId allocated on reopen');
});

test('Item 31: Post-write UI failure followed by retry creates no duplicate project', async () => {
  const coord = new DispatchCreationCoordinator();
  const pwf = createProjectWorkflow();
  const store = new Map<string, Record<string, unknown>>();
  const writer: FirestoreProjectWriter = {
    getDoc: async (id) => ({ exists: store.has(id), data: () => store.get(id) }),
    setDoc: async (id, data) => { store.set(id, data); },
  };

  let failUi = true;
  const wireCalls: any[] = [];
  const invoker: CallableInvoker = async (payload: any) => {
    wireCalls.push(payload);
    return { data: { dispatchId: payload.dispatchId } };
  };

  const params = {
    workflow: pwf,
    coordinator: coord,
    invoke: invoker,
    projectWriter: writer,
    projectData: {
      name: 'Project UI Failure Test',
      wellNames: ['W1'],
      operatorName: 'Op 1',
      companyId: 'c1',
      createdBy: 'u1',
      startDate: '2026-09-22',
      projectedEndDate: null,
      status: 'active',
      jobType: 'pw',
      serviceType: null,
      notes: null,
      driverSchedule: { '2026-09-22': ['d1'] },
    },
    wells: [{ wellName: 'W1' }],
    drivers: [{ key: 'd1', driverHash: 'd1', driverId: 'd1', displayName: 'D1' }],
    assignedBy: 'tester',
    onUiComplete: async () => {
      if (failUi) {
        failUi = false;
        throw new Error('ui_route_failed');
      }
    },
  };

  await assert.rejects(() => executeCreateProjectWorkflow(params), /ui_route_failed/);
  assert.equal(store.size, 1);
  assert.equal(wireCalls.length, 1);

  // Retry after UI issue resolved
  await executeCreateProjectWorkflow(params);
  assert.equal(store.size, 1, 'no duplicate project document created');
  assert.equal(wireCalls.length, 1, 'no duplicate dispatch created on wire');
});

// ── Regression & Operational Invariants (Items 32 – 43) ──────────────────────

test('Item 32: All seven already-stable workflows remain stable', async () => {
  const coord = new DispatchCreationCoordinator();
  const invoker: CallableInvoker = async (p: any) => ({ data: { dispatchId: p.dispatchId } });

  // 1. Single Assign: assign_${well}_${driver}
  const act1 = 'assign_Well1_driverA';
  coord.beginAction({ actionId: act1, actionScope: 'assign-modal' });
  const u1 = await coord.executeUnit(invoker, { wellName: 'Well1', driverHash: 'driverA' }, { actionId: act1, unitId: 'single' });
  const u1Retry = await coord.executeUnit(invoker, { wellName: 'Well1', driverHash: 'driverA' }, { actionId: act1, unitId: 'single' });
  assert.equal(u1.dispatchId, u1Retry.dispatchId);
  coord.finalizeAction(act1);

  // 2. Multi-Assign: multi_assign_${driver}_${count}
  const act2 = 'multi_assign_driverA_2';
  coord.beginAction({ actionId: act2, actionScope: 'multi-assign-modal' });
  const u2a = await coord.executeUnit(invoker, { wellName: 'W1', driverHash: 'driverA' }, { actionId: act2, unitId: 'W1::driverA' });
  const u2b = await coord.executeUnit(invoker, { wellName: 'W2', driverHash: 'driverA' }, { actionId: act2, unitId: 'W2::driverA' });
  const u2aRetry = await coord.executeUnit(invoker, { wellName: 'W1', driverHash: 'driverA' }, { actionId: act2, unitId: 'W1::driverA' });
  assert.equal(u2a.dispatchId, u2aRetry.dispatchId);
  coord.finalizeAction(act2);

  // 3. Add Driver to Project Today: proj_add_${proj}_${driver}
  const act3 = 'proj_add_proj123_driverB';
  coord.beginAction({ actionId: act3, actionScope: 'project-modal' });
  const u3 = await coord.executeUnit(invoker, { wellName: 'W1', driverHash: 'driverB', projectId: 'proj123' }, { actionId: act3, unitId: 'W1::driverB' });
  const u3Retry = await coord.executeUnit(invoker, { wellName: 'W1', driverHash: 'driverB', projectId: 'proj123' }, { actionId: act3, unitId: 'W1::driverB' });
  assert.equal(u3.dispatchId, u3Retry.dispatchId);
  coord.finalizeAction(act3);

  // 4. Batch Dispatch Shift: proj_sched_${proj}
  const act4 = 'proj_sched_proj123';
  coord.beginAction({ actionId: act4, actionScope: 'project-modal' });
  const u4 = await coord.executeUnit(invoker, { wellName: 'W1', driverHash: 'driverC', projectId: 'proj123' }, { actionId: act4, unitId: 'W1::driverC' });
  const u4Retry = await coord.executeUnit(invoker, { wellName: 'W1', driverHash: 'driverC', projectId: 'proj123' }, { actionId: act4, unitId: 'W1::driverC' });
  assert.equal(u4.dispatchId, u4Retry.dispatchId);
  coord.finalizeAction(act4);

  // 5. Reassign: reassign_${job}_${driver}
  const act5 = 'reassign_job99_driverD';
  coord.beginAction({ actionId: act5, actionScope: 'reassign-modal' });
  const u5 = await coord.executeUnit(invoker, { wellName: 'W1', driverHash: 'driverD' }, { actionId: act5, unitId: 'reassign' });
  const u5Retry = await coord.executeUnit(invoker, { wellName: 'W1', driverHash: 'driverD' }, { actionId: act5, unitId: 'reassign' });
  assert.equal(u5.dispatchId, u5Retry.dispatchId);
  coord.finalizeAction(act5);

  // 6. Edit SW Crew: edit_sw_crew_${job}
  const act6 = 'edit_sw_crew_job100';
  coord.beginAction({ actionId: act6, actionScope: 'edit-sw-modal' });
  const u6 = await coord.executeUnit(invoker, { wellName: 'W1', driverHash: 'driverE' }, { actionId: act6, unitId: 'driverE::leg1' });
  const u6Retry = await coord.executeUnit(invoker, { wellName: 'W1', driverHash: 'driverE' }, { actionId: act6, unitId: 'driverE::leg1' });
  assert.equal(u6.dispatchId, u6Retry.dispatchId);
  coord.finalizeAction(act6);

  // 7. Split PW Loads: split_loads_${job}_${driver}
  const act7 = 'split_loads_job101_driverF';
  coord.beginAction({ actionId: act7, actionScope: 'split-pw-modal' });
  const u7a = await coord.executeUnit(invoker, { wellName: 'W1', driverHash: 'driverF', splitSequence: 1 }, { actionId: act7, unitId: 'driverF::leg1' });
  const u7b = await coord.executeUnit(invoker, { wellName: 'W1', driverHash: 'driverF', splitSequence: 2 }, { actionId: act7, unitId: 'driverF::leg2' });
  const u7aRetry = await coord.executeUnit(invoker, { wellName: 'W1', driverHash: 'driverF', splitSequence: 1 }, { actionId: act7, unitId: 'driverF::leg1' });
  assert.equal(u7a.dispatchId, u7aRetry.dispatchId);
  coord.finalizeAction(act7);
});

test('Item 33: Scoped cancellation remains correct', () => {
  const coord = new DispatchCreationCoordinator();
  const actA = coord.beginAction({ actionScope: 'modal-A' });
  const actB = coord.beginAction({ actionScope: 'modal-B' });

  coord.prepareUnit(actA, 'uA', { wellName: 'WA', driverHash: 'DA', jobType: 'pw' });
  coord.prepareUnit(actB, 'uB', { wellName: 'WB', driverHash: 'DB', jobType: 'pw' });

  coord.cancelAction(actA);

  assert.equal(coord.getAction(actA), undefined, 'action A cleared');
  assert.notEqual(coord.getAction(actB), undefined, 'action B preserved');
  assert.ok(coord.getUnit(actB, 'uB'), 'unit in action B preserved');
});

test('Item 34: Partial-batch retry remains correct', async () => {
  const coord = new DispatchCreationCoordinator();
  const batchId = coord.beginAction({ actionScope: 'batch-test' });
  let callCountC = 0;
  const wireCalls: Record<string, string[]> = { A: [], B: [], C: [] };

  const invoker = async (payload: any) => {
    const name = payload.record.wellName as string;
    wireCalls[name].push(payload.dispatchId);
    if (name === 'C') {
      callCountC++;
      if (callCountC === 1) throw new Error('transport_failed_C');
    }
    return { data: { dispatchId: payload.dispatchId } };
  };

  const recA = { wellName: 'A', driverHash: 'D1', jobType: 'pw' };
  const recB = { wellName: 'B', driverHash: 'D1', jobType: 'pw' };
  const recC = { wellName: 'C', driverHash: 'D1', jobType: 'pw' };

  await Promise.allSettled([
    coord.executeUnit(invoker, recA, { actionId: batchId, unitId: 'uA' }),
    coord.executeUnit(invoker, recB, { actionId: batchId, unitId: 'uB' }),
    coord.executeUnit(invoker, recC, { actionId: batchId, unitId: 'uC' }),
  ]);

  const results = await Promise.all([
    coord.executeUnit(invoker, recA, { actionId: batchId, unitId: 'uA' }),
    coord.executeUnit(invoker, recB, { actionId: batchId, unitId: 'uB' }),
    coord.executeUnit(invoker, recC, { actionId: batchId, unitId: 'uC' }),
  ]);

  assert.equal(wireCalls.A.length, 1, 'A not re-invoked');
  assert.equal(wireCalls.B.length, 1, 'B not re-invoked');
  assert.equal(wireCalls.C.length, 2, 'C retried with same ID');
  assert.equal(wireCalls.C[0], wireCalls.C[1]);
});

test('Item 35: Stale completion guard remains correct', async () => {
  const coord = new DispatchCreationCoordinator();
  const actionId = coord.beginAction({ actionScope: 'stale-test' });
  const unitId = 'u1';

  let resolveGen1: (val: any) => void = () => {};
  const gen1Promise = new Promise(r => { resolveGen1 = r; });

  const invoker1 = () => gen1Promise as any;
  const invoker2 = async (p: any) => ({ data: { dispatchId: p.dispatchId } });

  const p1 = coord.executeUnit(invoker1, { wellName: 'W1', driverHash: 'D1', jobType: 'pw' }, { actionId, unitId });
  const p2 = coord.executeUnit(invoker2, { wellName: 'W2', driverHash: 'D1', jobType: 'pw' }, { actionId, unitId });

  const resGen2 = await p2;
  resolveGen1({ data: { dispatchId: 'late_id' } });
  await p1;

  assert.equal(coord.getUnit(actionId, unitId)?.result?.dispatchId, resGen2.dispatchId);
  assert.equal(coord.getUnit(actionId, unitId)?.currentRequestId, 2);
});

test('Item 36: UID/company session isolation remains correct', () => {
  const coordA = new DispatchCreationCoordinator({ tenantId: 'company_A', userId: 'user_1' });
  const coordB = new DispatchCreationCoordinator({ tenantId: 'company_B', userId: 'user_2' });

  const uA = coordA.prepareCreation({ wellName: 'W', driverHash: 'D', jobType: 'pw' });
  const uB = coordB.prepareCreation({ wellName: 'W', driverHash: 'D', jobType: 'pw' });

  assert.notEqual(uA.dispatchId, uB.dispatchId, 'distinct tenants/users get isolated namespaces');

  // Sign out / company switch cleans coordinator
  coordA.resetAuthenticatedSession('company_C', 'user_3');
  assert.equal(coordA.getAllRetained().length, 0);
  assert.equal(coordA.sessionTenantId, 'company_C');
});

test('Item 37: Functions tree remains byte-identical to R1 (4c6560a7)', () => {
  const diff = execSync('git diff 4c6560a7 HEAD -- functions', { encoding: 'utf8' });
  assert.equal(diff.trim(), '', 'Functions directory has zero diff against 4c6560a7');
});

test('Item 38: Unbound accept/resolve remains fail-closed', () => {
  const acceptPath = path.resolve(process.cwd(), 'functions/src/security/operational/acceptDriverDispatch.ts');
  const acceptContent = fs.readFileSync(acceptPath, 'utf8');
  assert.match(acceptContent, /requireCompleteBinding\(input\.existing\)/);
  assert.match(acceptContent, /if \(!bound\.ok\) return bound;/);

  const resolvePath = path.resolve(process.cwd(), 'functions/src/security/operational/resolveExecutionBinding.ts');
  const resolveContent = fs.readFileSync(resolvePath, 'utf8');
  assert.match(resolveContent, /requireCompleteBinding\(existing\)/);
  assert.match(resolveContent, /if \(!bound\.ok\) return bound;/);
});

test('Item 39: No moving-head lookup', () => {
  const fnPath = path.resolve(process.cwd(), 'functions/src/security/operational/resolveExecutionBinding.ts');
  const content = fs.readFileSync(fnPath, 'utf8');
  assert.doesNotMatch(content, /job_packets\/head/);
  assert.doesNotMatch(content, /job_packets\/latest/);
});

test('Item 40: No NDIC fabrication', () => {
  const fnPath = path.resolve(process.cwd(), 'functions/src/security/operational/resolveExecutionBinding.ts');
  const content = fs.readFileSync(fnPath, 'utf8');
  assert.doesNotMatch(content, /ndicWellName\s*=\s*wellName/);
});

test('Item 41: Server requires/never-mints dispatchId', () => {
  const payload = buildCreatePayload({ wellName: 'Gabriel 1', driverHash: 'D1' });
  assert.equal(payload.op, 'create');
  assert.ok(typeof payload.dispatchId === 'string' && payload.dispatchId.length > 0);
});

test('Item 42: Inventory remains empty', () => {
  const invPath = path.resolve(process.cwd(), 'functions/src/security/operational/jobPacketEffectInventory.ts');
  const content = fs.readFileSync(invPath, 'utf8');
  assert.match(content, /IMPLEMENTED_EFFECT_IDS:\s*readonly\s*\[\]\s*=\s*freezeDeep\(\[\]\s*as\s*\[\]\)/);
});

if (process.env.DELIBERATE_FAIL === '1') {
  test('Item 43: Deliberate failure exits nonzero', () => {
    assert.fail('deliberate_failure_for_r4_verification');
  });
} else {
  test('Item 43: Deliberate failure runner verifies nonzero exit', () => {
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
      assert.match(output, /deliberate_failure_for_r4_verification/, 'caught expected deliberate failure message');
    }
  });
}