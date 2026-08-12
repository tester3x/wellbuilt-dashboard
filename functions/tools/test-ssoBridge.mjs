/**
 * vc51.9J — SSO authorization-code bridge: server behavior matrix.
 *
 * Runs the real handlers against an in-memory SsoDeps with injected
 * clock, randomness, and a transaction implementation that reproduces
 * Firestore's create/update semantics (create fails if present, update
 * fails if absent) and lets a test interleave two concurrent exchanges.
 *
 * Run: npm run build && node tools/test-ssoBridge.mjs
 */
import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import { handleSsoIssueCode } from '../lib/sso/ssoIssueHandler.js';
import { handleSsoExchange } from '../lib/sso/ssoExchangeHandler.js';
import {
  SSO_AUDIENCE_WBT, SSO_AUDIENCE_EQUIPMENT,
  SSO_PROTOCOL_VERSION, SSO_CODE_TTL_MS_PROVISIONAL,
  SSO_SESSION_APP_CLAIM, SSO_SESSION_APP_WBT,
} from '@tester3x/wellbuilt-contracts';
import { ssoCodePath } from '../lib/sso/ssoDeps.js';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const sha256Hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const challengeFor = (verifier) =>
  createHash('sha256').update(verifier, 'utf8').digest('base64url');

/** In-memory store with Firestore create/update semantics. */
function makeWorld(opts = {}) {
  const docs = new Map();
  const logs = [];
  let now = opts.startMs ?? 1_700_000_000_000;
  let counter = 0;
  const drivers = new Map(
    opts.drivers ?? [[
      'driver-1',
      { driverId: 'driver-1', companyId: 'co-1', active: true, displayName: 'Mike S' },
    ]],
  );
  /** Set to delay the read inside a transaction, to interleave two. */
  let readBarrier = null;

  const deps = {
    nowMs: () => now,
    randomBytes: (n) => {
      // Deterministic but distinct per call, so two issuances differ.
      counter += 1;
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = (i * 7 + counter * 31) & 0xff;
      return out;
    },
    sha256Hex,
    base64Url: b64url,
    // Stand-in for Firestore Timestamp: an object the client could not
    // have supplied, so the test can prove server ownership.
    expiresAtTimestamp: (ms) => ({ __timestamp: true, ms }),
    getDriver: async (id) => drivers.get(id) ?? null,
    // Commercial-entitlement inputs. The default is an ENTITLED company:
    // a real contract naming a real plan that simply predates the `apps`
    // field, which resolves LEGACY_UNCONFIGURED and issues exactly as
    // before. That keeps this matrix about the bridge itself. Entitlement
    // refusals — including the no-contract case, which now denies — are
    // exercised in test-ssoEntitlement.mjs.
    getCompanyContract: async (companyId) =>
      opts.contracts?.get(companyId)
      ?? { state: 'active', contract: { planId: 'plan-1', contractEnforced: true } },
    getPlan: async (planId) => opts.plans?.get(planId) ?? {
      contractVersion: 1, planId, displayName: 'P', capabilities: [], status: 'active',
    },
    getShiftAuthority: async (driverId) => opts.shiftAuthority?.get(driverId) ?? null,
    runTransaction: async (fn) => {
      // Optimistic-concurrency emulation: snapshot versions read during
      // the attempt, then commit only if nothing changed underneath.
      for (let attempt = 0; attempt < 5; attempt++) {
        const readVersions = new Map();
        const writes = [];
        const tx = {
          get: async (path) => {
            if (readBarrier) await readBarrier;
            const d = docs.get(path);
            readVersions.set(path, d ? d.version : -1);
            return d ? { exists: true, data: { ...d.data } } : { exists: false };
          },
          update: (path, fields) => writes.push({ kind: 'update', path, fields }),
          create: (path, data) => writes.push({ kind: 'create', path, data }),
        };
        const result = await fn(tx);
        let conflict = false;
        for (const [path, version] of readVersions) {
          const cur = docs.get(path);
          if ((cur ? cur.version : -1) !== version) { conflict = true; break; }
        }
        if (conflict) continue;
        for (const w of writes) {
          const cur = docs.get(w.path);
          if (w.kind === 'create') {
            if (cur) throw new Error('ALREADY_EXISTS');
            docs.set(w.path, { version: 0, data: { ...w.data } });
          } else {
            if (!cur) throw new Error('NOT_FOUND');
            docs.set(w.path, { version: cur.version + 1, data: { ...cur.data, ...w.fields } });
          }
        }
        return result;
      }
      throw new Error('TX_RETRY_EXHAUSTED');
    },
    mintCustomToken: async (uid, claims) => {
      minted.push({ uid, claims });
      return `custom.${uid}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
    },
    log: (event, fields) => logs.push({ event, fields }),
  };
  const minted = [];
  return {
    deps, docs, logs, minted, drivers,
    advance: (ms) => { now += ms; },
    setNow: (ms) => { now = ms; },
    setBarrier: (p) => { readBarrier = p; },
  };
}

const AUTH_OK = {
  uid: 'driver_abc',
  claims: { kind: 'driver', driverId: 'driver-1', companyId: 'co-1' },
};
const VERIFIER = 'v'.repeat(43);
const issueReq = (over = {}) => ({
  protocolVersion: SSO_PROTOCOL_VERSION,
  audience: SSO_AUDIENCE_WBT,
  codeChallenge: challengeFor(VERIFIER),
  codeChallengeMethod: 'S256',
  ...over,
});
const exchangeReq = (code, over = {}) => ({
  protocolVersion: SSO_PROTOCOL_VERSION,
  audience: SSO_AUDIENCE_WBT,
  code,
  codeVerifier: VERIFIER,
  ...over,
});

const rejects = async (fn) => {
  try { await fn(); return null; } catch (e) { return e; }
};

// ══ issuance ═════════════════════════════════════════════════════════════
{
  const w = makeWorld();
  const err = await rejects(() => handleSsoIssueCode(w.deps, { uid: null, claims: {} }, issueReq()));
  check('unauthenticated issuance rejected', err?.code === 'unauthenticated');
  check('unauthenticated issuance wrote nothing', w.docs.size === 0);
}
{
  const w = makeWorld();
  for (const [label, claims] of [
    ['wrong kind', { kind: 'admin', driverId: 'driver-1', companyId: 'co-1' }],
    ['missing driverId', { kind: 'driver', companyId: 'co-1' }],
    ['empty driverId', { kind: 'driver', driverId: '', companyId: 'co-1' }],
    ['missing companyId', { kind: 'driver', driverId: 'driver-1' }],
    ['non-string driverId', { kind: 'driver', driverId: 42, companyId: 'co-1' }],
  ]) {
    const err = await rejects(() => handleSsoIssueCode(w.deps, { uid: 'u', claims }, issueReq()));
    check(`issuance rejected: ${label}`, err?.code === 'permission-denied');
  }
  check('no record written for any rejected claim shape', w.docs.size === 0);
}
{
  const w = makeWorld({ drivers: [] });
  const err = await rejects(() => handleSsoIssueCode(w.deps, AUTH_OK, issueReq()));
  check('authoritative record absent rejected', err?.code === 'permission-denied');
}
{
  const w = makeWorld({ drivers: [['driver-1', { driverId: 'driver-1', companyId: 'co-1', active: false }]] });
  const err = await rejects(() => handleSsoIssueCode(w.deps, AUTH_OK, issueReq()));
  check('inactive driver rejected', err?.code === 'permission-denied');
}
{
  const w = makeWorld({ drivers: [['driver-1', { driverId: 'driver-1', companyId: 'co-OTHER', active: true }]] });
  const err = await rejects(() => handleSsoIssueCode(w.deps, AUTH_OK, issueReq()));
  check('claims/authoritative company mismatch rejected', err?.code === 'permission-denied');
}
{
  const w = makeWorld();
  for (const [label, over] of [
    ['wrong audience', { audience: 'evil-app' }],
    ['wrong protocol version', { protocolVersion: 2 }],
    ['plain method', { codeChallengeMethod: 'plain' }],
    ['malformed challenge', { codeChallenge: 'too-short' }],
    ['empty challenge', { codeChallenge: '' }],
  ]) {
    const err = await rejects(() => handleSsoIssueCode(w.deps, AUTH_OK, issueReq(over)));
    check(`issuance rejected: ${label}`, err?.code === 'invalid-argument', String(err?.publicCode));
  }
}
{
  const w = makeWorld();
  for (const field of ['uid', 'driverId', 'companyId', 'driverHash', 'passcode']) {
    const err = await rejects(() =>
      handleSsoIssueCode(w.deps, AUTH_OK, issueReq({ [field]: 'attacker-supplied' })));
    check(`client-supplied '${field}' is a hard reject`, err?.code === 'invalid-argument');
  }
}
{
  const w = makeWorld();
  const res = await handleSsoIssueCode(w.deps, AUTH_OK, issueReq());
  check('issuance returns a 43-char base64url code', /^[A-Za-z0-9_-]{43}$/.test(res.code));
  check('issuance returns expiry for UX', res.expiresInSeconds === SSO_CODE_TTL_MS_PROVISIONAL / 1000);
  check('exactly one record written', w.docs.size === 1);

  const [path, doc] = [...w.docs.entries()][0];
  const stored = JSON.stringify(doc.data);
  check('record is keyed by the code HASH, not the code', path.endsWith(sha256Hex(res.code)));
  check('stored record does NOT contain the raw code', !stored.includes(res.code));
  check('stored record contains the code hash', doc.data.codeHash === sha256Hex(res.code));
  check('record binds the AUTH-CONTEXT uid', doc.data.uid === AUTH_OK.uid);
  check('record binds authoritative driver/company',
    doc.data.driverId === 'driver-1' && doc.data.companyId === 'co-1');
  check('record binds audience, challenge, protocol',
    doc.data.audience === SSO_AUDIENCE_WBT
    && doc.data.codeChallenge === challengeFor(VERIFIER)
    && doc.data.protocolVersion === SSO_PROTOCOL_VERSION);
  check('record binds server-issued times and starts unconsumed',
    typeof doc.data.issuedAtMs === 'number' && doc.data.expiresAtMs > doc.data.issuedAtMs
    && doc.data.consumed === false);
  check('record carries a Firestore-native expiry field for the TTL policy',
    doc.data.expiresAt && doc.data.expiresAt.__timestamp === true);
  check('the TTL field mirrors the numeric expiry exactly',
    doc.data.expiresAt.ms === doc.data.expiresAtMs);
  check('record has a SHORT ttl', doc.data.expiresAtMs - doc.data.issuedAtMs <= 300_000);
  check('record stores no token/passcode material',
    !/idToken|refreshToken|customToken|passcode|hash"/i.test(stored.replace(/codeHash/g, '')));

  const logged = JSON.stringify(w.logs);
  check('issuance log omits the raw code', !logged.includes(res.code));
  check('issuance log omits the challenge', !logged.includes(challengeFor(VERIFIER)));
}

// ══ exchange ═════════════════════════════════════════════════════════════
{
  const w = makeWorld();
  const { code } = await handleSsoIssueCode(w.deps, AUTH_OK, issueReq());
  const res = await handleSsoExchange(w.deps, exchangeReq(code));
  check('successful exchange returns a custom token', typeof res.customToken === 'string' && res.customToken.length > 0);
  check('exchange returns authoritative identity for immediate matching',
    res.uid === AUTH_OK.uid && res.driverId === 'driver-1' && res.companyId === 'co-1');
  check('minted token targets the bound uid', w.minted[0].uid === AUTH_OK.uid);
  check('minted claims carry kind/driverId/companyId',
    w.minted[0].claims.kind === 'driver'
    && w.minted[0].claims.driverId === 'driver-1'
    && w.minted[0].claims.companyId === 'co-1');
  check('minted claims carry the per-session app marker',
    w.minted[0].claims[SSO_SESSION_APP_CLAIM] === SSO_SESSION_APP_WBT);
  check('no anonymous or hash fallback claim exists',
    !('driverHash' in w.minted[0].claims) && !('anonymous' in w.minted[0].claims));

  const doc = [...w.docs.values()][0];
  check('the code is consumed exactly once', doc.data.consumed === true);
  check('consumption is timestamped by the server', typeof doc.data.consumedAtMs === 'number');

  check('the tickets exchange returns the authoritative display name',
    res.displayName === 'Mike S');
  check('the name is NOT put in the minted claims (it is not authority)',
    !('displayName' in w.minted[0].claims));
  check('no other profile field rides along', (() => {
    const allowed = ['protocolVersion', 'customToken', 'uid', 'driverId', 'companyId', 'displayName'];
    return Object.keys(res).every((k) => allowed.includes(k));
  })());

  // Sequential replay.
  const err = await rejects(() => handleSsoExchange(w.deps, exchangeReq(code)));
  check('sequential replay rejected', err?.code === 'permission-denied');
  check('replay returns the GENERIC error', err?.publicCode === 'invalid_grant');
  check('only one token was ever minted', w.minted.length === 1);
}

// ══ authoritative display name ═══════════════════════════════════════════
// WB-T persists a local identity and needs a name. It must come from the
// server's own record, must be omitted rather than invented when unusable,
// and must never reach an audience with no use for it.
{
  const w = makeWorld();
  const { code } = await handleSsoIssueCode(w.deps, AUTH_OK, issueReq());
  const res = await handleSsoExchange(w.deps, exchangeReq(code));
  check('the name comes from the SERVER record, not the request',
    res.displayName === 'Mike S'
    // The request carries no name at all and cannot: nothing in exchangeReq
    // names the driver, and issuance rejects client identity fields.
    && !('displayName' in exchangeReq(code)));
}
{
  const w = makeWorld();
  const { code } = await handleSsoIssueCode(w.deps, AUTH_OK, issueReq());
  const res = await handleSsoExchange(w.deps, exchangeReq(code, { displayName: 'Attacker' }));
  check('a client-supplied name in the request is ignored entirely',
    res.displayName === 'Mike S');
}
for (const [label, value] of [
  ['absent', undefined],
  ['null', null],
  ['blank', ''],
  ['whitespace only', '  '],
  ['a control character', `Mike${String.fromCharCode(0)}`],
  ['over the length bound', 'x'.repeat(121)],
]) {
  const w = makeWorld({
    drivers: [['driver-1', { driverId: 'driver-1', companyId: 'co-1', active: true, displayName: value }]],
  });
  const { code } = await handleSsoIssueCode(w.deps, AUTH_OK, issueReq());
  const res = await handleSsoExchange(w.deps, exchangeReq(code));
  check(`an unusable name (${label}) is OMITTED, never invented`,
    !('displayName' in res));
  // The grant is already valid and already consumed. A profile-data gap must
  // never be reported to the driver as a refusal.
  check(`an unusable name (${label}) still yields a usable session`,
    typeof res.customToken === 'string' && res.customToken.length > 0
    && res.driverId === 'driver-1' && res.companyId === 'co-1');
}
{
  const w = makeWorld({
    drivers: [['driver-1', { driverId: 'driver-1', companyId: 'co-1', active: true, displayName: '  Mike   S ' }]],
  });
  const { code } = await handleSsoIssueCode(w.deps, AUTH_OK, issueReq());
  const res = await handleSsoExchange(w.deps, exchangeReq(code));
  check('the returned name is normalized before it leaves the server',
    res.displayName === 'Mike S');
}
{
  // EQUIPMENT RESPONSE SHAPE IS UNCHANGED. The code record is seeded
  // directly rather than issued, because equipment issuance needs contract
  // and shift-day authority that is out of scope here — the exchange path
  // is what this asserts.
  const w = makeWorld();
  const raw = 'e'.repeat(43);
  w.docs.set(ssoCodePath(sha256Hex(raw)), {
    version: 0,
    data: {
      codeHash: sha256Hex(raw),
      uid: AUTH_OK.uid,
      driverId: 'driver-1',
      companyId: 'co-1',
      audience: SSO_AUDIENCE_EQUIPMENT,
      codeChallenge: challengeFor(VERIFIER),
      protocolVersion: SSO_PROTOCOL_VERSION,
      issuedAtMs: w.deps.nowMs(),
      expiresAtMs: w.deps.nowMs() + SSO_CODE_TTL_MS_PROVISIONAL,
      consumed: false,
      shiftBinding: { shiftId: '2026-08-08_211725', phase: 'pre_trip' },
    },
  });
  const res = await handleSsoExchange(w.deps, {
    protocolVersion: SSO_PROTOCOL_VERSION,
    audience: SSO_AUDIENCE_EQUIPMENT,
    code: raw,
    codeVerifier: VERIFIER,
  });
  check('the equipment exchange still succeeds', typeof res.customToken === 'string');
  check('equipment is NOT told the display name — no use, no exposure',
    !('displayName' in res));
  check('equipment still receives its server-stored shift binding',
    res.shiftBinding?.shiftId === '2026-08-08_211725');
  check('the equipment response shape is byte-for-byte what it always was', (() => {
    const before = ['protocolVersion', 'customToken', 'uid', 'driverId', 'companyId', 'shiftBinding'];
    return Object.keys(res).sort().join(',') === before.sort().join(',');
  })());
}
{
  const w = makeWorld();
  const err = await rejects(() => handleSsoExchange(w.deps, exchangeReq('z'.repeat(43))));
  check('nonexistent code rejected generically', err?.publicCode === 'invalid_grant');
  check('nonexistent code does not reveal absence', err?.publicCode !== 'not_found');
}
{
  const w = makeWorld();
  const { code } = await handleSsoIssueCode(w.deps, AUTH_OK, issueReq());
  w.advance(SSO_CODE_TTL_MS_PROVISIONAL + 1);
  const err = await rejects(() => handleSsoExchange(w.deps, exchangeReq(code)));
  check('expired code rejected by SERVER time', err?.publicCode === 'invalid_grant');
  check('expired code was NOT consumed', [...w.docs.values()][0].data.consumed === false);
  check('expiry reason reaches the log only',
    w.logs.some((l) => l.fields.reason === 'expired'));
}
{
  const w = makeWorld();
  const { code } = await handleSsoIssueCode(w.deps, AUTH_OK, issueReq());
  const err = await rejects(() => handleSsoExchange(w.deps, exchangeReq(code, { codeVerifier: 'w'.repeat(43) })));
  check('wrong verifier rejected', err?.publicCode === 'invalid_grant');
  check('wrong verifier does NOT burn the live code (no free DoS)',
    [...w.docs.values()][0].data.consumed === false);
  // ...and the real client can still complete.
  const res = await handleSsoExchange(w.deps, exchangeReq(code));
  check('the legitimate holder can still redeem after a wrong-verifier attempt',
    typeof res.customToken === 'string');
}
{
  const w = makeWorld();
  const { code } = await handleSsoIssueCode(w.deps, AUTH_OK, issueReq());
  for (const [label, over] of [
    ['wrong audience', { audience: 'evil-app' }],
    ['wrong protocol version', { protocolVersion: 2 }],
    ['malformed code', { code: 'short' }],
    ['malformed verifier', { codeVerifier: 'short' }],
  ]) {
    const err = await rejects(() => handleSsoExchange(w.deps, exchangeReq(code, over)));
    check(`exchange rejected: ${label}`, err !== null);
  }
  check('none of those consumed the record', [...w.docs.values()][0].data.consumed === false);
}
{
  // Simultaneous exchange: both transactions read before either commits.
  const w = makeWorld();
  const { code } = await handleSsoIssueCode(w.deps, AUTH_OK, issueReq());
  let release;
  const barrier = new Promise((r) => { release = r; });
  w.setBarrier(barrier);
  const a = rejects(() => handleSsoExchange(w.deps, exchangeReq(code)));
  const b = rejects(() => handleSsoExchange(w.deps, exchangeReq(code)));
  await new Promise((r) => setImmediate(r));
  w.setBarrier(null);
  release();
  const [ra, rb] = await Promise.all([a, b]);
  const successes = [ra, rb].filter((e) => e === null).length;
  check('simultaneous exchange permits exactly one success', successes === 1, `got ${successes}`);
  check('simultaneous exchange minted exactly one token', w.minted.length === 1);
  check('the loser got the generic error',
    [ra, rb].filter(Boolean).every((e) => e.publicCode === 'invalid_grant'));
}
{
  const w = makeWorld();
  const { code } = await handleSsoIssueCode(w.deps, AUTH_OK, issueReq());
  w.drivers.set('driver-1', { driverId: 'driver-1', companyId: 'co-1', active: false });
  const err = await rejects(() => handleSsoExchange(w.deps, exchangeReq(code)));
  check('driver disabled between issuance and exchange rejected', err?.publicCode === 'invalid_grant');
  check('no token minted for a disabled driver', w.minted.length === 0);
  check('the code is still consumed (no retry into a second success)',
    [...w.docs.values()][0].data.consumed === true);
}
{
  const w = makeWorld();
  const { code } = await handleSsoIssueCode(w.deps, AUTH_OK, issueReq());
  w.drivers.set('driver-1', { driverId: 'driver-1', companyId: 'co-MOVED', active: true });
  const err = await rejects(() => handleSsoExchange(w.deps, exchangeReq(code)));
  check('company changed between issuance and exchange rejected', err?.publicCode === 'invalid_grant');
  check('no token minted after company drift', w.minted.length === 0);
}
{
  const w = makeWorld();
  w.drivers.set('driver-1', { driverId: 'driver-1', companyId: 'co-1', active: true });
  const { code } = await handleSsoIssueCode(w.deps, AUTH_OK, issueReq());
  w.drivers.delete('driver-1');
  const err = await rejects(() => handleSsoExchange(w.deps, exchangeReq(code)));
  check('driver deleted between issuance and exchange rejected', err?.publicCode === 'invalid_grant');
}

// ══ sensitive-value census across the whole flow ═════════════════════════
{
  const w = makeWorld();
  const { code } = await handleSsoIssueCode(w.deps, AUTH_OK, issueReq());
  await handleSsoExchange(w.deps, exchangeReq(code));
  const logged = JSON.stringify(w.logs);
  const stored = JSON.stringify([...w.docs.values()]);
  for (const [label, secret] of [
    ['raw code', code],
    ['PKCE verifier', VERIFIER],
    ['custom token', w.minted[0] ? `custom.${AUTH_OK.uid}` : 'n/a'],
  ]) {
    check(`logs contain no ${label}`, !logged.includes(secret));
  }
  check('storage contains no raw code', !stored.includes(code));
  check('storage contains no verifier', !stored.includes(VERIFIER));
  check('storage contains no custom token', !/custom\./.test(stored));
  check('no log field is named for a secret',
    !/"(code|verifier|codeVerifier|token|customToken|passcode|hash)"\s*:/.test(
      logged.replace(/"codeHashPrefix"/g, '"_"')));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
