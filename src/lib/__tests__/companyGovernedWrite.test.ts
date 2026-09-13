/**
 * RUNTIME test for the Phase-5A governed company-write migration.
 *
 * Proves the CLIENT adapter contract for adminUpdateCompanySafe by executing the
 * firebase-free adminContractServiceCore through a MOCK invoker: the exact
 * callable name + `{companyId, fields}` payload, and that a callable rejection
 * propagates to the caller (so the CompaniesTab handlers' try/catch surfaces it).
 *
 * The DEPLOYED callable is platform-admin-only (functions requireAdmin →
 * wellbuiltAdmin claim + platform_admins/{uid} record). That is why only
 * genuinely platform-admin (isWbAdmin) company-field writes were migrated; tenant
 * controls keep their existing path. No Firebase, no network, no production call.
 *
 * Run: node --test --experimental-strip-types src/lib/__tests__/companyGovernedWrite.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdminContractServiceCore } from '../adminContractServiceCore.ts';

function mock() {
  const calls: Array<{ name: string; input: unknown }> = [];
  const svc = createAdminContractServiceCore(async (name: string, input: unknown) => {
    calls.push({ name, input });
    return { companyId: (input as { companyId: string }).companyId, changedFields: Object.keys((input as { fields: object }).fields) } as never;
  });
  return { svc, calls };
}

test('updateCompanySafe targets adminUpdateCompanySafe with exact {companyId, fields}', async () => {
  const m = mock();
  await m.svc.updateCompanySafe({ companyId: 'liquid-gold', fields: { tier: 'pro' } });
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0].name, 'adminUpdateCompanySafe');
  assert.deepEqual(m.calls[0].input, { companyId: 'liquid-gold', fields: { tier: 'pro' } });
});

test('updateCompanySafe carries the exact migrated field payloads (operators/rate/pay)', async () => {
  const m = mock();
  await m.svc.updateCompanySafe({ companyId: 'c1', fields: { assignedOperators: ['Acme', 'Bravo'] } });
  await m.svc.updateCompanySafe({ companyId: 'c1', fields: { rateSheets: { Acme: [{ jobType: 'pw', rate: 5 }] } } });
  await m.svc.updateCompanySafe({ companyId: 'c1', fields: { payConfig: { defaultSplit: 0.25 } } });
  assert.deepEqual(m.calls.map((c) => c.name), ['adminUpdateCompanySafe', 'adminUpdateCompanySafe', 'adminUpdateCompanySafe']);
  assert.deepEqual((m.calls[0].input as { fields: unknown }).fields, { assignedOperators: ['Acme', 'Bravo'] });
  assert.deepEqual((m.calls[1].input as { fields: unknown }).fields, { rateSheets: { Acme: [{ jobType: 'pw', rate: 5 }] } });
  assert.deepEqual((m.calls[2].input as { fields: unknown }).fields, { payConfig: { defaultSplit: 0.25 } });
});

test('a callable rejection propagates to the caller (→ handler catch → visible UI)', async () => {
  const svc = createAdminContractServiceCore(async () => { throw new Error('permission-denied'); });
  await assert.rejects(() => svc.updateCompanySafe({ companyId: 'c1', fields: { tier: 'pro' } }), /permission-denied/);
});
