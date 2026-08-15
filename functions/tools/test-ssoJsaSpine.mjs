/**
 * JSA spine — issuance/exchange wiring for the WB-JSA audience.
 *
 * DUAL-MODE by design. The wiring is forward-compatible: against the
 * pinned 0.4.1 contracts mirror the 'wellbuilt-jsa' audience MUST fail
 * closed at the allowlist (nothing minted, nothing exchanged, no jsa
 * branch reachable); once the mirror carries the 0.5.0 audience, the full
 * activation matrix below runs. Both modes are real tests — the first
 * proves the held wiring cannot change today's behavior, the second
 * qualifies the spine at the publish step.
 *
 * Run: node tools/test-ssoJsaSpine.mjs   (after npm run build)
 */
import { createHash } from 'node:crypto';
import { handleSsoIssueCode } from '../lib/sso/ssoIssueHandler.js';
import { handleSsoExchange } from '../lib/sso/ssoExchangeHandler.js';
import { decideJsaBinding, readStoredJsaBinding } from '../lib/sso/jsaAuthorization.js';
import {
  SSO_PROTOCOL_VERSION, SSO_CHALLENGE_METHOD, isSsoAudience,
} from '@tester3x/wellbuilt-contracts';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const JSA_AUDIENCE = 'wellbuilt-jsa';
const DRIVER = 'driver-1';
const COMPANY = 'co-1';
const NOW = 1_700_000_000_000;
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER, 'utf8').digest('base64url');
const AUTH = { uid: 'uid-1', claims: { kind: 'driver', driverId: DRIVER, companyId: COMPANY } };
const REQUEST = {
  protocolVersion: SSO_PROTOCOL_VERSION,
  audience: JSA_AUDIENCE,
  codeChallenge: CHALLENGE,
  codeChallengeMethod: SSO_CHALLENGE_METHOD,
};

const OPEN_AUTHORITY = {
  driverId: DRIVER, companyId: COMPANY, initialized: true,
  openPeriodId: '2026-08-12_073000', originLocalDate: '2026-08-12', version: 3,
};
const EMPTY_AUTHORITY = {
  driverId: DRIVER, companyId: COMPANY, initialized: true,
  openPeriodId: null, originLocalDate: null, version: 1,
};
// A stale JUNE authority shape — inconsistent on purpose (the vc5 defect).
const STALE_AUTHORITY = {
  driverId: DRIVER, companyId: COMPANY, initialized: true,
  openPeriodId: '2026-06-14_080000', originLocalDate: '2026-08-12', version: 2,
};

function makeWorld({ plan = null, contract = null, contractState = 'legacy', authority = null } = {}) {
  const docs = new Map();
  const logs = [];
  let counter = 0;
  const deps = {
    nowMs: () => NOW,
    randomBytes: (n) => { counter += 1; const o = new Uint8Array(n); for (let i = 0; i < n; i++) o[i] = (i * 7 + counter * 31) & 0xff; return o; },
    sha256Hex: (s) => createHash('sha256').update(s, 'utf8').digest('hex'),
    base64Url: (b) => Buffer.from(b).toString('base64url'),
    expiresAtTimestamp: (ms) => ({ __timestamp: true, ms }),
    getDriver: async (id) => (id === DRIVER
      ? {
          driverId: DRIVER, companyId: COMPANY, active: true,
          displayName: 'Mikezfold', legalName: 'Michael S Burger',
        } : null),
    getCompanyContract: async () => ({ state: contractState, contract }),
    getPlan: async () => plan,
    getShiftAuthority: async () => authority,
    getShiftDay: async () => ({ readable: true, present: false }),
    runTransaction: async (fn) => {
      const writes = [];
      const r = await fn({
        get: async (p) => (docs.has(p) ? { exists: true, data: { ...docs.get(p) } } : { exists: false }),
        update: (p, f) => { writes.push(['u', p, f]); },
        create: (p, d) => { writes.push(['c', p, d]); },
      });
      for (const [k, p, d] of writes) {
        if (k === 'c') { if (docs.has(p)) throw new Error('ALREADY_EXISTS'); docs.set(p, d); }
        else { if (!docs.has(p)) throw new Error('NOT_FOUND'); docs.set(p, { ...docs.get(p), ...d }); }
      }
      return r;
    },
    mintCustomToken: async (uid, claims) => `token:${uid}:${JSON.stringify(claims)}`,
    log: (event, fields) => logs.push({ event, fields }),
  };
  return { deps, docs, logs };
}

async function issue(world, request = REQUEST) {
  try {
    const res = await handleSsoIssueCode(world.deps, AUTH, request);
    return { ok: true, res };
  } catch (e) {
    return { ok: false, code: e.code, publicCode: e.publicCode, internal: e.internalReason };
  }
}

const CONTRACT = (appConfiguration) => ({
  planId: 'plan-1', contractEnforced: true,
  ...(appConfiguration !== undefined ? { appConfiguration } : {}),
});
const planWith = (apps, capabilities = ['jsa']) => ({
  contractVersion: 1, planId: 'plan-1', displayName: 'P', capabilities, status: 'active',
  ...(apps !== undefined ? { apps } : {}),
});
const JSA_INCLUDED = { [JSA_AUDIENCE]: { included: true } };

const audienceLive = isSsoAudience(JSA_AUDIENCE);
console.log(`mirror audience support: ${audienceLive ? '0.5.0+ (activation matrix)' : '0.4.1 (fail-closed matrix)'}`);

if (!audienceLive) {
  // ── 0.4.1: the held wiring must be perfectly inert ─────────────────────
  const w = makeWorld({
    contractState: 'active', contract: CONTRACT(), plan: planWith(JSA_INCLUDED),
    authority: OPEN_AUTHORITY,
  });
  const r = await issue(w);
  check('jsa issuance fails closed at the audience allowlist',
    !r.ok && r.publicCode === 'unsupported_audience');
  check('  nothing is minted', w.docs.size === 0);
  check('  no jsa refusal/success event exists (the branch is unreachable)',
    !w.logs.some((l) => /jsa/i.test(JSON.stringify(l))));

  const wx = makeWorld({});
  let ex;
  try { ex = { ok: true, res: await handleSsoExchange(wx.deps, {
    protocolVersion: SSO_PROTOCOL_VERSION, audience: JSA_AUDIENCE,
    code: 'c'.repeat(43), codeVerifier: VERIFIER,
  }) }; } catch (e) { ex = { ok: false, publicCode: e.publicCode }; }
  check('jsa exchange fails closed at the audience allowlist',
    !ex.ok && ex.publicCode === 'unsupported_audience');
  check('  fail-closed exchange does not emit legalName',
    !ex.ok && !('legalName' in (ex.res || {})));
  check('  fail-closed logs do not carry legalName',
    !wx.logs.some((l) => Object.prototype.hasOwnProperty.call(l.fields || {}, 'legalName')));
} else {
  // ── 0.5.0+: full activation matrix ─────────────────────────────────────
  {
    const w = makeWorld({
      contractState: 'active', contract: CONTRACT(), plan: planWith(JSA_INCLUDED),
      authority: OPEN_AUTHORITY,
    });
    const r = await issue(w);
    check('included jsa + open authoritative shift issues', r.ok && !!r.res.code);
    const stored = [...w.docs.values()][0];
    check('  the stored code carries the server-authored open binding',
      stored?.jsaBinding?.shiftState === 'open'
      && stored.jsaBinding.periodId === '2026-08-12_073000'
      && stored.jsaBinding.originLocalDate === '2026-08-12');

    // Redeem it: the exchange returns EXACTLY the stored binding.
    const ex = await handleSsoExchange(w.deps, {
      protocolVersion: SSO_PROTOCOL_VERSION, audience: JSA_AUDIENCE,
      code: r.res.code, codeVerifier: VERIFIER,
    });
    check('  exchange returns the stored binding byte-for-byte',
      JSON.stringify(ex.jsaBinding) === JSON.stringify(stored.jsaBinding));
    check('  exchange returns the authoritative display name', ex.displayName === 'Mikezfold');
    check('  exchange returns the canonical legalName for jsa only',
      ex.legalName === 'Michael S Burger');
    check('  legalName is not copied into the minted claims',
      !/"legalName"/.test(ex.customToken));
    check('  the stored code record does not carry legalName',
      !('legalName' in stored));
    check('  the session claim names jsa', /"app":"jsa"/.test(ex.customToken));
  }
  {
    // Owner-operator: included, no gate anywhere, no open shift.
    const w = makeWorld({
      contractState: 'active', contract: CONTRACT(), plan: planWith(JSA_INCLUDED),
      authority: EMPTY_AUTHORITY,
    });
    const r = await issue(w);
    check('owner-operator off-shift issues with a none binding', r.ok);
    const stored = [...w.docs.values()][0];
    check('  none binding carries no period fields',
      stored?.jsaBinding?.shiftState === 'none'
      && stored.jsaBinding.periodId === undefined
      && stored.jsaBinding.requiresActiveShift === false);
  }
  {
    // Company shift gate: config requires a shift, none open → refused.
    const cfg = { [JSA_AUDIENCE]: { requiresActiveShift: true } };
    const w = makeWorld({
      contractState: 'active', contract: CONTRACT(cfg), plan: planWith(JSA_INCLUDED),
      authority: EMPTY_AUTHORITY,
    });
    const r = await issue(w);
    check('company shift gate refuses off-shift jsa issuance',
      !r.ok && r.publicCode === 'not_authorized' && w.docs.size === 0);
  }
  {
    // The vc5 defect shape: stale/inconsistent authority — refused, never bound.
    const w = makeWorld({
      contractState: 'active', contract: CONTRACT(), plan: planWith(JSA_INCLUDED),
      authority: STALE_AUTHORITY,
    });
    const r = await issue(w);
    check('a stale/inconsistent authority is REFUSED, never represented',
      !r.ok && r.publicCode === 'not_authorized' && w.docs.size === 0);
  }
  {
    // Absent authority — refused even though no gate required a shift.
    const w = makeWorld({
      contractState: 'active', contract: CONTRACT(), plan: planWith(JSA_INCLUDED),
      authority: null,
    });
    const r = await issue(w);
    check('an absent authority is refused (facts require evidence)',
      !r.ok && w.docs.size === 0);
  }
  {
    // Entitlement still rules: excluded jsa never reaches the binding.
    const w = makeWorld({
      contractState: 'active', contract: CONTRACT(),
      plan: planWith({ [JSA_AUDIENCE]: { included: false } }),
      authority: OPEN_AUTHORITY,
    });
    const r = await issue(w);
    check('a plan-excluded jsa app is refused before any binding is authored',
      !r.ok && r.internal === 'app_not_entitled' && w.docs.size === 0);
  }
  {
    // A client-proposed shiftBinding on the jsa audience is refused.
    const w = makeWorld({
      contractState: 'active', contract: CONTRACT(), plan: planWith(JSA_INCLUDED),
      authority: OPEN_AUTHORITY,
    });
    const r = await issue(w, {
      ...REQUEST, shiftBinding: { shiftId: '2026-08-12_073000', phase: 'pre_trip' },
    });
    check('a client-proposed shift binding is refused outright',
      !r.ok && r.publicCode === 'malformed_request' && w.docs.size === 0);
  }
}

// ── pure seams (run in both modes) ────────────────────────────────────────
check('decideJsaBinding refuses every unverifiable authority state',
  ['authority_absent', 'authority_uninitialized', 'authority_inconsistent', 'driver_mismatch']
    .every((reason) => decideJsaBinding({
      shift: { state: 'unverifiable', reason },
      requiresActiveShift: false, jsaEnabled: true,
    }).ok === false));
check('a June period cannot ride under an August origin day in storage',
  readStoredJsaBinding({
    shiftState: 'open', periodId: '2026-06-14_080000', originLocalDate: '2026-08-12',
    requiresActiveShift: true, jsaEnabled: true,
  }) === null);

console.log(`\nsso jsa spine: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
