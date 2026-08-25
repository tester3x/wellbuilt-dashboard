/**
 * Canonical catalog fail-closed UI.
 * Run: node --experimental-strip-types tools/test-canonicalCatalogUi.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSecureLoginAllowed,
  interpretCatalogProfiles,
  parseCanonicalProfiles,
  secureLoginUiState,
  unboundSameNameProfile,
} from '../src/lib/canonicalCatalogUi.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => readFileSync(join(root, rel), 'utf8');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const mikes24 = '99ff4b35-51ab-4d45-8d54-18b3b8515c9b';
const mikezfold = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';
const successCatalog = {
  ok: true,
  approved: { hash1: { displayName: 'MikeS24' } },
  profiles: {
    [mikes24]: { displayName: 'MikeS24', legalName: 'Michael S24 Burger', companyId: 'liquid-gold' },
    [mikezfold]: { displayName: 'Mikezfold', legalName: 'Mike ZFold7 Burger', companyId: 'liquid-gold' },
  },
  users: {},
  wellConfig: {},
  counts: { approved: 1, profiles: 2, users: 0, wellConfig: 0 },
};

{
  const r = interpretCatalogProfiles(successCatalog, false);
  check('catalog success with MikeS24/Mikezfold is ok', r.status === 'ok' && Object.keys(r.profiles).length === 2);
  const parsed = parseCanonicalProfiles(r.profiles);
  check('parsed ids include both testers', parsed.some((p) => p.driverId === mikes24) && parsed.some((p) => p.driverId === mikezfold));
}

{
  const missing = interpretCatalogProfiles({ ok: true, approved: {}, users: {}, wellConfig: {}, counts: {} }, false);
  check('Phase 1 callable without profiles field is unavailable, not empty', missing.status === 'unavailable');
  const failed = interpretCatalogProfiles(null, true);
  check('load failure is unavailable', failed.status === 'unavailable');
  const empty = interpretCatalogProfiles({ profiles: {} }, false);
  check('present empty profiles object is genuine empty', empty.status === 'empty');
  check('Create disabled when unavailable', createSecureLoginAllowed('unavailable') === false);
  check('Create disabled while loading', createSecureLoginAllowed('loading') === false);
  check('Create allowed when catalog ok', createSecureLoginAllowed('ok') === true);
}

{
  const profiles = parseCanonicalProfiles(successCatalog.profiles);
  const bound = unboundSameNameProfile({ displayName: 'MikeS24', driverId: mikes24 }, profiles);
  check('explicit canonical driverId is treated as bound, not a name duplicate', bound === null);
  const unbound = unboundSameNameProfile({ displayName: 'MikeS24', legalName: 'Michael S24 Burger', key: 'legacyhash' }, profiles);
  check('legacy card with unbound same-name profile is flagged, not linked', unbound && unbound.driverId === mikes24);
  const other = unboundSameNameProfile({ displayName: 'AdanS', legalName: 'AdanS', key: 'hash2' }, profiles);
  check('different human names are not collapsed', other === null);
  const luizLegacy = unboundSameNameProfile({ displayName: 'Wisho-135', legalName: 'Luiz Lebaron', key: 'wishohash' }, [
    { driverId: 'aa5021c7-251c-41e8-920d-b18a02e95098', displayName: 'Luiz Lebaron', legalName: 'Luiz Lebaron' },
  ]);
  check('Luiz legalName match flags duplicate without binding', luizLegacy && luizLegacy.driverId.startsWith('aa5021c7'));
}

{
  const unknown = secureLoginUiState({
    isWbAdmin: true, catalogStatus: 'unavailable', driverActive: true,
    hasCanonicalDriverId: false, unboundSameName: null,
  });
  check('Create secure login disabled when canonical state is unknown', unknown === 'unknown');
  const dup = secureLoginUiState({
    isWbAdmin: true, catalogStatus: 'ok', driverActive: true,
    hasCanonicalDriverId: false,
    unboundSameName: { driverId: mikes24, displayName: 'MikeS24' },
  });
  check('unbound same-name does not offer Create', dup === 'duplicate');
}

{
  const tab = src('src/components/admin/DriversTab.tsx');
  const panel = src('src/components/admin/EmployeePanel.tsx');
  const helper = src('src/lib/adminDashboardCatalog.ts');
  check('canonical panel uses governed catalog helper', tab.includes('adminGetDashboardCatalog') && helper.includes("'adminGetDashboardCatalog'"));
  check('no direct RTDB profiles fallback in DriversTab load', !/ref\(db,\s*['"]drivers\/profiles/.test(tab));
  check('unavailable copy is shown instead of pretending zero profiles', tab.includes('Canonical driver status unavailable'));
  check('Create remains disabled in the employee panel when unknown', panel.includes("secureLoginStateFor(row) === 'unknown'"));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
