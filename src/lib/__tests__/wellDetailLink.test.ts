// Canonical WB-M well-detail link: canonical (company + NDIC API) identity ONLY,
// never wellName. Missing either part ⇒ unavailable (null), no fuzzy fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wellDetailHref, hasCanonicalWellIdentity } from '../wellDetailLink.ts';

test('builds a canonical href from companyId + ndicApiNo', () => {
  const href = wellDetailHref({ companyId: 'liquid-gold', ndicApiNo: '33-053-01234' });
  assert.equal(href, '/well?company=liquid-gold&api=33-053-01234');
  assert.equal(hasCanonicalWellIdentity({ companyId: 'liquid-gold', ndicApiNo: '33-053-01234' }), true);
});

test('fails closed (null) when either canonical part is missing — no wellName fallback', () => {
  assert.equal(wellDetailHref({ companyId: 'acme' }), null);            // no api
  assert.equal(wellDetailHref({ ndicApiNo: '33-053-01234' }), null);   // no company
  assert.equal(wellDetailHref({}), null);
  assert.equal(wellDetailHref(null), null);
  assert.equal(wellDetailHref({ companyId: '  ', ndicApiNo: ' ' }), null); // blank
  assert.equal(hasCanonicalWellIdentity({ companyId: 'acme' }), false);
});

test('two same-named wells in different companies resolve to DISTINCT canonical links', () => {
  const a = wellDetailHref({ companyId: 'company-a', ndicApiNo: 'API-A' });
  const b = wellDetailHref({ companyId: 'company-b', ndicApiNo: 'API-B' });
  assert.notEqual(a, b);
  assert.equal(a, '/well?company=company-a&api=API-A');
  assert.equal(b, '/well?company=company-b&api=API-B');
});

test('url-encodes identity parts', () => {
  assert.equal(
    wellDetailHref({ companyId: 'co a', ndicApiNo: '33/053 01' }),
    '/well?company=co%20a&api=33%2F053%2001',
  );
});
