// @ts-check
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PROVEN_UI_BASELINE_SHA = '576fb63b4a6f92a23a99e5c304f959638b830a84';
const ALLOWED_BRANCH_PATTERNS = [
  /^release\/dashboard-.*$/,
  /^hotfix\/dashboard-.*$/,
  /^main$/,
];

function run(cmd, options = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: 'pipe', ...options }).trim();
  } catch (err) {
    return null;
  }
}

function fatal(msg) {
  console.error('\n================================================================');
  console.error('⛔ [DEPLOY PREFLIGHT REJECTED]');
  console.error(msg);
  console.error('================================================================\n');
  process.exit(1);
}

console.log('\n>>> Starting WellBuilt Hosting Deploy-Time Gatekeeper Preflight <<<\n');

// 1. Branch Canonicality Gate
const currentBranch = run('git rev-parse --abbrev-ref HEAD');
if (!currentBranch || currentBranch === 'HEAD') {
  fatal('Cannot deploy from detached HEAD. You must be on a certified release or hotfix branch.');
}

const isAllowedBranch = ALLOWED_BRANCH_PATTERNS.some((pattern) => pattern.test(currentBranch));
if (!isAllowedBranch) {
  fatal(
    `Deployment forbidden from noncanonical branch: "${currentBranch}".\n` +
      'Hosting deploys are restricted to canonical branches matching:\n' +
      '  - release/dashboard-*\n' +
      '  - hotfix/dashboard-*\n' +
      '  - main\n' +
      'Local feature branches (feat/*, fix/*, wip/*) are mechanically blocked from deploying.',
  );
}
console.log(`✓ Gate 1 Passed: Canonical release branch verified ("${currentBranch}").`);

// 2. Clean Working Tree Gate
const status = run('git status --porcelain');
if (status && status.length > 0) {
  fatal(
    'Dirty working tree detected. All changes must be committed before deploying to Hosting.\n' +
      'Uncommitted changes:\n' +
      status
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n'),
  );
}
console.log('✓ Gate 2 Passed: Working tree is clean (no uncommitted or untracked files).');

// 3. Proven Approved UI Baseline Provenance Gate
const isDescendant = run(`git merge-base --is-ancestor ${PROVEN_UI_BASELINE_SHA} HEAD`);
if (isDescendant === null) {
  fatal(
    `Missing approved UI baseline metadata!\n` +
      `Current commit does NOT descend from proven approved UI baseline: ${PROVEN_UI_BASELINE_SHA}.\n` +
      'Deployment aborted to prevent silent reversion of approved header/viewport layouts.',
  );
}
console.log(`✓ Gate 3 Passed: Proven approved UI baseline lineage confirmed (${PROVEN_UI_BASELINE_SHA.slice(0, 8)}).`);

// 4. Build-Before-Validate Gate: Purge stale artifacts and compile freshly
console.log('\n--- Purging Stale Build Artifacts & Compiling Fresh Build ---');
try {
  const outDir = path.resolve('out');
  const nextDir = path.resolve('.next');
  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  if (fs.existsSync(nextDir)) {
    fs.rmSync(nextDir, { recursive: true, force: true });
  }
  console.log('Executing clean build: npx next build --webpack ...');
  execSync('npx next build --webpack', { stdio: 'inherit' });

  if (!fs.existsSync(outDir) || !fs.existsSync(path.join(outDir, 'index.html'))) {
    fatal('Fresh build failed: out/index.html was not created.');
  }
  console.log('✓ Gate 4 Passed: Clean build freshly compiled into out/.');
} catch (err) {
  fatal(`Clean build failed: ${err.message}`);
}

// 5. Mechanical Guardrail Tests Execution
console.log('\n--- Running Mandatory Pre-Deploy Test Suites on Fresh Build ---');

try {
  console.log('Executing: node tools/test-header-navigation-guardrails.mjs ...');
  execSync('node tools/test-header-navigation-guardrails.mjs', { stdio: 'inherit' });
  console.log('✓ Header & Navigation Guardrails: PASSED');
} catch (err) {
  fatal('Header & Navigation Guardrails FAILED. Deployment aborted.');
}

try {
  console.log('Executing: node tools/test-photo-review-contract.mjs ...');
  execSync('node tools/test-photo-review-contract.mjs', { stdio: 'inherit' });
  console.log('✓ Photo Review Contract Verification: PASSED');
} catch (err) {
  fatal('Photo Review Contract Verification FAILED. Deployment aborted.');
}

try {
  console.log('Executing: node tools/test-render-all-authenticated-routes.mjs ...');
  execSync('node tools/test-render-all-authenticated-routes.mjs', { stdio: 'inherit' });
  console.log('✓ Authenticated Route Responsive Render Verification: PASSED');
} catch (err) {
  fatal('Authenticated route rendering verification FAILED. Deployment aborted.');
}

try {
  console.log('Executing: node tools/test-projects-well-scroll.mjs ...');
  execSync('node tools/test-projects-well-scroll.mjs', { stdio: 'inherit' });
  console.log('✓ Job Builder Autocomplete Scroll (real-DOM) Verification: PASSED');
} catch (err) {
  fatal('Job Builder autocomplete scroll verification FAILED. Deployment aborted.');
}

try {
  console.log('Executing: node tools/test-project-wells-layout.mjs ...');
  execSync('node tools/test-project-wells-layout.mjs', { stdio: 'inherit' });
  console.log('✓ Projects Selected-Well Chips Layout (real-DOM) Verification: PASSED');
} catch (err) {
  fatal('Projects selected-well chips layout verification FAILED. Deployment aborted.');
}

console.log('\n================================================================');
console.log('✅ [ALL PREFLIGHT SAFETY GATES PASSED] Hosting Release Certified.');
console.log('================================================================\n');
