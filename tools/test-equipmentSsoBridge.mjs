/**
 * vc51.9AF — equipment SSO bridge security matrix.
 *
 * Drives the REAL handlers against an in-memory SsoDeps: every binding,
 * refusal, race and replay is observed rather than argued. Nothing here
 * touches Firestore, mints a live code, or reaches the network.
 *
 * The property under test is narrow and absolute: a deep link may carry an
 * opaque single-use reference and nothing else, and the shift a DVIR binds
 * to must be one the SERVER proved was open for that exact driver — never
 * one the client named.
 *
 * Run: node tools/test-equipmentSsoBridge.mjs   (after functions build)
 */
import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lib = (p) => pathToFileURL(join(ROOT, 'functions/lib', p)).href;
// Resolve the contract from FUNCTIONS' dependency tree, not the repo
// root's: the handlers under test are built against the Functions
// contracts mirror, and the root install carries its own pin. Resolving
// from the wrong tree would silently test a different contract version.
const fromFunctions = createRequire(join(ROOT, 'functions', 'package.json'));

const { handleSsoIssueCode } = await import(lib('sso/ssoIssueHandler.js'));
const { handleSsoExchange } = await import(lib('sso/ssoExchangeHandler.js'));
const { ssoCodePath } = await import(lib('sso/ssoDeps.js'));
const P = await import(
  pathToFileURL(fromFunctions.resolve('@tester3x/wellbuilt-contracts')).href);

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const DRIVER = '99ff4b35-51ab-4d45-8d54-18b3b8515c9b';
const COMPANY = 'liquid-gold';
const SHIFT = '2026-08-08_211725';
const DAY = '2026-08-08';
const UID = 'uid-mike';
const NOW = Date.parse('2026-08-08T22:00:00.000Z');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha256Hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const challengeFor = (verifier) => b64u(createHash('sha256').update(verifier, 'utf8').digest());

const PLAN = {
  contractVersion: 1, planId: 'explicit-shift-standard',
  displayName: 'Explicit Shift Standard',
  capabilities: ['explicitShiftLifecycle', 'jsa', 'dvir'], status: 'active',
};
const CONTRACT = {
  contractVersion: 1, configurationVersion: 3, planId: 'explicit-shift-standard',
  entitlementOverrides: [], workPeriodConfiguration: { mode: 'explicit_shift' },
  contractEnforced: true,
};

/** In-memory deps. `o` overrides any piece for a negative case. */
function makeDeps(o = {}) {
  const store = new Map(o.store ?? []);
  const versions = new Map();
  const logs = [];
  let now = o.nowMs ?? NOW;
  const deps = {
    _store: store, _logs: logs,
    setNow: (v) => { now = v; },
    nowMs: () => now,
    randomBytes: (n) => new Uint8Array(nodeRandomBytes(n)),
    sha256Hex,
    base64Url: (bytes) => b64u(bytes),
    expiresAtTimestamp: (ms) => ({ __ts: ms }),
    getDriver: o.getDriver ?? (async () => ({ driverId: DRIVER, companyId: COMPANY, active: true })),
    getShiftDay: o.getShiftDay
      ?? (async (d, date) => (d === DRIVER && date === DAY
        ? { readable: true, present: true, currentShiftId: SHIFT }
        : { readable: true, present: false })),
    getCompanyContract: o.getCompanyContract ?? (async () => ({ state: 'active', contract: CONTRACT })),
    getPlan: o.getPlan ?? (async () => PLAN),
    /**
     * Models Firestore's OPTIMISTIC CONCURRENCY, not just buffered writes.
     *
     * The first version of this mock committed unconditionally, so two
     * concurrent redemptions both "succeeded" — and that looked like a
     * handler defect when it was really the harness failing to model the
     * one mechanism the single-use guarantee rests on. Every document read
     * inside the transaction has its version recorded; if any of them
     * changed before commit, the transaction aborts exactly as Firestore
     * would. Without this the concurrency check proves nothing.
     */
    async runTransaction(fn) {
      const writes = [];
      const readVersions = new Map();
      const tx = {
        get: async (p) => {
          readVersions.set(p, versions.get(p) ?? 0);
          return store.has(p) ? { exists: true, data: store.get(p) } : { exists: false };
        },
        update: (p, f) => { if (!store.has(p)) throw new Error('missing'); writes.push(() => store.set(p, { ...store.get(p), ...f })); },
        create: (p, d) => { if (store.has(p)) throw new Error('exists'); writes.push(() => store.set(p, d)); },
      };
      const out = await fn(tx);
      for (const [p, v] of readVersions) {
        if ((versions.get(p) ?? 0) !== v) throw new Error('ABORTED: concurrent modification');
      }
      writes.forEach((w) => w());
      for (const p of readVersions.keys()) versions.set(p, (versions.get(p) ?? 0) + 1);
      return out;
    },
    mintCustomToken: async (uid, claims) => `token:${uid}:${JSON.stringify(claims)}`,
    log: (event, fields) => logs.push({ event, ...fields }),
  };
  return deps;
}
const AUTH = { uid: UID, claims: { kind: 'driver', driverId: DRIVER, companyId: COMPANY } };

const VERIFIER = 'v'.repeat(43);
const CHALLENGE = challengeFor(VERIFIER);
const eqReq = (over = {}) => ({
  protocolVersion: 1, audience: P.SSO_AUDIENCE_EQUIPMENT,
  codeChallenge: CHALLENGE, codeChallengeMethod: 'S256',
  shiftBinding: { shiftId: SHIFT, phase: 'pre_trip' }, ...over,
});
const wbtReq = (over = {}) => ({
  protocolVersion: 1, audience: P.SSO_AUDIENCE_WBT,
  codeChallenge: CHALLENGE, codeChallengeMethod: 'S256', ...over,
});
const refused = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// ── 1/2. valid equipment Pre-Trip and Post-Trip, end to end ─────────────
for (const phase of ['pre_trip', 'post_trip']) {
  const deps = makeDeps();
  const issued = await handleSsoIssueCode(deps, AUTH, eqReq({ shiftBinding: { shiftId: SHIFT, phase } }));
  check(`1/2. equipment ${phase} issuance succeeds`, !!issued.code && issued.protocolVersion === 1);
  const rec = deps._store.get(ssoCodePath(sha256Hex(issued.code)));
  check(`1/2. ${phase} stored binding is the normalized server value`,
    JSON.stringify(rec.shiftBinding) === JSON.stringify({ shiftId: SHIFT, phase }), JSON.stringify(rec.shiftBinding));
  const ex = await handleSsoExchange(deps, {
    protocolVersion: 1, audience: P.SSO_AUDIENCE_EQUIPMENT, code: issued.code, codeVerifier: VERIFIER,
  });
  check(`1/2. ${phase} exchange returns the stored binding`,
    JSON.stringify(ex.shiftBinding) === JSON.stringify({ shiftId: SHIFT, phase }));
  check(`4. ${phase} identity is the secure UUID from server context`,
    ex.driverId === DRIVER && ex.companyId === COMPANY && ex.uid === UID);
  check(`1/2. ${phase} token carries the equipment app claim`,
    ex.customToken.includes('"app":"equipment"'), ex.customToken.slice(0, 90));
}

// ── 3. WB-T flow unchanged ──────────────────────────────────────────────
{
  const deps = makeDeps();
  const issued = await handleSsoIssueCode(deps, AUTH, wbtReq());
  const rec = deps._store.get(ssoCodePath(sha256Hex(issued.code)));
  check('3. WB-T issuance stores NO shift binding', rec.shiftBinding === undefined);
  const ex = await handleSsoExchange(deps, {
    protocolVersion: 1, audience: P.SSO_AUDIENCE_WBT, code: issued.code, codeVerifier: VERIFIER,
  });
  check('3. WB-T exchange returns no shift binding', !('shiftBinding' in ex));
  check('3. WB-T token still carries the wbt app claim', ex.customToken.includes('"app":"wbt"'));
  check('3. WB-T response shape is unchanged',
    JSON.stringify(Object.keys(ex).sort()) === JSON.stringify(['companyId', 'customToken', 'driverId', 'protocolVersion', 'uid']),
    Object.keys(ex).sort().join(','));
}

// ── 5/6/7/8/27/28. request-shape refusals ───────────────────────────────
check('28. unauthenticated issuance refuses',
  !!(await refused(() => handleSsoIssueCode(makeDeps(), { uid: null, claims: {} }, eqReq()))));
check('5. client identity keys are rejected',
  !!(await refused(() => handleSsoIssueCode(makeDeps(), AUTH, { ...eqReq(), driverId: 'someone-else' }))));
check('6. equipment issuance without a binding refuses',
  !!(await refused(() => handleSsoIssueCode(makeDeps(), AUTH, eqReq({ shiftBinding: undefined })))));
check('7. WB-T issuance carrying a binding refuses',
  !!(await refused(() => handleSsoIssueCode(makeDeps(), AUTH, wbtReq({ shiftBinding: { shiftId: SHIFT, phase: 'pre_trip' } })))));
check('8. invalid phase refuses',
  !!(await refused(() => handleSsoIssueCode(makeDeps(), AUTH, eqReq({ shiftBinding: { shiftId: SHIFT, phase: 'mid_trip' } })))));
{
  // Unknown NON-identity keys are normalized away by the protocol
  // validator rather than refused; what matters is that they never reach
  // storage. Identity keys are a hard refusal, asserted separately above.
  const deps = makeDeps();
  const i = await handleSsoIssueCode(deps, AUTH, { ...eqReq(), extra: 'ignored' });
  const rec = deps._store.get(ssoCodePath(sha256Hex(i.code)));
  check('27. an unknown key is normalized away and never stored', !('extra' in rec));
}
check('20. unknown audience refuses',
  !!(await refused(() => handleSsoIssueCode(makeDeps(), AUTH, eqReq({ audience: 'evil' })))));

// ── 9-16. authoritative shift refusals ──────────────────────────────────
const shiftCase = async (label, over, gate = 'refuse') => {
  const deps = makeDeps(over);
  const err = await refused(() => handleSsoIssueCode(deps, AUTH, eqReq()));
  check(label, gate === 'refuse' ? !!err : !err, err ? err.internalReason : 'accepted');
  return deps;
};
await shiftCase('9. another driver\'s shift refuses (day doc names a different driver)',
  { getShiftDay: async () => ({ readable: true, present: true, currentShiftId: '2026-08-08_090000' }) });
await shiftCase('10. wrong company refuses (driver moved)',
  { getDriver: async () => ({ driverId: DRIVER, companyId: 'other-co', active: true }),
    getCompanyContract: async () => ({ state: 'legacy', contract: null }) });
await shiftCase('11. explicitly closed shift refuses',
  { getShiftDay: async () => ({ readable: true, present: true, currentShiftId: '' }) });
await shiftCase('12. superseded shift refuses',
  { getShiftDay: async () => ({ readable: true, present: true, currentShiftId: '2026-08-08_235959' }) });
await shiftCase('13. missing shift document refuses',
  { getShiftDay: async () => ({ readable: true, present: false }) });
await shiftCase('14. unreadable shift evidence refuses',
  { getShiftDay: async () => ({ readable: false, present: false }) });
{
  // 15. cross-midnight: it is the NEXT day, the shift's own day still names it.
  const deps = makeDeps({ nowMs: Date.parse('2026-08-09T08:00:00.000Z') });
  const issued = await handleSsoIssueCode(deps, AUTH, eqReq());
  check('15. cross-midnight origin-day shift is still authorized', !!issued.code);
  const rec = deps._store.get(ssoCodePath(sha256Hex(issued.code)));
  check('15. and binds the ORIGINAL shift id', rec.shiftBinding.shiftId === SHIFT);
}

// ── 17/18/19. contract and capability refusals ──────────────────────────
await shiftCase('17. DVIR capability disabled refuses',
  { getPlan: async () => ({ ...PLAN, capabilities: ['explicitShiftLifecycle', 'jsa'] }) });
await shiftCase('17b. explicitShiftLifecycle absent refuses',
  { getPlan: async () => ({ ...PLAN, capabilities: ['jsa', 'dvir'] }) });
await shiftCase('18. missing plan refuses', { getPlan: async () => null });
await shiftCase('18b. deprecated plan still computes but is refused only if unusable',
  { getPlan: async () => ({ ...PLAN, status: 'deprecated' }) }, 'accept');
await shiftCase('19. absent contract refuses',
  { getCompanyContract: async () => ({ state: 'legacy', contract: null }) });
await shiftCase('19b. inert (unenforced) contract refuses',
  { getCompanyContract: async () => ({ state: 'active', contract: { ...CONTRACT, contractEnforced: false } }) });
await shiftCase('19c. invalid contract refuses',
  { getCompanyContract: async () => ({ state: 'invalid', contract: null }) });

// ── 21-26. exchange-side matrix ─────────────────────────────────────────
const freshIssued = async (deps) => handleSsoIssueCode(deps, AUTH, eqReq());
{
  const deps = makeDeps(); const i = await freshIssued(deps);
  check('21. wrong verifier refuses', !!(await refused(() => handleSsoExchange(deps, {
    protocolVersion: 1, audience: P.SSO_AUDIENCE_EQUIPMENT, code: i.code, codeVerifier: 'w'.repeat(43) }))));
  check('21. and the code is NOT burned by the wrong verifier',
    deps._store.get(ssoCodePath(sha256Hex(i.code))).consumed === false);
}
{
  const deps = makeDeps(); const i = await freshIssued(deps);
  check('20b. wrong audience at exchange refuses', !!(await refused(() => handleSsoExchange(deps, {
    protocolVersion: 1, audience: P.SSO_AUDIENCE_WBT, code: i.code, codeVerifier: VERIFIER }))));
}
{
  const deps = makeDeps(); const i = await freshIssued(deps);
  deps.setNow(NOW + 3_600_000);
  check('23. expired code refuses', !!(await refused(() => handleSsoExchange(deps, {
    protocolVersion: 1, audience: P.SSO_AUDIENCE_EQUIPMENT, code: i.code, codeVerifier: VERIFIER }))));
}
{
  const deps = makeDeps(); const i = await freshIssued(deps);
  await handleSsoExchange(deps, { protocolVersion: 1, audience: P.SSO_AUDIENCE_EQUIPMENT, code: i.code, codeVerifier: VERIFIER });
  check('24. replay refuses', !!(await refused(() => handleSsoExchange(deps, {
    protocolVersion: 1, audience: P.SSO_AUDIENCE_EQUIPMENT, code: i.code, codeVerifier: VERIFIER }))));
}
{
  const deps = makeDeps(); const i = await freshIssued(deps);
  const both = await Promise.allSettled([
    handleSsoExchange(deps, { protocolVersion: 1, audience: P.SSO_AUDIENCE_EQUIPMENT, code: i.code, codeVerifier: VERIFIER }),
    handleSsoExchange(deps, { protocolVersion: 1, audience: P.SSO_AUDIENCE_EQUIPMENT, code: i.code, codeVerifier: VERIFIER }),
  ]);
  check('25. concurrent redemption yields at most one success',
    both.filter((r) => r.status === 'fulfilled').length <= 1,
    both.map((r) => r.status).join(','));
}
{
  const deps = makeDeps(); const i = await freshIssued(deps);
  deps.getDriver = async () => ({ driverId: DRIVER, companyId: COMPANY, active: false });
  check('26. driver disabled between issuance and exchange refuses',
    !!(await refused(() => handleSsoExchange(deps, {
      protocolVersion: 1, audience: P.SSO_AUDIENCE_EQUIPMENT, code: i.code, codeVerifier: VERIFIER }))));
}
{
  // 29. a tampered stored binding must not reach the response.
  const deps = makeDeps(); const i = await freshIssued(deps);
  const path = ssoCodePath(sha256Hex(i.code));
  deps._store.set(path, { ...deps._store.get(path), shiftBinding: { shiftId: 'evil', phase: 'bogus' } });
  const ex = await handleSsoExchange(deps, {
    protocolVersion: 1, audience: P.SSO_AUDIENCE_EQUIPMENT, code: i.code, codeVerifier: VERIFIER });
  check('29. an unparseable stored binding is dropped, not echoed', !('shiftBinding' in ex), JSON.stringify(ex.shiftBinding));
}

// ── 30. logging hygiene ─────────────────────────────────────────────────
{
  const deps = makeDeps(); const i = await freshIssued(deps);
  await handleSsoExchange(deps, { protocolVersion: 1, audience: P.SSO_AUDIENCE_EQUIPMENT, code: i.code, codeVerifier: VERIFIER });
  const dump = JSON.stringify(deps._logs);
  check('30. no raw code, verifier, token, challenge or URL in logs',
    !dump.includes(i.code) && !dump.includes(VERIFIER) && !dump.includes(CHALLENGE)
    && !/token:|wbequipment:\/\/|wellbuilt-suite:\/\//.test(dump), dump.slice(0, 160));
  check('30. no passcode hash or driver name in logs',
    !/passcode|driverHash|hash"\s*:/i.test(dump));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
