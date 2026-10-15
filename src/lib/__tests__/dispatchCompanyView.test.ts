import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canViewGlobalWellPool, canViewGovernedWellPool, docBelongsToTenant, viewedCompanyId } from '../tenantScope.ts';

test('WB owner selection separates Liquid Gold, demo, and all-company jobs', () => {
  const jobs = [
    { id: 'legacy', companyId: undefined },
    { id: 'liquid-gold', companyId: 'liquid-gold' },
    { id: 'demo', companyId: 'wellbuilt-demo' },
  ];
  const visible = (company: string | null) => jobs
    .filter(job => docBelongsToTenant(job.companyId, viewedCompanyId(undefined, company, true)))
    .map(job => job.id);

  assert.deepEqual(visible('liquid-gold'), ['legacy', 'liquid-gold']);
  assert.deepEqual(visible('wellbuilt-demo'), ['demo']);
  assert.deepEqual(visible(null), ['legacy', 'liquid-gold', 'demo']);
});

test('company login cannot show all and unscoped viewer cannot see jobs', () => {
  assert.equal(viewedCompanyId('liquid-gold', null, false), 'liquid-gold');
  assert.equal(viewedCompanyId('liquid-gold', null, true), 'liquid-gold');
  assert.equal(docBelongsToTenant('wellbuilt-demo', viewedCompanyId('liquid-gold', null, false)), false);
  assert.equal(docBelongsToTenant('wellbuilt-demo', viewedCompanyId(undefined, null, false)), false);
});

test('platform owner selection never shows Liquid Gold well routes for another company', () => {
  const owner = { companyId: undefined };
  assert.equal(canViewGlobalWellPool(owner, 'liquid-gold'), true);
  assert.equal(canViewGlobalWellPool(owner, 'wellbuilt-demo'), false);
  assert.equal(canViewGlobalWellPool(owner, 'another-company'), false);
  assert.equal(canViewGlobalWellPool(owner, null), true);
  assert.equal(canViewGlobalWellPool({ companyId: 'wellbuilt-demo' }, 'liquid-gold'), false);
});

test('governed demo route is visible only to the selected demo scope', () => {
  assert.equal(canViewGovernedWellPool({ companyId: 'wellbuilt-demo' }), true);
  assert.equal(canViewGovernedWellPool({ companyId: undefined }, 'wellbuilt-demo'), true);
  // A scoped Liquid Gold user cannot switch company; the operating selection is ignored.
  assert.equal(canViewGovernedWellPool({ companyId: 'liquid-gold' }, 'wellbuilt-demo'), true);
  assert.equal(canViewGovernedWellPool({ companyId: 'another-company' }), false);
});
