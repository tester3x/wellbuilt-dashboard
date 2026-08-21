/**
 * Exact-preview Apply binding + delayed A-preview/open-B fence.
 * Run: node tools/test-wbmAssignmentPreview.mjs
 */
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const probePath = join(ROOT, 'tools', '.wbmAssignmentPreview.probe.mts');
writeFileSync(probePath, `
import {
  applyEnabled, bumpPreviewGeneration, shouldInstallPreview,
} from '../src/lib/wbmAssignmentPreview';

const a = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';
const b = '99ff4b35-51ab-4d45-8d54-18b3b8515c9b';
const previewA = {
  driverId: a,
  companyId: 'liquid-gold',
  beforeDigest: 'before',
  proposedDigest: 'proposed',
  previewContextDigest: 'ctx-a',
  beforeRevision: 0,
  assignedRoutes: ['Gabriels'],
  assignedWells: [],
  before: { assignedRoutes: null, assignedWells: null },
  generation: 1,
};
let gen = 1;
const captured = gen;
gen = bumpPreviewGeneration(gen); // open B
const install = shouldInstallPreview({
  capturedGeneration: captured,
  currentGeneration: gen,
  capturedDriverId: a,
  currentDriverId: b,
});
const applyOnB = applyEnabled(previewA, ['Gabriels'], [], { driverId: b, companyId: 'liquid-gold' }, gen);
console.log(JSON.stringify({
  match: applyEnabled(previewA, ['Gabriels'], [], { driverId: a, companyId: 'liquid-gold' }, 1),
  afterCheckbox: applyEnabled(null, ['Gabriels'], []),
  delayedInstall: install,
  delayedApplyOnB: applyOnB,
  identicalRoutesDifferentDriver: applyEnabled(
    { ...previewA, assignedRoutes: ['Gabriels'] },
    ['Gabriels'],
    [],
    { driverId: b, companyId: 'liquid-gold' },
    1,
  ),
}));
`, 'utf8');
let r;
try {
  r = JSON.parse(execFileSync('npx', ['tsx', probePath], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: true,
  }).trim().split('\n').pop());
} finally {
  try { rmSync(probePath); } catch { /* ignore */ }
}
let fail = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) fail++;
};
check('Preview selections enable Apply for matching target', r.match === true);
check('Clearing preview after checkbox disables Apply', r.afterCheckbox === false);
check('Delayed A preview is not installed after opening B', r.delayedInstall === false);
check('Delayed A preview does not enable Apply for B', r.delayedApplyOnB === false);
check('Identical routes + null-to-same selection still bind driverId', r.identicalRoutesDifferentDriver === false);
console.log(`\n${5 - fail} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
