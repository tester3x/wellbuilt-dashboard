/**
 * Exact-preview Apply binding. Run: node tools/test-wbmAssignmentPreview.mjs
 */
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const probePath = join(ROOT, 'tools', '.wbmAssignmentPreview.probe.mts');
writeFileSync(probePath, `
import { applyEnabled } from '../src/lib/wbmAssignmentPreview';
const preview = {
  driverId: '2cad521c-13ac-4b6c-b1ab-07843c6bf06f',
  companyId: 'liquid-gold',
  beforeDigest: 'before',
  proposedDigest: 'proposed',
  beforeRevision: 0,
  assignedRoutes: ['Gabriels', 'Watford'],
  assignedWells: [],
  before: { assignedRoutes: null, assignedWells: null },
};
console.log(JSON.stringify({
  match: applyEnabled(preview, ['Gabriels', 'Watford'], []),
  afterCheckbox: applyEnabled(null, ['Gabriels'], []),
  mutated: applyEnabled(preview, ['Gabriels'], []),
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
check('Preview selections enable Apply', r.match === true);
check('Clearing preview after checkbox disables Apply', r.afterCheckbox === false);
check('Mutated selection with stale preview disables Apply', r.mutated === false);
console.log(`\n${3 - fail} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
