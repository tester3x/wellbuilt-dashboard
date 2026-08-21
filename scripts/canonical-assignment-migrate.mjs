#!/usr/bin/env node
/**
 * Dry-run (default) planner for legacy → canonical assignment backfill.
 * Never writes unless --apply AND --i-understand-production-write are both
 * passed. This repository's authorized pass is dry-run only.
 */
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function arg(flag, fallback = '') {
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  return process.argv[i + 1] || fallback;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

const project = arg('--project', 'wellbuilt-sync');
const namesArg = arg('--names', 'Mikezfold,MikeS24');
const names = namesArg.split(',').map((n) => n.trim()).filter(Boolean);
const apply = hasFlag('--apply');
const understand = hasFlag('--i-understand-production-write');

if (apply) {
  if (!understand) {
    console.error('REFUSED: --apply requires --i-understand-production-write');
    process.exit(2);
  }
  console.error('REFUSED: apply is not authorized in this pass (dry-run only).');
  process.exit(2);
}

const firebaseCmd = process.platform === 'win32' ? 'firebase.cmd' : 'firebase';

function dbGet(path) {
  const r = spawnSync(
    firebaseCmd,
    ['database:get', path, '--project', project],
    { encoding: 'utf8', shell: true, timeout: 180000 },
  );
  if (r.status !== 0) {
    throw new Error(`database:get ${path} failed: ${(r.stderr || r.stdout || '').slice(0, 400)}`);
  }
  const trimmed = (r.stdout || '').trim();
  if (!trimmed || trimmed === 'null') return {};
  return JSON.parse(trimmed);
}

function toRows(tree, kind) {
  const out = [];
  for (const [id, val] of Object.entries(tree || {})) {
    if (!val || typeof val !== 'object') continue;
    out.push({
      id: kind === 'approved' ? 'legacy' : id,
      displayName:
        typeof val.displayName === 'string'
          ? val.displayName
          : typeof val.name === 'string'
            ? val.name
            : null,
      companyId: typeof val.companyId === 'string' ? val.companyId : null,
      active: val.active !== false,
      assignedRoutes: val.assignedRoutes,
      assignedWells: val.assignedWells,
    });
  }
  return out;
}

const modPath = join(
  __dirname,
  '..',
  'functions',
  'lib',
  'security',
  'operational',
  'assignmentMigration.js',
);
let evaluateAssignmentMigration;
let sanitizeMigrationReport;
try {
  ({ evaluateAssignmentMigration, sanitizeMigrationReport } = require(modPath));
} catch (err) {
  console.error('Build functions first: cd functions && npm test / npm run build');
  console.error(String(err && err.message ? err.message : err));
  process.exit(1);
}

const allowed = new Set(names.map((n) => n.trim().toLowerCase()));
const profilesTree = dbGet('/drivers/profiles');
const approvedTree = dbGet('/drivers/approved');

const profiles = [];
for (const [id, val] of Object.entries(profilesTree || {})) {
  if (!val || typeof val !== 'object') continue;
  const displayName =
    typeof val.displayName === 'string' ? val.displayName : typeof val.name === 'string' ? val.name : null;
  if (!displayName || !allowed.has(displayName.trim().toLowerCase())) continue;
  profiles.push({
    id,
    displayName,
    companyId: typeof val.companyId === 'string' ? val.companyId : null,
    active: val.active !== false,
    assignedRoutes: val.assignedRoutes,
    assignedWells: val.assignedWells,
  });
}

const approved = [];
for (const val of Object.values(approvedTree || {})) {
  if (!val || typeof val !== 'object') continue;
  const displayName =
    typeof val.displayName === 'string' ? val.displayName : typeof val.name === 'string' ? val.name : null;
  if (!displayName || !allowed.has(displayName.trim().toLowerCase())) continue;
  approved.push({
    id: 'legacy',
    displayName,
    companyId: typeof val.companyId === 'string' ? val.companyId : null,
    active: val.active !== false,
    assignedRoutes: val.assignedRoutes,
    assignedWells: val.assignedWells,
  });
}

const report = sanitizeMigrationReport(
  evaluateAssignmentMigration({ requestedNames: names, approved, profiles }),
);
console.log(JSON.stringify({ project, mode: 'dry-run', apply: false, report }, null, 2));
void toRows;
