// Source-contract: the dispatch page wires the shared canonical identity resolver into
// Active Jobs + Well Queue attribution and stamps canonical driverId on the drivers list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const page = read('../../app/dispatch/page.tsx');
const resolver = read('../dispatchDriverIdentity.ts');

test('page imports the shared resolver', () => {
  assert.match(page, /import \{ resolveDispatchDriver, dispatchDriverDisplayName, dispatchDriverGroupKey \} from '@\/lib\/dispatchDriverIdentity'/);
});

test('Active Jobs groups by CANONICAL identity, not raw driverHash', () => {
  assert.match(page, /const key = dispatchDriverGroupKey\(d, drivers \|\| \[\]\)/);
  assert.ok(!/const key = d\.driverHash;/.test(page), 'no longer groups by raw driverHash');
});

test('Active Jobs group header resolves via canonical resolver + REAL name (no login fallback)', () => {
  assert.match(page, /const driverRecord = resolveDispatchDriver\(jobs\[0\], drivers \|\| \[\]\)/);
  assert.match(page, /const driverName = dispatchDriverDisplayName\(jobs\[0\], drivers \|\| \[\]\)/);
  assert.ok(!/driverRecord\?\.legalName \|\| jobs\[0\]\.driverName \|\| jobs\[0\]\.driverFirstName \|\| 'Unknown'/.test(page), 'no login/stamped-name fallback in the header');
});

test('Well Queue assignment attribution uses the resolver (real name, never stamped login)', () => {
  assert.match(page, /const rd = resolveDispatchDriver\(d, drivers(\s*\|\|\s*\[\])?\)/);
  assert.ok(!/driver: d\.driverFirstName \|\| d\.driverName \|\| '\?'/.test(page), 'no stamped-name attribution');
});

test('drivers list stamps canonical driverId + legacy aliases', () => {
  assert.match(page, /driverId: canonicalIdFromApprovedRow\(hash, val\)/);
  assert.match(page, /driverId: canonicalIdFromApprovedRow\(hash, first\)/);
  assert.match(page, /legacyAliases: \[val\.migratedToDriverId\]\.filter\(Boolean\)/);
  assert.match(page, /interface ApprovedDriver \{[\s\S]*?driverId\?: string;[\s\S]*?legacyAliases\?: string\[\];/);
});

test('resolver enforces canonical-first, legacy-fallback, no cross-company (source)', () => {
  assert.match(resolver, /never cross-company/);
  assert.match(resolver, /canonical \(preferred\)/);
  assert.match(resolver, /governed legacy hash fallback/);
  // display helper never returns a login/hash
  assert.match(resolver, /return 'Unassigned driver'/);
});
