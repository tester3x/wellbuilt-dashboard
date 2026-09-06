/**
 * Dashboard Edit Well save: secure update adapter, no client RTDB write.
 * Run: node --experimental-strip-types tools/test-updateWellConfig.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyUpdateWellSuccess,
  buildUpdateWellConfigPatch,
  classifyUpdateWellError,
  createUpdateWellClickGuard,
} from '../src/lib/updateWellConfig.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => readFileSync(join(root, rel), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const baseForm = {
  wellName: 'Tornado 1',
  route: '',
  bottomLevel: 3,
  tanks: '1',
  pullBbls: '140',
  tankCapacity: '400',
  tankHeight: '20',
  waterWeight: '',
  h2sStatus: 'unknown',
};

{
  const montana = buildUpdateWellConfigPatch({ ...baseForm, route: 'Montana' });
  check('Unrouted blank form route becomes Unrouted', buildUpdateWellConfigPatch(baseForm).route === 'Unrouted');
  check('Montana patch keeps Montana', montana.route === 'Montana');
  check('Montana → Unrouted blank canonicalizes', buildUpdateWellConfigPatch({ ...baseForm, route: '  ' }).route === 'Unrouted');
  check('numeric tanks 6', buildUpdateWellConfigPatch({ ...baseForm, tanks: '6' }).tanks === 6);
  check('derived BBL/ft for 6x400/20', buildUpdateWellConfigPatch({ ...baseForm, tanks: '6' }).bblPerFoot === 120);
  check('omitted water weight is absent', !('waterWeight' in montana));
  check('provided water weight is kept', buildUpdateWellConfigPatch({ ...baseForm, waterWeight: '9.7' }).waterWeight === 9.7);
  check('NDIC fields are not on the patch', !('ndicName' in montana) && !('ndicApiNo' in montana));
}

{
  const next = applyUpdateWellSuccess(
    { 'Tornado 1': { route: 'Unrouted', avgFlowRate: '12.4', ndicName: 'Tornado 1-24H' } },
    'Tornado 1',
    { route: 'Montana', avgFlowRate: '12.4', ndicName: 'Tornado 1-24H' },
  );
  check('success merge preserves AFR', next['Tornado 1'].avgFlowRate === '12.4');
  check('success merge shows Montana only after apply', next['Tornado 1'].route === 'Montana');
}

{
  check('missing target classified', classifyUpdateWellError({ code: 'functions/not-found', message: 'not_found:Well does not exist.' }).reason === 'not-found');
  check('unauthorized classified', classifyUpdateWellError({ code: 'functions/permission-denied', message: 'pool_forbidden:no' }).reason === 'permission-denied');
  check('unknown field classified', classifyUpdateWellError({ message: 'unexpected_field:Unexpected field: ndicApiNo' }).reason === 'unexpected_field');
  check('malformed classified', classifyUpdateWellError({ message: 'invalid_pull_bbls:Pull BBLs must be a positive number.' }).reason === 'invalid');
  check('callable failure classified retryable', classifyUpdateWellError({ code: 'functions/unavailable', message: 'network' }).reason === 'unavailable');
  check('missing callable distinct from missing well', classifyUpdateWellError({ code: 'functions/not-found', message: 'NOT FOUND' }).reason === 'missing-callable');
}

{
  const g = createUpdateWellClickGuard();
  check('first tap begins', g.tryBegin() === true);
  check('duplicate tap rejected', g.tryBegin() === false);
  g.end();
  check('after end a new tap begins', g.tryBegin() === true);
}

{
  const page = src('src/app/admin/page.tsx');
  const adapter = src('src/lib/staffWriteWellConfig.ts');
  const fn = page.slice(page.indexOf('const handleUpdateWell'), page.indexOf('const handleDeleteWell'));
  const nonRename = fn.slice(fn.indexOf('} else {'));
  const rename = fn.slice(0, fn.indexOf('} else {'));
  check('adapter exposes staffUpdateWellConfig', adapter.includes('export async function staffUpdateWellConfig'));
  check('update adapter uses op update', adapter.includes("op: 'update'"));
  check('create adapter still uses op create', adapter.includes("op: 'create'"));
  check('non-rename save uses staffUpdateWellConfig', nonRename.includes('staffUpdateWellConfig'));
  check('non-rename has Saving state', nonRename.includes("'submitting'") && page.includes('Saving…'));
  check('non-rename has success state', nonRename.includes("'success'"));
  check('non-rename classifies failure', nonRename.includes('classifyUpdateWellError'));
  check('non-rename single-flight', nonRename.includes('updateWellInflightRef'));
  check('non-rename no client RTDB update', !/update\(ref\(db,\s*`well_config\/\$\{selectedWell\}`/.test(nonRename));
  check('non-rename no client RTDB set', !/set\(ref\(db,\s*`well_config/.test(nonRename));
  check('success UI is after the callable await', nonRename.indexOf('await staffUpdateWellConfig') < nonRename.indexOf("kind: 'success'"));
  check('catalog refresh after success', nonRename.includes('adminGetDashboardCatalog'));
  check('rename path left on client writes', rename.includes('set(ref(db, `well_config/${newName}`)'));
  check('delete still queued separately', page.includes('const handleDeleteWell'));
  const add = page.slice(page.indexOf('const handleAddWell'), page.indexOf('const handleUpdateWell'));
  check('Add Well create path unchanged', add.includes('staffCreateWellConfig'));
  check('Add Well still no client set', !/set\(ref\(db,\s*`well_config/.test(add));
}

{
  const callable = src('functions/src/security/staffWriteWellConfigCallable.ts');
  check('callable create still sets', callable.includes('.set(decided.payload)'));
  check('callable update merges', callable.includes('.update(decided.patch)'));
  check('callable still requireManageDrivers', callable.includes('requireManageDrivers'));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
