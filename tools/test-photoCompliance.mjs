/**
 * vc51.9I-RECOVERY4 — photo-compliance restoration + credential transport.
 *
 * RED-FIRST: against the pre-restoration branch these fail — the two
 * Functions did not exist in source at all, so a whole-codebase deploy
 * would have pruned two LIVE Functions. Against the historical
 * implementation they also fail, because it read provider keys from
 * process.env and appended the Gemini key to the request URL.
 *
 * No live credential is used. Fixtures are obviously fake.
 *
 * Run: node tools/test-photoCompliance.mjs
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

const modPath = join(FN, 'src', 'photoCompliance.ts');
check('photoCompliance module exists', existsSync(modPath));
const src = existsSync(modPath) ? readFileSync(modPath, 'utf8') : '';
const indexSrc = readFileSync(join(FN, 'src', 'index.ts'), 'utf8');
const secretsSrc = readFileSync(join(FN, 'src', 'secrets.ts'), 'utf8');

// ── 1. Both live Functions are restored and exported ────────────────────
for (const fn of ['validatePhotoCompliance', 'suggestPhotoCriteria']) {
  check(`${fn} is defined`, new RegExp(`export const ${fn} = httpsV2\\.onCall`).test(src));
  check(`${fn} is re-exported from index`, new RegExp(`\\b${fn}\\b`).test(indexSrc));
}

// ── 2. Gemini credential transport: header, never URL ───────────────────
check('no Gemini credential in any request URL',
  !/generateContent\?key=/.test(src) && !/[?&]key=\$\{/.test(src));
const geminiCalls = (src.match(/generativelanguage\.googleapis\.com/g) || []).length;
check('both Gemini call sites present', geminiCalls === 2, `${geminiCalls}`);
const headerUses = (src.match(/'x-goog-api-key'\s*:\s*apiKey/g) || []).length;
check('every Gemini call sends the key via x-goog-api-key header',
  headerUses === geminiCalls, `${headerUses}/${geminiCalls}`);

// ── 3. Secret Manager, no plaintext fallback ────────────────────────────
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const code = stripComments(src);
check('no process.env read of a provider credential',
  !/process\.env\.(ANTHROPIC|GEMINI)_API_KEY/.test(code));
check('GEMINI_API_KEY is now defined as a secret (it has a real consumer)',
  /defineSecret\(\s*'GEMINI_API_KEY'\s*\)/.test(secretsSrc));
check('provider keys are read through readSecret (fails closed)',
  (code.match(/readSecret\(GEMINI_API_KEY\)/g) || []).length === 2);
check('Anthropic client comes from the injected factory',
  /createAnthropicClient\(\)/.test(code) && !/new Anthropic\(/.test(code));

// ── 4. Least-privilege bindings ─────────────────────────────────────────
const bindings = [...src.matchAll(/export const (\w+) = httpsV2\.onCall\(\s*(?:\/\/[^\n]*\n\s*)?\{[^}]*secrets:\s*\[([^\]]*)\]/g)]
  .map((m) => ({ fn: m[1], secrets: m[2].replace(/\s+/g, ' ').trim() }));
check('both photo Functions declare a secret binding', bindings.length === 2,
  bindings.map((b) => b.fn).join(','));
for (const b of bindings) {
  check(`${b.fn} binds BOTH providers (runtime switch reaches either)`,
    b.secrets === 'ANTHROPIC_API_KEY, GEMINI_API_KEY', b.secrets);
}
// parseJsaPdf must stay Anthropic-only.
const jsaBinding = indexSrc.match(/export const parseJsaPdf[\s\S]{0,400}?secrets:\s*\[([^\]]*)\]/);
check('parseJsaPdf remains Anthropic-only',
  jsaBinding && jsaBinding[1].trim() === 'ANTHROPIC_API_KEY', jsaBinding?.[1]);

// ── 5. Provider selection preserved ─────────────────────────────────────
check('runtime provider switch preserved (default claude)',
  /PHOTO_COMPLIANCE_PROVIDER\s*\|\|\s*'claude'/.test(src));
check('both provider branches retained',
  /provider === 'gemini'/.test(src) && /CLAUDE_VISION_MODEL/.test(src));
check('model identifiers unchanged',
  /'gemini-2\.0-flash'/.test(src) && /'claude-sonnet-4-6'/.test(src));

// ── 6. Failures cannot leak credentials ─────────────────────────────────
check('provider failures log through redact()',
  (src.match(/logRedacted\(/g) || []).length >= 3
  && !/console\.error\('\[validatePhotoCompliance\] (Gemini|Claude) error/.test(src));
{
  // Exercise redact() for real against a credential-bearing URL.
  const probe = `
    const { redact } = require('./lib/secrets');
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/x:generateContent?key=AQ.FAKEFAKEFAKEFAKEFAKE';
    const out = redact('fetch failed for ' + url);
    console.log(JSON.stringify({
      hidesKey: !out.includes('AQ.FAKEFAKEFAKEFAKEFAKE'),
      keepsContext: out.includes('fetch failed'),
      hidesAnthropic: !redact('x sk-ant-api03-FAKEFAKEFAKEFAKE y').includes('sk-ant-api03-FAKE'),
    }));
  `;
  let r = {};
  try { r = JSON.parse(execFileSync(process.execPath, ['-e', probe], { cwd: FN, encoding: 'utf8' }).trim()); }
  catch (e) { check('redact probe ran', false, String(e.message).slice(0, 120)); }
  check('redact() strips a credential-bearing Gemini URL', r.hidesKey === true);
  check('redact() preserves diagnostic context', r.keepsContext === true);
  check('redact() strips Anthropic key shapes', r.hidesAnthropic === true);
}

// ── 7. Built output actually exports them ───────────────────────────────
{
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; delete env.GEMINI_API_KEY;
  env.GCLOUD_PROJECT = 'demo-photo-probe';
  env.FIREBASE_CONFIG = JSON.stringify({
    projectId: 'demo-photo-probe',
    databaseURL: 'https://demo-photo-probe-default-rtdb.firebaseio.com',
    storageBucket: 'demo-photo-probe.appspot.com',
  });
  let out = '';
  try {
    out = execFileSync(process.execPath, ['-e', `
      process.env.FUNCTIONS_CONTROL_API = 'true';
      const m = require('./lib/index.js');
      console.log(JSON.stringify({
        v: typeof m.validatePhotoCompliance, s: typeof m.suggestPhotoCriteria,
      }));
    `], { cwd: FN, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch (e) { out = ''; }
  let j = {};
  try { j = JSON.parse(out); } catch { /* leave empty */ }
  check('built index exports validatePhotoCompliance', j.v === 'object' || j.v === 'function', j.v);
  check('built index exports suggestPhotoCriteria', j.s === 'object' || j.s === 'function', j.s);
  check('module loads with neither provider secret present', !!out);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
