import { test } from 'node:test';
import assert from 'node:assert/strict';
import { docBelongsToTenant, viewedCompanyId } from '../tenantScope.ts';

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
