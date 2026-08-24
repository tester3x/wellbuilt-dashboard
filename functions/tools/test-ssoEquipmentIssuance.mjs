/**
 * Equipment SSO issuance — canonical date-free period authority.
 *
 * Drives the REAL handleSsoIssueCode / handleSsoExchange against in-memory
 * SsoDeps. Origin-day driver_shifts documents are not on the issuance
 * path. A throwing or hung getShiftDay cannot delay or deny a code.
 * Code issuance must not write a receipt, DVIR, or shift document.
 *
 * Run: npm run build && node tools/test-ssoEquipmentIssuance.mjs
 */
import { createHash } from 'node:crypto';
import { handleSsoIssueCode } from '../lib/sso/ssoIssueHandler.js';
import { handleSsoExchange } from '../lib/sso/ssoExchangeHandler.js';
import { SSO_CODE_COLLECTION } from '../lib/sso/ssoDeps.js';
import {
  SSO_AUDIENCE_WBT,
  SSO_AUDIENCE_EQUIPMENT,
  SSO_PROTOCOL_VERSION,
  SSO_CHALLENGE_METHOD,
  SSO_CODE_TTL_MS_PROVISIONAL,
  WELLBUILT_APP_EQUIPMENT,
} from '@tester3x/wellbuilt-contracts';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const DRIVER = 'driver-mikezfold';
const COMPANY = 'liquid-gold';
const PERIOD = '2026-08-21_112421';
const DAY = '2026-08-21';
const OTHER = '2026-08-22_070000';
const NOW = 1_775_000_000_000;
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER, 'utf8').digest('base64url');
const AUTH = {
  uid: 'uid-mikezfold',
  claims: { kind: 'driver', driverId: DRIVER, companyId: COMPANY },
};

const CONTRACT = {
  contractVersion: 1,
  configurationVersion: 1,
  planId: 'plan-1',
  entitlementOverrides: [],
  workPeriodConfiguration: { mode: 'explicit_shift' },
  contractEnforced: true,
};
const PLAN = {
  contractVersion: 1,
  planId: 'plan-1',
  displayName: 'P',
  capabilities: ['dvir', 'explicitShiftLifecycle'],
  status: 'active',
  apps: { [WELLBUILT_APP_EQUIPMENT]: { included: true } },
};
const WBT_PLAN = {
  contractVersion: 1,
  planId: 'plan-1',
  displayName: 'P',
  capabilities: [],
  status: 'active',
};

const OPEN_AUTH = {
  driverId: DRIVER, companyId: COMPANY, initialized: true,
  openPeriodId: PERIOD, originLocalDate: DAY, version: 4,
};
const CLOSED_AUTH = {
  driverId: DRIVER, companyId: COMPANY, initialized: true,
  openPeriodId: null, originLocalDate: null, lastClosedPeriodId: PERIOD, version: 5,
};
const SUPERSEDED_AUTH = {
  driverId: DRIVER, companyId: COMPANY, initialized: true,
  openPeriodId: OTHER, originLocalDate: '2026-08-22', lastClosedPeriodId: PERIOD, version: 6,
};

function sha256Hex(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function makeWorld({
  authority = OPEN_AUTH,
  contract = CONTRACT,
  contractState = 'active',
  plan = PLAN,
  shiftDayMode = 'throw',
} = {}) {
  const docs = new Map();
  const logs = [];
  let now = NOW;
  let counter = 0;
  let getShiftDayCalls = 0;
  const deps = {
    nowMs: () => now,
    randomBytes: (n) => {
      counter += 1;
      const o = new Uint8Array(n);
      for (let i = 0; i < n; i++) o[i] = (i * 7 + counter * 31) & 0xff;
      return o;
    },
    sha256Hex,
    base64Url: (b) => Buffer.from(b).toString('base64url'),
    expiresAtTimestamp: (ms) => ({ __timestamp: true, ms }),
    getDriver: async (id) => (id === DRIVER
      ? { driverId: DRIVER, companyId: COMPANY, active: true, displayName: 'Mikezfold' }
      : null),
    getCompanyContract: async () => ({ state: contractState, contract }),
    getPlan: async () => plan,
    getShiftAuthority: async () => authority,
    getShiftDay: () => {
      getShiftDayCalls += 1;
      if (shiftDayMode === 'hang') return new Promise(() => { /* never settles */ });
      return Promise.reject(new Error('origin-day document must not be read'));
    },
    runTransaction: async (fn) => {
      const writes = [];
      const r = await fn({
        get: async (p) => (docs.has(p) ? { exists: true, data: { ...docs.get(p) } } : { exists: false }),
        update: (p, f) => writes.push(['update', p, f]),
        create: (p, d) => writes.push(['create', p, d]),
      });
      for (const [k, p, d] of writes) {
        if (k === 'create') {
          if (docs.has(p)) throw new Error('ALREADY_EXISTS');
          docs.set(p, d);
        } else {
          if (!docs.has(p)) throw new Error('NOT_FOUND');
          docs.set(p, { ...docs.get(p), ...d });
        }
      }
      return r;
    },
    mintCustomToken: async (uid, claims) => `custom.${uid}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`,
    log: (event, fields) => logs.push({ event, fields }),
  };
  return {
    deps, docs, logs,
    getShiftDayCalls: () => getShiftDayCalls,
    advance: (ms) => { now += ms; },
  };
}

const equipmentReq = (over = {}) => ({
  protocolVersion: SSO_PROTOCOL_VERSION,
  audience: SSO_AUDIENCE_EQUIPMENT,
  codeChallenge: CHALLENGE,
  codeChallengeMethod: SSO_CHALLENGE_METHOD,
  shiftBinding: { shiftId: PERIOD, phase: 'post_trip' },
  ...over,
});

const wbtReq = () => ({
  protocolVersion: SSO_PROTOCOL_VERSION,
  audience: SSO_AUDIENCE_WBT,
  codeChallenge: CHALLENGE,
  codeChallengeMethod: SSO_CHALLENGE_METHOD,
});

async function issue(world, request = equipmentReq(), auth = AUTH) {
  try {
    const res = await handleSsoIssueCode(world.deps, auth, request);
    return { ok: true, res };
  } catch (e) {
    return { ok: false, code: e.code, publicCode: e.publicCode, internal: e.internalReason };
  }
}

function onlySsoCodes(world) {
  for (const p of world.docs.keys()) {
    if (!String(p).startsWith(`${SSO_CODE_COLLECTION}/`)) return false;
  }
  return true;
}

function mintedNothing(world) {
  return world.docs.size === 0 && !world.logs.some((l) => l.event === 'sso.code.issued');
}

// ── Mikezfold: canonical open; origin-day stub cannot participate ────────
{
  const w = makeWorld({ authority: OPEN_AUTH, shiftDayMode: 'throw' });
  const r = await issue(w);
  check('canonical open → equipment code issued',
    r.ok && typeof r.res?.code === 'string' && r.res.code.length > 0);
  check('  stored binding is the exact canonical period + post_trip',
    [...w.docs.values()][0]?.shiftBinding?.shiftId === PERIOD
    && [...w.docs.values()][0]?.shiftBinding?.phase === 'post_trip');
  check('  throwing getShiftDay was never called', w.getShiftDayCalls() === 0);
  check('  issuance wrote only sso_authorization_codes (no shift/DVIR/receipt)',
    onlySsoCodes(w) && w.docs.size === 1);
  check('  no driver_shifts / dvir / receipt path was written',
    ![...w.docs.keys()].some((p) => /driver_shifts|dvir|receipt/i.test(p)));
}

{
  const w = makeWorld({ authority: OPEN_AUTH, shiftDayMode: 'hang' });
  const r = await Promise.race([
    issue(w),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, timeout: true }), 1500)),
  ]);
  check('hung getShiftDay cannot delay or deny authorization',
    r.ok === true && r.timeout !== true && typeof r.res?.code === 'string');
  check('  hung getShiftDay was never called', w.getShiftDayCalls() === 0);
}

{
  const w = makeWorld({ authority: OPEN_AUTH });
  w.advance(48 * 3600 * 1000);
  const r = await issue(w);
  check('shift age alone does not close an open canonical period',
    r.ok && typeof r.res?.code === 'string');
}

{
  const w = makeWorld({ authority: CLOSED_AUTH });
  const r = await issue(w);
  check('canonical closed denies',
    !r.ok && r.publicCode === 'not_authorized' && r.internal === 'shift_not_active');
  check('  closed canonical minted nothing', mintedNothing(w));
  check('  closed path did not call getShiftDay', w.getShiftDayCalls() === 0);
}

{
  const w = makeWorld({ authority: SUPERSEDED_AUTH });
  const r = await issue(w);
  check('canonical superseded/replaced denies',
    !r.ok && r.internal === 'shift_id_mismatch' && mintedNothing(w));
}

{
  // Local Suite "open" is not an input. Closed canonical still denies.
  const w = makeWorld({ authority: CLOSED_AUTH });
  const r = await issue(w);
  check('canonical closed (Suite local open is not consulted) denies',
    !r.ok && r.internal === 'shift_not_active' && mintedNothing(w));
}

{
  const w = makeWorld({ authority: OPEN_AUTH });
  const r = await issue(w, equipmentReq({ shiftBinding: { shiftId: OTHER, phase: 'post_trip' } }));
  check('periodId mismatch denies',
    !r.ok && r.internal === 'shift_id_mismatch' && mintedNothing(w));
}

{
  const w = makeWorld({
    authority: { ...OPEN_AUTH, driverId: 'other-driver' },
  });
  const r = await issue(w);
  check('driver mismatch denies',
    !r.ok && r.internal === 'driver_mismatch' && mintedNothing(w));
}

{
  const w = makeWorld({
    authority: { ...OPEN_AUTH, companyId: 'other-co' },
  });
  const r = await issue(w);
  check('company mismatch denies',
    !r.ok && r.internal === 'company_mismatch' && mintedNothing(w));
}

{
  const w = makeWorld({ authority: OPEN_AUTH });
  const r = await issue(w, equipmentReq({
    shiftBinding: { shiftId: 'not-a-period', phase: 'post_trip' },
  }));
  check('malformed period id denies',
    !r.ok && mintedNothing(w));
}

{
  const w = makeWorld({ authority: null });
  const r = await issue(w);
  check('missing canonical period denies',
    !r.ok && r.internal === 'period_missing' && mintedNothing(w));
}

{
  const w = makeWorld({ authority: OPEN_AUTH });
  const r = await issue(w, equipmentReq({ audience: 'wellbuilt-payroll' }));
  check('audience mismatch denies',
    !r.ok && (r.publicCode === 'unsupported_audience' || r.internal === 'unsupported_audience'
      || r.publicCode === 'malformed_request' || r.code === 'invalid-argument'));
  check('  audience mismatch minted nothing', mintedNothing(w));
}

{
  const w = makeWorld({ authority: OPEN_AUTH });
  const r = await issue(w, equipmentReq({ codeChallenge: 'short' }));
  check('malformed PKCE challenge denies',
    !r.ok && mintedNothing(w));
}

{
  const w = makeWorld({
    authority: OPEN_AUTH,
    plan: WBT_PLAN, contract: { ...CONTRACT, workPeriodConfiguration: undefined },
  });
  const r = await issue(w, wbtReq());
  check('WB-T issuance is unchanged (still issues without equipment shiftBinding)',
    r.ok && typeof r.res?.code === 'string');
}

// ── single-use, TTL, replay ──────────────────────────────────────────────
{
  const w = makeWorld({ authority: OPEN_AUTH });
  const r = await issue(w);
  check('equipment issue succeeded for redeem tests', r.ok);
  const code = r.res.code;
  const first = await handleSsoExchange(w.deps, {
    protocolVersion: SSO_PROTOCOL_VERSION,
    audience: SSO_AUDIENCE_EQUIPMENT,
    code,
    codeVerifier: VERIFIER,
  });
  check('authorization code is redeemable once',
    typeof first.customToken === 'string'
    && first.shiftBinding?.shiftId === PERIOD);
  let replay = null;
  try {
    await handleSsoExchange(w.deps, {
      protocolVersion: SSO_PROTOCOL_VERSION,
      audience: SSO_AUDIENCE_EQUIPMENT,
      code,
      codeVerifier: VERIFIER,
    });
  } catch (e) { replay = e; }
  check('replay of a consumed code is denied',
    replay?.publicCode === 'invalid_grant');
}

{
  const w = makeWorld({ authority: OPEN_AUTH });
  const r = await issue(w);
  w.advance(SSO_CODE_TTL_MS_PROVISIONAL + 1);
  let expired = null;
  try {
    await handleSsoExchange(w.deps, {
      protocolVersion: SSO_PROTOCOL_VERSION,
      audience: SSO_AUDIENCE_EQUIPMENT,
      code: r.res.code,
      codeVerifier: VERIFIER,
    });
  } catch (e) { expired = e; }
  check('expired equipment code is denied by server time',
    expired?.publicCode === 'invalid_grant');
  check('expired code was not consumed',
    [...w.docs.values()][0].consumed === false);
  check('TTL is the protocol provisional lifetime (short-lived)',
    SSO_CODE_TTL_MS_PROVISIONAL <= 5 * 60 * 1000);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
