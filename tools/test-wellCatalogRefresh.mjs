/**
 * vc51.9I-RECOVERY4 — well-catalog Functions restoration pins.
 *
 * RED-FIRST: against the pre-restoration branch every export check
 * fails, because both Functions were LIVE while absent from source — a
 * whole-codebase deploy would have pruned the weekly catalog refresh
 * and its manual trigger.
 *
 * Run: node tools/test-wellCatalogRefresh.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FN = join(root, 'functions');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const modPath = join(FN, 'src', 'wellCatalogRefresh.ts');
check('wellCatalogRefresh module exists', existsSync(modPath));
const src = existsSync(modPath) ? readFileSync(modPath, 'utf8') : '';
const indexSrc = readFileSync(join(FN, 'src', 'index.ts'), 'utf8');

// ── 1. Both live Functions restored and exported ────────────────────────
check('scheduledWellCatalogRefresh is defined',
  /export const scheduledWellCatalogRefresh = functionsV2\.onSchedule/.test(src));
check('triggerWellCatalogRefresh is defined',
  /export const triggerWellCatalogRefresh = httpsV2\.onCall/.test(src));
check('both are re-exported from index',
  /scheduledWellCatalogRefresh/.test(indexSrc) && /triggerWellCatalogRefresh/.test(indexSrc));

// ── 2. Schedule preserved exactly ───────────────────────────────────────
check('weekly schedule preserved', /schedule:\s*'every sunday 02:00'/.test(src));
check('schedule is timezone-pinned (not UTC-drifting)', /timeZone:\s*TZ/.test(src));

// ── 3. Authorization preserved on the manual trigger ────────────────────
check('trigger requires authentication', /request\.auth\?\.uid/.test(src));
check('trigger rejects unauthenticated callers',
  /unauthenticated'[^)]*Sign in required/.test(src));
check('trigger re-reads authoritative RTDB role (not a client claim)',
  /admin\.database\(\)\.ref\(`users\/\$\{uid\}`\)/.test(src));
check('trigger gate is WB-staff role admin/it',
  /role === 'admin'|'admin'.*'it'|role !== 'admin'/.test(src));

// ── 4. NO AI secrets bound — this is the least-privilege boundary ───────
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  .replace(/^\s*\*.*$/gm, '');
const code = stripComments(src);
check('no AI provider credential is read', !/(ANTHROPIC|GEMINI)_API_KEY/.test(code));
check('no secrets binding is declared at all', !/secrets:\s*\[/.test(src));
check('no AI provider client is constructed',
  !/createAnthropicClient|new Anthropic|generativelanguage/.test(code));

// ── 5. Non-credential config may stay on process.env ────────────────────
const envReads = [...code.matchAll(/process\.env\.(\w+)/g)].map((m) => m[1]);
check('only non-credential env config is read',
  envReads.every((k) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(k)), envReads.join(','));

// ── 6. Self-contained: no unrelated historical imports dragged in ───────
const imports = [...src.matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]);
check('imports only firebase primitives (no branch coupling)',
  imports.every((i) => /^firebase-(functions|admin)/.test(i)), imports.join(', '));

// ── 7. Built output actually exports them ───────────────────────────────
{
  const env = { ...process.env };
  env.GCLOUD_PROJECT = 'demo-catalog-probe';
  env.FIREBASE_CONFIG = JSON.stringify({
    projectId: 'demo-catalog-probe',
    databaseURL: 'https://demo-catalog-probe-default-rtdb.firebaseio.com',
    storageBucket: 'demo-catalog-probe.appspot.com',
  });
  let out = '';
  try {
    out = execFileSync(process.execPath, ['-e', `
      process.env.FUNCTIONS_CONTROL_API = 'true';
      const m = require('./lib/index.js');
      console.log(JSON.stringify({
        s: typeof m.scheduledWellCatalogRefresh, t: typeof m.triggerWellCatalogRefresh,
      }));
    `], { cwd: FN, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch { out = ''; }
  let j = {}; try { j = JSON.parse(out); } catch { /* empty */ }
  check('built index exports scheduledWellCatalogRefresh', j.s === 'object' || j.s === 'function', j.s);
  check('built index exports triggerWellCatalogRefresh', j.t === 'object' || j.t === 'function', j.t);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
