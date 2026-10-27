import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { reassignmentBlockedReason, reassignmentFailureMessage } from '../dispatchReassignmentNotice';

test('started and paused jobs explain the driver, stage and safe next steps', () => {
  const text = reassignmentBlockedReason({ wellName: 'Example 5', driverName: 'Test Driver', status: 'in_progress', driverStage: 'en_route_pickup' })!;
  for (const expected of ['Example 5', 'Test Driver', 'en route to pickup', 'cancel or return', 'Load Transfer']) assert.ok(text.includes(expected));
  assert.match(reassignmentBlockedReason({ status: 'paused' })!, /paused/);
  for (const status of ['pending', 'accepted', 'declined', 'cancelled']) assert.equal(reassignmentBlockedReason({ status }), null);
  for (const status of ['completed', 'dismissed', 'unknown']) assert.ok(reassignmentBlockedReason({ status }));
  assert.ok(reassignmentBlockedReason(null));
});

test('network and authorization errors explain themselves without claiming the driver started', () => {
  assert.match(reassignmentFailureMessage({ code: 'functions/unavailable' }), /connection/);
  assert.match(reassignmentFailureMessage({ code: 'functions/permission-denied' }), /authorize/);
  assert.match(reassignmentFailureMessage(Error('invalid_transition:accepted->pending')), /changed state/);
  assert.match(reassignmentFailureMessage(Error('unexpected_field:example')), /unexpected_field:example/);
  assert.doesNotMatch(reassignmentFailureMessage({ code: 'functions/unavailable' }), /has already started/);
});

// Execute the actual screen handler, including its catch/finally. A stale modal
// is modeled separately from the current server snapshot; no production writes.
const source = readFileSync('src/app/dispatch/page.tsx', 'utf8');
const ast = ts.createSourceFile('dispatch.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler = '';
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'submitReassign') handler = node.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast); assert.ok(handler);
const js = ts.transpileModule(handler + '\nsubmitReassign;', { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
function harness(status: string, mode = 'in_place', failure?: unknown) {
  const writes: string[] = [], errors: string[] = [], messages: string[] = [], busy: boolean[] = [];
  let finish!: (value: unknown) => void;
  const read = new Promise(resolve => { finish = resolve; });
  const original = { id: 'dispatch-test', wellName: 'Example 5', status: 'pending', driverName: 'Source Driver', loadCount: 1 };
  const scope = {
    reassignJob: original, reassignDriverHash: 'target', reassignMode: mode, reassignLoads: 0,
    drivers: [{ key: 'target', legalName: 'Target Driver', displayName: 'Target Driver' }],
    user: { email: 'office@example.test' }, setReassigning: (value: boolean) => busy.push(value), setReassignError: (value: string) => errors.push(value),
    getFirestoreDb: () => ({}), doc: () => ({}), getDocFromServer: () => read,
    resolveDispatchDriver: () => ({ displayName: 'Source Driver' }), operationalDriverName: () => 'Source Driver',
    reassignmentBlockedReason, reassignmentFailureMessage,
    Timestamp: { now: () => ({}) }, assignmentIdentityForDriver: () => ({ driverId: 'target' }),
    staffUpdateDispatch: async () => { if (failure) throw failure; writes.push('update'); },
    staffCreateDispatch: async () => { writes.push('create'); }, staffCancelDispatch: async () => { writes.push('cancel'); },
    setMessage: (value: string) => messages.push(value), setReassignJob: () => {}, setReassignDriverHash: () => {}, setReassignMode: () => {},
    finalizeAction: () => {}, setTimeout: () => 0,
  };
  const invoke = runInNewContext(js, scope) as () => Promise<void>;
  return { writes, errors, messages, busy, invoke, finish: () => finish({ id: original.id, exists: () => true, data: () => ({ ...original, status }) }) };
}

test('a driver starting after the modal opened blocks both reassignment paths before any write', async () => {
  for (const mode of ['in_place', 'declined']) {
    const h = harness('in_progress', mode), work = h.invoke();
    assert.deepEqual(h.writes, []); h.finish(); await work;
    assert.deepEqual(h.writes, []); assert.match(h.errors.at(-1)!, /Source Driver has already started/);
    assert.deepEqual(h.busy, [true, false]); assert.deepEqual(h.messages, []);
  }
});
test('pending reassignment still uses the existing dispatch and completes after server verification', async () => {
  const h = harness('pending'), work = h.invoke(); assert.deepEqual(h.writes, []);
  h.finish(); await work; assert.deepEqual(h.writes, ['update']); assert.match(h.messages[0], /Reassigned/);
});
test('a server refusal stays in the modal instead of an expiring page banner', async () => {
  const h = harness('pending', 'in_place', Error('invalid_transition:in_progress->pending')), work = h.invoke();
  h.finish(); await work; assert.match(h.errors.at(-1)!, /changed state/); assert.deepEqual(h.messages, []); assert.equal(h.busy.at(-1), false);
});
