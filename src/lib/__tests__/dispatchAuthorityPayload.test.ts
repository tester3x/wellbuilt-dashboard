import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCreatePayload, buildUpdatePayload, jsonSafe } from '../staffWriteDispatchCore.ts';

test('PW dispatch omits caller company authority while preserving the intended job', () => {
  const input = {
    dispatchId: 'dispatch-authority-regression',
    companyId: 'company-test',
    assignedAt: '2026-09-27T03:00:00Z',
    wellName: 'TEST WELL 3',
    driverId: 'driver-test',
    disposal: 'TEST DISPOSAL 1',
    loads: 1,
    notes: 'test fixture',
  };
  const before = { ...input };
  const payload = buildCreatePayload(input);
  const record = payload.record as Record<string, unknown>;
  assert.equal(payload.op, 'create');
  assert.equal(Object.hasOwn(record, 'companyId'), false);
  assert.equal(Object.hasOwn(record, 'assignedAt'), false);
  for (const key of ['wellName', 'driverId', 'disposal', 'loads', 'notes'] as const) {
    assert.equal(record[key], input[key]);
  }
  // Company context remains available to the creation coordinator's tenant fence.
  assert.deepEqual(input, before);
});

test('server-owned fields never cross the wire, regardless of value type', () => {
  for (const value of ['company-test', 123, null, false, {}, { seconds: 12 }, { toMillis: () => 12_345 }]) {
    const record = { companyId: value, assignedAt: value, notes: 'keep' };
    assert.deepEqual(jsonSafe(record), { notes: 'keep' });
    assert.deepEqual(buildUpdatePayload('dispatch-existing', record), {
      op: 'update', dispatchId: 'dispatch-existing', record: { notes: 'keep' },
    });
  }
});

test('business timestamps still serialize and decline ownership remains enforced', () => {
  assert.deepEqual(jsonSafe({ scheduledFor: { toMillis: () => 12_345 }, skip: undefined }), {
    scheduledFor: { seconds: 12, nanoseconds: 345_000_000 },
  });
  for (const key of ['declinedAt', 'declineReason', 'declinedBy']) {
    assert.throws(() => jsonSafe({ companyId: 'company-test', [key]: 'caller-value' }),
      new RegExp(`decline_fields_immutable:${key}`));
  }
});
