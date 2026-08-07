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
// vc51.9L-C1: a module-scope defineSecret is a codebase-GLOBAL Firebase
// parameter, and the CLI resolves EVERY declared parameter during source
// analysis, before applying an --only filter. With one secret holding no
// version and the other absent, that made the whole codebase undeployable
// — including three Auth Functions that touch neither provider. Bindings
// are string names now, validated per-Function at deploy time.
check('ANTHROPIC_API_KEY is a string NAME, not a global param',
  /export const ANTHROPIC_API_KEY = 'ANTHROPIC_API_KEY' as const;/.test(secretsSrc));
check('no global defineSecret parameter exists anywhere in src',
  !/defineSecret/.test(secretsSrc.replace(/\/\*[\s\S]*?\*\//g, '')));
check("no module imports firebase-functions/params",
  !/from 'firebase-functions\/params'/.test(secretsSrc));
// This originally asserted GEMINI_API_KEY was deliberately undefined,
// which was true of the source tree but WRONG about the deployed code:
// the photo-compliance Functions were live and absent locally. They are
// restored, so the consumer is real and the secret must exist — but it
// must still reach ONLY those two Functions.
check('GEMINI_API_KEY is defined (photo-compliance consumes it)',
  /export const GEMINI_API_KEY = 'GEMINI_API_KEY' as const;/.test(secretsSrc));

// Only parseJsaPdf may declare a secrets binding.
const bindings = [...indexSrc.matchAll(/export const (\w+)\s*=\s*(?:httpsV2|functionsV1|functionsV2)[\s\S]{0,400}?secrets:\s*\[([^\]]*)\]/g)]
  .map((m) => ({ fn: m[1], secrets: m[2].trim() }));
check('exactly one Function in index.ts declares a secret binding', bindings.length === 1,
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
// process.env IS the supported access path for a string-named binding:
// Secret Manager injects the value into the bound Function's runtime and
// nowhere else. What must not exist is a FALLBACK — a default, an ||/??
// alternative, or a literal — so an unset secret still fails closed.
check('readSecret reads the runtime injection by name',
  /const raw = process\.env\[name\];/.test(stripComments(secretsSrc)));
check('readSecret has no default, fallback, or literal',
  !/process\.env\[[^\]]*\]\s*(\|\||\?\?)/.test(stripComments(secretsSrc))
  && !/process\.env\.[A-Z_]+\s*(\|\||\?\?)/.test(stripComments(secretsSrc)));
check('an unset or blank secret still throws MissingSecretError',
  /if \(typeof raw !== 'string' \|\| raw\.trim\(\) === ''\) \{\s*throw new MissingSecretError\(name\);/.test(stripComments(secretsSrc)));
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
  // Drive the REAL access path: set/clear the runtime env the way Secret
  // Manager injects it, rather than faking a param object.
  const mk = (name, v) => {
    if (v === null) delete process.env[name]; else process.env[name] = v;
    return name;
  };
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
// ── vc51.9L-C1: Auth/SSO must be free of AI secrets entirely ────────────
{
  const authSrc = readFileSync(join(FN, 'src', 'security', 'driverAuthCallables.ts'), 'utf8');
  const ssoSrc = readFileSync(join(FN, 'src', 'sso', 'ssoCallables.ts'), 'utf8');
  for (const [label, src] of [['authenticateDriver', authSrc], ['SSO callables', ssoSrc]]) {
    check(`${label} references neither AI secret`,
      !/ANTHROPIC_API_KEY|GEMINI_API_KEY/.test(src));
    check(`${label} declares no secrets binding at all`, !/secrets:\s*\[/.test(src));
  }
}

// ── each AI consumer binds exactly its justified secrets ────────────────
{
  const idx = readFileSync(join(FN, 'src', 'index.ts'), 'utf8');
  const photo = readFileSync(join(FN, 'src', 'photoCompliance.ts'), 'utf8');

  // parseJsaPdf is Anthropic-only and must not gain Gemini access.
  // Comments in the options block mention the other key historically, so
  // strip them before asserting on the actual binding.
  const jsaWindow = idx.slice(idx.indexOf('export const parseJsaPdf'),
    idx.indexOf('export const parseJsaPdf') + 600);
  const jsaOpts = jsaWindow.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  check('parseJsaPdf binds ANTHROPIC_API_KEY only',
    /secrets: \[ANTHROPIC_API_KEY\]/.test(jsaOpts) && !/GEMINI_API_KEY/.test(jsaOpts));

  // Both photo Functions switch provider at runtime, so both binds are
  // justified — that is least privilege at the Function boundary.
  const photoBinds = photo.match(/secrets: \[[^\]]*\]/g) || [];
  check('both photo Functions bind both secrets (runtime provider switch)',
    photoBinds.length === 2
    && photoBinds.every((b) => b.includes('ANTHROPIC_API_KEY') && b.includes('GEMINI_API_KEY')));
  check('exactly three secret bindings exist in the whole codebase', (() => {
    const all = [idx, photo].join('\n').match(/secrets: \[/g) || [];
    return all.length === 3;
  })());
}

// ── no AI secret bound to unrelated Functions ───────────────────────────
{
  const { readdirSync, statSync } = await import('node:fs');
  const offenders = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const fp = join(dir, e.name);
      if (e.isDirectory()) { walk(fp); continue; }
      if (!e.name.endsWith('.ts')) continue;
      if (fp.includes('secrets.ts') || fp.includes('anthropicClient') ) continue;
      const body = readFileSync(fp, 'utf8');
      if (!/secrets:\s*\[/.test(body)) continue;
      if (!/photoCompliance|index\.ts/.test(fp)) offenders.push(fp.replace(FN, ''));
    }
  };
  walk(join(FN, 'src'));
  void statSync;
  check('no unrelated module declares a secrets binding', offenders.length === 0, offenders.join(', '));
}

// ── AI behavior preserved ───────────────────────────────────────────────
{
  const photo = readFileSync(join(FN, 'src', 'photoCompliance.ts'), 'utf8');
  const idxSrcForMapper = readFileSync(join(FN, 'src', 'index.ts'), 'utf8');
  check('Gemini key travels in the x-goog-api-key HEADER',
    (photo.match(/'x-goog-api-key': apiKey/g) || []).length === 2);
  check('Gemini key never appears in a query string',
    !/[?&]key=\$\{?apiKey/.test(photo));
  check('runtime provider switching is unchanged',
    /PHOTO_COMPLIANCE_PROVIDER/.test(photo));
  check('provider failures are logged redacted (server side)',
    (photo.match(/logRedacted\(/g) || []).length >= 2);
  // KNOWN PRE-EXISTING, deliberately unchanged here: the photo Functions
  // still forward `err.message` to the client as
  // "Photo validation failed: ..." rather than going through
  // toSafeProviderError, which is the leak shape secrets.ts was written to
  // remove. Fixing it changes an AI request/response contract and is
  // explicitly out of scope for this correction. Pinned so it is visible
  // and cannot be mistaken for already-fixed.
  check('KNOWN GAP: photo Functions still forward err.message to the client',
    /'Photo validation failed: ' \+ err\?\.message/.test(photo));
  check('the safe mapper exists and is used by the JSA path',
    /toSafeProviderError\(/.test(idxSrcForMapper));
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
