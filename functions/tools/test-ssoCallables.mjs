/**
 * vc51.9J-C1 — production wrapper and export census.
 *
 * These test the WRAPPERS, not the injected cores: that the real entry
 * point exports both callables, that issuance requires Auth and exchange
 * does not, that buildSsoDeps wires the intended Admin-SDK paths, and
 * that setCustomUserClaims is nowhere in the exchange path.
 *
 * Source-level rather than by importing lib/index.js: that module calls
 * admin.database() at load and needs a live Database URL, which this
 * packet must not require.
 *
 * Run: npm run build && node tools/test-ssoCallables.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FN = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};
const read = (p) => readFileSync(join(FN, p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const indexSrc = strip(read('src/index.ts'));
const callSrc = read('src/sso/ssoCallables.ts');
const call = strip(callSrc);
const exchangeSrc = strip(read('src/sso/ssoExchangeHandler.ts'));
const issueSrc = strip(read('src/sso/ssoIssueHandler.ts'));
const depsSrc = strip(read('src/sso/ssoDeps.ts'));
const libIndex = read('lib/index.js');

// ── 1. Export census ──────────────────────────────────────────────────────
export const SSO_CALLABLE_EXPORTS = Object.freeze([
  'ssoIssueAuthorizationCode',
  'ssoExchangeAuthorizationCode',
]);

for (const name of SSO_CALLABLE_EXPORTS) {
  check(`'${name}' is exported from the real entry point`,
    new RegExp(`export \\{[^}]*\\b${name}\\b[^}]*\\} from './sso/ssoCallables'`).test(indexSrc));
  check(`'${name}' is defined as an onCall in ssoCallables`,
    new RegExp(`export const ${name} = httpsV2\\.onCall\\(`).test(call));
  check(`'${name}' survives into the compiled bundle`, libIndex.includes(name));
}
check('exactly two SSO callables are exported', (indexSrc.match(/sso[A-Z]\w+/g) || [])
  .filter((n) => n.startsWith('ssoIssue') || n.startsWith('ssoExchange')).length === 2);
check('no other sso symbol leaks out of the entry point',
  !/export \{[^}]*\b(buildSsoDeps|handleSsoIssueCode|handleSsoExchange|SsoError)\b/.test(indexSrc));

// ── 2. Wrapper configuration ──────────────────────────────────────────────
check('both callables use one shared options object',
  (call.match(/httpsV2\.onCall\(\s*SSO_CALLABLE_OPTIONS/g) || []).length === 2);
check('timeout is bounded', /timeoutSeconds:\s*30/.test(call));
check('memory is declared', /memory:\s*'256MiB'/.test(call));
check('App Check rollout state is PRESERVED, not silently enforced',
  /enforceAppCheck:\s*false/.test(call));
{
  // The same posture as the rest of the project — a divergence here would
  // be a silent rollout change.
  const admin = strip(read('src/admin/callables.ts'));
  const adminAppCheck = /enforceAppCheck:\s*(true|false)/.exec(admin)?.[1];
  const ssoAppCheck = /enforceAppCheck:\s*(true|false)/.exec(call)?.[1];
  check('SSO App Check posture matches the admin callables', adminAppCheck === ssoAppCheck,
    `admin=${adminAppCheck} sso=${ssoAppCheck}`);
}

// ── 3. Authentication asymmetry ───────────────────────────────────────────
{
  const issueBody = call.slice(call.indexOf('export const ssoIssueAuthorizationCode'),
    call.indexOf('export const ssoExchangeAuthorizationCode'));
  const exchangeBody = call.slice(call.indexOf('export const ssoExchangeAuthorizationCode'));

  check('issuance rejects anonymous callers in the WRAPPER',
    /if \(!request\.auth\?\.uid\)/.test(issueBody)
    && /'unauthenticated'/.test(issueBody));
  check('issuance passes request.auth.uid to the handler',
    /uid: request\.auth\.uid/.test(issueBody));
  check('issuance passes request.auth.token as the claims source',
    /claims: \(request\.auth\.token \|\| \{\}\)/.test(issueBody));
  check('issuance never reads identity from request.data',
    !/request\.data\.(uid|driverId|companyId)/.test(issueBody));

  check('exchange does NOT require callable Auth',
    !/request\.auth\?\.uid\)/.test(exchangeBody) && !/'unauthenticated'/.test(exchangeBody));
  check('exchange passes only request.data to the handler',
    /handleSsoExchange\(buildSsoDeps\(\), request\.data\)/.test(exchangeBody));
  check('exchange does not fabricate an auth context',
    !/uid:\s*request\.auth/.test(exchangeBody));

  check('issuance is rate limited by UID, not IP',
    /bucket: 'sso_issue'[\s\S]{0,80}key: request\.auth\.uid/.test(issueBody));
  check('exchange is rate limited by IP hash (no UID exists yet)',
    /bucket: 'sso_exchange'[\s\S]{0,80}key: clientIpHash\(request\)/.test(exchangeBody));
  check('rate-limit rejection uses the generic code on exchange',
    /'resource-exhausted', 'invalid_grant'/.test(exchangeBody));
}

// ── 4. Dependency construction wires the REAL Admin SDK ───────────────────
check('deps use the real Firestore transaction', /db\.runTransaction\(/.test(call));
check('transaction adapter maps create/update onto real doc refs',
  /update\(path, fields\) \{ tx\.update\(db\.doc\(path\), fields\); \}/.test(call)
  && /create\(path, data\) \{ tx\.create\(db\.doc\(path\), data\); \}/.test(call));
// Authoritative driver liveness lives in the shared neutral module
// (canonicalDriverAuthority) so SSO and verifyDriverSession cannot drift.
const authz = strip(read('src/security/canonicalDriverAuthority.ts'));
check('authoritative driver read hits driver_credentials',
  /collection\('driver_credentials'\)\.doc\(driverId\)/.test(authz)
  && /getAuthoritativeDriverForSso/.test(call));
check('authoritative company read hits the RTDB profile',
  /drivers\/profiles\/\$\{driverId\}/.test(authz)
  && /getAuthoritativeDriverForSso/.test(call));
check('liveness uses the established active !== false test',
  /active !== false/.test(authz)
  && /credentialsActive && profileActive/.test(authz));
check('randomness is node crypto, not Math.random',
  /randomBytes\(count\)/.test(call) && !/Math\.random/.test(call));
check('hashing is SHA-256 via node crypto',
  /createHash\('sha256'\)/.test(call));
check('server clock is Date.now', /nowMs: \(\) => Date\.now\(\)/.test(call));
check('token minting goes through admin.auth().createCustomToken',
  /admin\.auth\(\)\.createCustomToken\(uid, developerClaims\)/.test(call));

// ── 5. THE claim-scope invariant ──────────────────────────────────────────
check('setCustomUserClaims appears NOWHERE in the exchange path',
  !/setCustomUserClaims/.test(exchangeSrc)
  && !/setCustomUserClaims/.test(call)
  && !/setCustomUserClaims/.test(depsSrc));
check('the deps contract forbids it in writing',
  /MUST NOT call setCustomUserClaims/.test(read('src/sso/ssoDeps.ts')));
check('mintCustomToken receives developer claims only',
  /mintCustomToken\(uid: string, developerClaims: Record<string, unknown>\)/.test(depsSrc));
check('the exchange mints with kind/driverId/companyId plus the app marker',
  /mintCustomToken\(record\.uid, \{[\s\S]{0,200}kind: 'driver'[\s\S]{0,200}SSO_SESSION_APP_CLAIM\]: SSO_SESSION_APP_BY_AUDIENCE/.test(exchangeSrc));
check('the minted uid is the RECORD uid, never client-supplied',
  /mintCustomToken\(record\.uid/.test(exchangeSrc));
check('issuance never mints a token at all', !/mintCustomToken/.test(issueSrc));

// ── 6. Error and log discipline ───────────────────────────────────────────
check('handler failures map to bounded callable errors',
  /new httpsV2\.HttpsError\(err\.code, err\.publicCode/.test(call));
check('unexpected failures collapse to internal',
  /new httpsV2\.HttpsError\('internal', 'internal'/.test(call));
check('the internal reason is logged, never returned',
  /console\.warn\('\[sso\] rejected:', err\.publicCode, '\|', err\.internalReason\)/.test(call)
  && !/details[\s\S]{0,60}internalReason/.test(call));
check('the deps logger strips secret-looking fields',
  /verifier\|challenge\|token\|passcode/.test(call));
check('codeHashPrefix survives redaction (it is the correlation key)',
  /k !== 'codeHashPrefix'/.test(call));
{
  // A full callback URL must never be logged anywhere on the server.
  const all = [call, exchangeSrc, issueSrc].join('\n');
  check('no server log emits a URL', !/console\.[a-z]+\([^)]*:\/\//.test(all));
  check('no server log emits a raw code or verifier',
    !/console\.[a-z]+\([^)]*\b(req\.code|record\.codeHash|codeVerifier|customToken)\b/.test(all));
}

// ── 7. Handlers stay independently testable ───────────────────────────────
check('handlers take injected deps, not admin directly',
  !/firebase-admin/.test(exchangeSrc) && !/firebase-admin/.test(issueSrc));
check('only the wrapper imports firebase-admin', /from 'firebase-admin'/.test(call));
check('handlers are exported for direct testing',
  /export async function handleSsoIssueCode/.test(issueSrc)
  && /export async function handleSsoExchange/.test(exchangeSrc));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
