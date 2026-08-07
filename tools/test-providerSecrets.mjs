/**
 * vc51.9I-SEC — provider secret binding, fail-closed, and redaction.
 *
 * Every value here is an obviously fake, nonfunctional fixture. No live
 * credential is read, constructed, transmitted, or printed. The suite
 * asserts on classification and shape only.
 *
 * Run: node tools/test-providerSecrets.mjs
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

// Unmistakably fake, nonfunctional fixtures.
const FAKE_KEY = 'FAKE-TEST-VALUE-NOT-A-REAL-CREDENTIAL';

const secretsSrc = readFileSync(join(FN, 'src', 'secrets.ts'), 'utf8');
const clientSrc = readFileSync(join(FN, 'src', 'ai', 'anthropicClient.ts'), 'utf8');
const indexSrc = readFileSync(join(FN, 'src', 'index.ts'), 'utf8');

// ── 1. Secret definition and least privilege ────────────────────────────
check('ANTHROPIC_API_KEY is defined via defineSecret',
  /defineSecret\(\s*'ANTHROPIC_API_KEY'\s*\)/.test(secretsSrc));
check('GEMINI_API_KEY is deliberately NOT defined (zero consumers)',
  !/defineSecret\(\s*'GEMINI_API_KEY'\s*\)/.test(secretsSrc));

// Only parseJsaPdf may declare a secrets binding.
const bindings = [...indexSrc.matchAll(/export const (\w+)\s*=\s*(?:httpsV2|functionsV1|functionsV2)[\s\S]{0,400}?secrets:\s*\[([^\]]*)\]/g)]
  .map((m) => ({ fn: m[1], secrets: m[2].trim() }));
check('exactly one Function declares a secret binding', bindings.length === 1,
  bindings.map((b) => b.fn).join(','));
check('the bound Function is parseJsaPdf', bindings[0]?.fn === 'parseJsaPdf', bindings[0]?.fn);
check('parseJsaPdf binds ANTHROPIC_API_KEY only',
  bindings[0]?.secrets === 'ANTHROPIC_API_KEY', bindings[0]?.secrets);
check('no Function binds a Gemini secret', !/secrets:\s*\[[^\]]*GEMINI/.test(indexSrc));

// ── 2. No plaintext fallback anywhere ───────────────────────────────────
const envReads = [...indexSrc.matchAll(/process\.env\.(\w*(?:ANTHROPIC|GEMINI|API_KEY)\w*)/g)].map((m) => m[1]);
check('no process.env read of a provider key remains in index.ts',
  envReads.length === 0, envReads.join(','));
// Strip comments first — both files explain in prose WHY there is no
// process.env fallback, and that prose must not read as a violation.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('secrets.ts has no process.env fallback in code', !/process\.env/.test(stripComments(secretsSrc)));
check('anthropicClient.ts has no process.env fallback in code', !/process\.env/.test(stripComments(clientSrc)));
check('no .env file is referenced as a credential source',
  !/ANTHROPIC_API_KEY not set in functions\/\.env/.test(indexSrc));

// ── 3. Invocation-time access only (no module-load .value()) ────────────
// A module-load `.value()` runs during deployment analysis and would
// break every Function that does not bind the secret.
const topLevelValue = /^(?!.*function)(?:const|let|var)\s+\w+\s*=\s*\w+\.value\(\)/m.test(clientSrc)
  || /^(?:const|let|var)\s+\w+\s*=\s*\w+\.value\(\)/m.test(secretsSrc);
check('no module-load .value() access', !topLevelValue);
check('readSecret is called lazily inside a factory default',
  /readKey:\s*\(\)\s*=>\s*string\s*=\s*\(\)\s*=>\s*readSecret\(/.test(clientSrc));

// ── 4. Behavior: fail-closed + injection, exercised for real ────────────
const probe = `
  const { readSecret, MissingSecretError, toSafeProviderError, redact } = require('./lib/secrets');
  const { createAnthropicClient } = require('./lib/ai/anthropicClient');
  const out = {};

  // missing / blank secrets fail closed
  const mk = (name, v) => ({ name, value: () => { if (v === null) throw new Error('unset'); return v; } });
  const caught = (f) => { try { f(); return null; } catch (e) { return e; } };
  out.unsetFailsClosed  = caught(() => readSecret(mk('ANTHROPIC_API_KEY', null))) instanceof MissingSecretError;
  out.blankFailsClosed  = caught(() => readSecret(mk('ANTHROPIC_API_KEY', '   '))) instanceof MissingSecretError;
  out.presentReturns    = readSecret(mk('ANTHROPIC_API_KEY', ${JSON.stringify(FAKE_KEY)})) === ${JSON.stringify(FAKE_KEY)};

  // the thrown error names the secret but never carries a value
  const err = caught(() => readSecret(mk('ANTHROPIC_API_KEY', null)));
  out.errNamesSecret    = String(err.message).includes('ANTHROPIC_API_KEY');
  out.errHasNoValue     = !String(err.message).includes(${JSON.stringify(FAKE_KEY)});

  // client construction uses injected seams — no live credential, no network
  let seen = null;
  class FakeAnthropic { constructor(o) { seen = o.apiKey; this.messages = { create: async () => ({ content: [] }) }; } }
  const c = createAnthropicClient(() => ${JSON.stringify(FAKE_KEY)}, FakeAnthropic);
  out.injectedCtorUsed  = c instanceof FakeAnthropic && seen === ${JSON.stringify(FAKE_KEY)};

  // a missing secret fails before any client is constructed
  seen = null;
  const c2 = caught(() => createAnthropicClient(() => { throw new MissingSecretError('ANTHROPIC_API_KEY'); }, FakeAnthropic));
  out.failsBeforeClient = c2 instanceof MissingSecretError && seen === null;

  // client-facing errors are safe
  const missing = toSafeProviderError('AI analysis', new MissingSecretError('ANTHROPIC_API_KEY'));
  out.missingIsPrecondition = missing.code === 'failed-precondition';
  out.missingMentionsSecret  = missing.message.includes('ANTHROPIC_API_KEY');
  const upstream = toSafeProviderError('AI analysis', new Error('401 invalid x-api-key ' + ${JSON.stringify(FAKE_KEY)}));
  out.upstreamIsInternal   = upstream.code === 'internal';
  out.upstreamHidesDetail  = !upstream.message.includes(${JSON.stringify(FAKE_KEY)})
                          && !upstream.message.includes('401');

  // redaction strips credential shapes
  out.redactsSk    = !redact('boom sk-ant-api03-AAAAAAAAAAAAAAAA failed').includes('sk-ant-api03');
  out.redactsAq    = !redact('boom AQ.AbCdEfGhIjKlMnOpQr failed').includes('AQ.AbCd');
  out.redactsAiza  = !redact('boom AIzaSyAAAAAAAAAAAAAAAAAAAA failed').includes('AIzaSy');
  out.keepsMessage = redact('timeout after 30s').includes('timeout');

  console.log(JSON.stringify(out));
`;
let res = {};
try {
  res = JSON.parse(execFileSync(process.execPath, ['-e', probe], { cwd: FN, encoding: 'utf8' }).trim());
} catch (e) {
  check('behavior probe ran', false, String(e.message).slice(0, 200));
}
const expect = {
  unsetFailsClosed: 'unset secret fails closed',
  blankFailsClosed: 'blank secret fails closed',
  presentReturns: 'configured secret is returned to the caller',
  errNamesSecret: 'missing-secret error names the secret',
  errHasNoValue: 'missing-secret error carries no value',
  injectedCtorUsed: 'client is built through injected seams (no live credential)',
  failsBeforeClient: 'missing secret fails before any provider client is constructed',
  missingIsPrecondition: 'missing secret surfaces as failed-precondition',
  missingMentionsSecret: 'missing-secret message names the secret to set',
  upstreamIsInternal: 'upstream provider failure surfaces as internal',
  upstreamHidesDetail: 'upstream provider detail is NOT forwarded to the client',
  redactsSk: 'redact() strips Anthropic-shaped keys',
  redactsAq: 'redact() strips AI-Studio-shaped keys',
  redactsAiza: 'redact() strips Google-API-shaped keys',
  keepsMessage: 'redact() preserves ordinary diagnostic text',
};
for (const [k, label] of Object.entries(expect)) check(label, res[k] === true);

// ── 5. Unrelated Functions still load without either secret ─────────────
{
  // admin.initializeApp() runs at module load and needs a database URL —
  // that is an ordinary Firebase requirement, not a secrets one. Supply a
  // placeholder config so this asserts what it claims to: the module
  // loads with NEITHER provider secret present.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.GEMINI_API_KEY;
  env.GCLOUD_PROJECT = 'demo-secret-probe';
  env.FIREBASE_CONFIG = JSON.stringify({
    projectId: 'demo-secret-probe',
    databaseURL: 'https://demo-secret-probe-default-rtdb.firebaseio.com',
    storageBucket: 'demo-secret-probe.appspot.com',
  });
  let loaded = false;
  try {
    execFileSync(process.execPath, ['-e', `
      process.env.FUNCTIONS_CONTROL_API = 'true';
      const m = require('./lib/index.js');
      if (process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY) throw new Error('probe env leaked a secret');
      if (typeof m.parseJsaPdf === 'undefined') throw new Error('parseJsaPdf missing');
      if (typeof m.eQuipmentDVIR === 'undefined') throw new Error('eQuipmentDVIR missing');
      console.log('loaded');
    `], { cwd: FN, env, encoding: 'utf8', stdio: 'pipe' });
    loaded = true;
  } catch (e) {
    loaded = false;
    console.log('   load detail:', String(e.message).split('\n')[0].slice(0, 160));
  }
  check('the Functions module loads with neither provider secret present', loaded);
}

// ── 6. No credential material in tracked source/tests/docs ──────────────
{
  let hits = '';
  try {
    hits = execFileSync('git', ['-C', root, 'grep', '-lIE',
      'sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{20,}|AQ\\.[A-Za-z0-9_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----',
      '--', '.'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { /* git grep exits 1 when nothing matches */ }
  check('no real-shaped provider credential in tracked files', hits === '', hits);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
