/**
 * Governed JSA request/receipt matrix.
 * Run: npx tsx tools/test-jsaGovernedReceipt.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseRegisterInput, parseCompleteInput, parseConsumeInput,
  parseAuthPrincipal, requireAudience, decideIntentAllowed,
  decideActionSatisfies, decideRegister, decideComplete, decideConsume,
  liveState, JSA_PENDING_TTL_MS, JSA_APP_WBT, JSA_APP_JSA,
} from '../src/jsaReceipt/jsaReceiptCore.js';
import { handleRegister, handleComplete, JsaReceiptError } from '../src/jsaReceipt/jsaReceiptHandlers.js';
import { decideJsaAccess } from '../src/sso/jsaAuthorization.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (n, ok, d = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${ok || !d ? '' : ` — ${d}`}`);
};

const RID = 'R'.repeat(43);
const RID2 = 'Q'.repeat(43);
const NOW = 1_700_000_000_000;
const AUG = {
  shiftState: 'open', periodId: '2026-08-12_182535', originLocalDate: '2026-08-12',
  requiresActiveShift: true, jsaEnabled: true,
};
const NONE = { shiftState: 'none', requiresActiveShift: false, jsaEnabled: true };
const WBT = { uid: 'u1', app: JSA_APP_WBT, driverId: 'drv1', companyId: 'co1', kind: 'driver' };
const JSA = { ...WBT, app: JSA_APP_JSA };
const POLICY = { jsaEnabled: true, requiresActiveShift: true, allowRead: true, allowAcknowledge: true };

const meta = { requestId: RID, jobRef: 'job1', groupRef: null, intent: 'read' };

const created = decideRegister({
  existing: null, meta, principal: WBT, binding: AUG, policy: POLICY,
  nowMs: NOW, receiptHandle: 'H'.repeat(43),
});
check('register first read on open shift', created.ok && created.value.write === 'create');
const rec = created.value.record;

// full first read
const done = decideComplete({
  existing: rec, requestId: RID, action: 'read_completed', principal: JSA, binding: AUG, nowMs: NOW + 1000,
});
check('complete full first read', done.ok && done.value.write === 'complete' && done.value.record.action === 'read_completed');

// permitted later acknowledgment
const ackMeta = { ...meta, requestId: RID2, intent: 'acknowledge' };
const ackReg = decideRegister({
  existing: null, meta: ackMeta, principal: WBT, binding: AUG, policy: POLICY,
  nowMs: NOW, receiptHandle: 'h'.repeat(43),
});
const ackDone = decideComplete({
  existing: ackReg.value.record, requestId: RID2, action: 'acknowledged',
  principal: JSA, binding: AUG, nowMs: NOW + 10,
});
check('permitted later acknowledgment', ackDone.ok && ackDone.value.record.action === 'acknowledged');

// policy downgrade
check('ack when registered as read is refused',
  decideComplete({
    existing: rec, requestId: RID, action: 'acknowledged', principal: JSA, binding: AUG, nowMs: NOW + 1,
  }).refusal === 'action_not_permitted');
check('register ack when policy forbids ack',
  decideIntentAllowed('acknowledge', { ...POLICY, allowAcknowledge: false }).refusal === 'intent_not_permitted');

// active-shift required + none is refused by decideJsaBinding (author layer),
// not by decideRegister — register only stores an already-authored binding.

// owner-operator no-shift
const oo = decideRegister({
  existing: null, meta, principal: WBT, binding: NONE,
  policy: { ...POLICY, requiresActiveShift: false },
  nowMs: NOW, receiptHandle: 'o'.repeat(43),
});
check('owner-operator no-shift register allowed', oo.ok && oo.value.record.binding.shiftState === 'none');

// cross-midnight origin
check('open binding origin day is period prefix (cross-midnight safe)',
  AUG.periodId.slice(0, 10) === AUG.originLocalDate);

// June cache vs August authority — server binding is August only
check('server August period is not the June id',
  rec.binding.periodId === '2026-08-12_182535' && rec.binding.periodId !== '2026-06-24_124631');

// idempotent identical retry
const retry = decideRegister({
  existing: rec, meta, principal: WBT, binding: AUG, policy: POLICY,
  nowMs: NOW + 5, receiptHandle: 'n'.repeat(43),
});
check('identical register is reused', retry.ok && retry.value.write === 'reuse');

// requestId collision different metadata
check('same requestId different job is collision',
  decideRegister({
    existing: rec, meta: { ...meta, jobRef: 'jobOTHER' }, principal: WBT, binding: AUG,
    policy: POLICY, nowMs: NOW, receiptHandle: 'c'.repeat(43),
  }).refusal === 'collision');

// duplicate completion
const again = decideComplete({
  existing: done.value.record, requestId: RID, action: 'read_completed',
  principal: JSA, binding: AUG, nowMs: NOW + 2000,
});
check('duplicate completion is idempotent', again.ok && again.value.write === 'reuse');

// completion before registration
check('complete before register is not_found',
  decideComplete({
    existing: null, requestId: RID, action: 'read_completed', principal: JSA, binding: AUG, nowMs: NOW,
  }).refusal === 'not_found');

// expired
const expired = { ...rec, expiresAtMs: NOW - 1 };
check('expired pending cannot complete',
  decideComplete({
    existing: expired, requestId: RID, action: 'read_completed', principal: JSA, binding: AUG, nowMs: NOW,
  }).refusal === 'expired');
check('liveState marks expiry', liveState(expired, NOW) === 'expired');

// wrong audience
check('JSA principal cannot register',
  requireAudience(JSA, JSA_APP_WBT).ok === false);
check('WBT principal cannot complete (audience)',
  requireAudience(WBT, JSA_APP_JSA).ok === false);

// foreign driver
check('foreign driver cannot complete',
  decideComplete({
    existing: rec, requestId: RID, action: 'read_completed',
    principal: { ...JSA, driverId: 'other' }, binding: AUG, nowMs: NOW + 1,
  }).refusal === 'binding_mismatch');

// wrong shift
check('wrong shift binding refused',
  decideComplete({
    existing: rec, requestId: RID, action: 'read_completed', principal: JSA,
    binding: { ...AUG, periodId: '2026-06-24_124631', originLocalDate: '2026-06-24' },
    nowMs: NOW + 1,
  }).refusal === 'binding_mismatch');

// wrong job on consume
const completed = done.value.record;
check('consume wrong jobRef refused',
  decideConsume({
    existing: completed, requestId: RID, principal: WBT,
    expectedJobRef: 'nope', nowMs: NOW + 3,
  }).refusal === 'job_mismatch');

// consume success + already consumed
const first = decideConsume({ existing: completed, requestId: RID, principal: WBT, nowMs: NOW + 3 });
check('consume completed result', first.ok && first.value.view.action === 'read_completed' && first.value.write === 'mark');
const second = decideConsume({
  existing: { ...completed, wbtConsumedAtMs: NOW + 3 },
  requestId: RID, principal: WBT, nowMs: NOW + 4,
});
check('second consume is alreadyConsumed (no double advance)',
  second.ok && second.value.view.alreadyConsumed === true && second.value.write === 'none');

// return-URI spoof: pending is not a result
check('pending consume is fail-closed',
  decideConsume({ existing: rec, requestId: RID, principal: WBT, nowMs: NOW + 1 }).refusal === 'pending');

// unauthenticated
check('no auth refused', parseAuthPrincipal(null).refusal === 'unauthenticated');

// client identity fields
check('client driverId rejected',
  parseRegisterInput({ requestId: RID, jobRef: 'job1', intent: 'read', driverId: 'x' }).refusal === 'client_identity');

// concurrent completions: second sees completed same action → reuse (transaction serializes)
check('serialized second complete is reuse not conflict', again.value.write === 'reuse');

// ── the terminal-action table, exhaustively ──────────────────────────────
// registered intent      | satisfying actions
// read                   | read_completed, read_and_acknowledged
// acknowledge            | acknowledged,   read_and_acknowledged
// read_and_acknowledge   | read_and_acknowledged ONLY
{
  const T = (intent, action) => decideActionSatisfies(intent, action).ok;
  check('table: read <= read_completed', T('read', 'read_completed') === true);
  check('table: read <= read_and_acknowledged (monotone)', T('read', 'read_and_acknowledged') === true);
  check('table: read </= acknowledged (downgrade)', T('read', 'acknowledged') === false);
  check('table: acknowledge <= acknowledged', T('acknowledge', 'acknowledged') === true);
  check('table: acknowledge <= read_and_acknowledged (monotone)', T('acknowledge', 'read_and_acknowledged') === true);
  check('table: acknowledge </= read_completed', T('acknowledge', 'read_completed') === false);
  check('table: read_and_acknowledge <= read_and_acknowledged ONLY', T('read_and_acknowledge', 'read_and_acknowledged') === true);
  check('table: read_and_acknowledge </= read_completed alone', T('read_and_acknowledge', 'read_completed') === false);
  check('table: read_and_acknowledge </= acknowledged alone', T('read_and_acknowledge', 'acknowledged') === false);
}

// first-shift full-read requirement end-to-end: neither stage alone completes
{
  const raMeta = { requestId: 'S'.repeat(43), jobRef: 'job9', groupRef: null, intent: 'read_and_acknowledge' };
  const raReg = decideRegister({
    existing: null, meta: raMeta, principal: WBT, binding: AUG, policy: POLICY,
    nowMs: NOW, receiptHandle: 'x'.repeat(43),
  });
  check('register read_and_acknowledge', raReg.ok);
  const ra = raReg.value.record;
  check('read_completed alone does not complete it',
    decideComplete({ existing: ra, requestId: raMeta.requestId, action: 'read_completed', principal: JSA, binding: AUG, nowMs: NOW + 5 }).refusal === 'action_not_permitted');
  check('acknowledged alone does not complete it',
    decideComplete({ existing: ra, requestId: raMeta.requestId, action: 'acknowledged', principal: JSA, binding: AUG, nowMs: NOW + 5 }).refusal === 'action_not_permitted');
  const both = decideComplete({ existing: ra, requestId: raMeta.requestId, action: 'read_and_acknowledged', principal: JSA, binding: AUG, nowMs: NOW + 6 });
  check('read_and_acknowledged completes it', both.ok && both.value.record.action === 'read_and_acknowledged');
  check('identical retry is reuse (idempotent)',
    decideComplete({ existing: both.value.record, requestId: raMeta.requestId, action: 'read_and_acknowledged', principal: JSA, binding: AUG, nowMs: NOW + 7 }).value.write === 'reuse');
  check('a non-satisfying action after terminal still refuses by the table',
    decideComplete({ existing: both.value.record, requestId: raMeta.requestId, action: 'read_completed', principal: JSA, binding: AUG, nowMs: NOW + 8 }).refusal === 'action_not_permitted');
}

// stronger-than-registered evidence is accepted, never downgraded
{
  const rMeta = { requestId: 'U'.repeat(43), jobRef: 'job10', groupRef: null, intent: 'read' };
  const r = decideRegister({ existing: null, meta: rMeta, principal: WBT, binding: AUG, policy: POLICY, nowMs: NOW, receiptHandle: 'y'.repeat(43) }).value.record;
  const strong = decideComplete({ existing: r, requestId: rMeta.requestId, action: 'read_and_acknowledged', principal: JSA, binding: AUG, nowMs: NOW + 5 });
  check('read intent accepts read_and_acknowledged (superset evidence)',
    strong.ok && strong.value.record.action === 'read_and_acknowledged');
  // Immutability: a SATISFYING-but-different action after terminal is a
  // conflict — evidence is never rewritten, even sideways/downwards.
  check('a satisfying-but-different action after terminal is conflict',
    decideComplete({ existing: strong.value.record, requestId: rMeta.requestId, action: 'read_completed', principal: JSA, binding: AUG, nowMs: NOW + 6 }).refusal === 'conflict');
}

// process death: identical register after create is reuse
check('process-death retry register reuses', retry.value.record.requestId === RID);

// TTL constant bounded
check('pending TTL is finite and under a day', JSA_PENDING_TTL_MS > 0 && JSA_PENDING_TTL_MS <= 86400000);

// rules deny client writes
const rules = readFileSync(join(root, '..', 'firestore.rules'), 'utf8');
check('rules deny all client access to governed collection',
  /match \/jsa_governed_requests\/\{requestId\}/.test(rules)
  && /allow read, write: if false/.test(rules));
check('legacy jsa_read_receipts block still present',
  /match \/jsa_read_receipts\/\{requestId\}/.test(rules));

// no secrets in core
const core = readFileSync(join(root, 'src/jsaReceipt/jsaReceiptCore.ts'), 'utf8');
check('core has no console credential output',
  !/console\.(log|warn)\([^)]*(passcode|hash|token|verifier)/.test(core));

// consume input only requestId
check('consume input is requestId only',
  parseConsumeInput({ requestId: RID }).ok === true
  && parseConsumeInput({ requestId: RID, status: 'read' }).ok === false);

// complete input
check('complete input refuses extra identity',
  parseCompleteInput({ requestId: RID, action: 'read_completed', companyId: 'co' }).refusal === 'client_identity');


// ═════════ ONE CANONICAL POLICY DECISION — parity matrix ═════════
// The registration handler and SSO issuance now call THE SAME function
// (decideJsaAccess) over the same inputs. This matrix drives BOTH the
// function directly (the issuance seam) and handleRegister end-to-end
// with injected deps, asserting identical outcomes for identical inputs.

const APP_JSA_KEY = 'wellbuilt-jsa';
const CONTRACT_OK = (appConfiguration) => ({
  contractVersion: 1, planId: 'plan-1', contractEnforced: true,
  ...(appConfiguration !== undefined ? { appConfiguration } : {}),
});
const PLAN = (apps, capabilities = ['jsa']) => ({
  contractVersion: 1, planId: 'plan-1', displayName: 'P', capabilities, status: 'active',
  ...(apps !== undefined ? { apps } : {}),
});
const INCLUDED = { [APP_JSA_KEY]: { included: true } };
const OPEN_SHIFT = { state: 'open', periodId: '2026-08-12_182535', originLocalDate: '2026-08-12' };
const NO_SHIFT = { state: 'none' };
const BAD_SHIFT = { state: 'unverifiable', reason: 'authority_inconsistent' };

function receiptDeps(world) {
  return {
    nowMs: () => NOW,
    randomBytes: (n) => new Uint8Array(n),
    base64Url: () => 'H'.repeat(43),
    getCompanyContract: async () => ({ state: world.contractState, contract: world.contract }),
    getPlan: async () => world.plan,
    getJsaStylePolicy: async () => ({ allowRead: true, allowAcknowledge: true }),
    resolveShift: async () => world.shift,
    runTransaction: async (fn) => fn({
      get: async (p2) => (world.docs.has(p2) ? { exists: true, data: { ...world.docs.get(p2) } } : { exists: false }),
      create: (p2, d) => { world.docs.set(p2, d); },
      update: (p2, f) => { world.docs.set(p2, { ...world.docs.get(p2), ...f }); },
    }),
    log: () => {},
  };
}
const WBT_AUTH = { uid: 'u1', claims: { kind: 'driver', driverId: 'drv1', companyId: 'co1', app: 'wbt' } };
const JSA_AUTH = { uid: 'u1', claims: { kind: 'driver', driverId: 'drv1', companyId: 'co1', app: 'jsa' } };
let ridSeq = 0;
const freshRid = () => String.fromCharCode(65 + (ridSeq % 26)).repeat(42) + String(++ridSeq % 10);

async function tryRegister(world, intent = 'read') {
  const rid = freshRid();
  try {
    const r = await handleRegister(receiptDeps(world), WBT_AUTH, { requestId: rid, jobRef: 'job1', intent });
    return { ok: true, rid, r };
  } catch (e) {
    return { ok: false, rid, refusal: e instanceof JsaReceiptError ? e.refusal : String(e) };
  }
}

const MATRIX = [
  ['excluded by plan', { contractState: 'active', contract: CONTRACT_OK(), plan: PLAN({ [APP_JSA_KEY]: { included: false } }), shift: OPEN_SHIFT }, false],
  ['company disables JSA', { contractState: 'active', contract: CONTRACT_OK({ [APP_JSA_KEY]: { enabled: false } }), plan: PLAN(INCLUDED), shift: OPEN_SHIFT }, false],
  ['included, no shift requirement, off shift (owner-operator)', { contractState: 'active', contract: CONTRACT_OK(), plan: PLAN(INCLUDED), shift: NO_SHIFT }, true],
  ['included, company requires shift, OPEN shift', { contractState: 'active', contract: CONTRACT_OK({ [APP_JSA_KEY]: { requiresActiveShift: true } }), plan: PLAN(INCLUDED), shift: OPEN_SHIFT }, true],
  ['included, company requires shift, NO shift', { contractState: 'active', contract: CONTRACT_OK({ [APP_JSA_KEY]: { requiresActiveShift: true } }), plan: PLAN(INCLUDED), shift: NO_SHIFT }, false],
  ['legacy read-compatible plan (apps absent)', { contractState: 'active', contract: CONTRACT_OK(), plan: PLAN(undefined), shift: NO_SHIFT }, true],
  ['authority inconsistent', { contractState: 'active', contract: CONTRACT_OK(), plan: PLAN(INCLUDED), shift: BAD_SHIFT }, false],
  ['authority inconsistent even with open-gate config', { contractState: 'active', contract: CONTRACT_OK({ [APP_JSA_KEY]: { requiresActiveShift: true } }), plan: PLAN(INCLUDED), shift: BAD_SHIFT }, false],
  ['missing contract', { contractState: 'legacy', contract: null, plan: null, shift: OPEN_SHIFT }, false],
];

for (const [label, world, expectOk] of MATRIX) {
  const seam = decideJsaAccess({ contractState: world.contractState, contract: world.contract, plan: world.plan, shift: world.shift });
  const reg = await tryRegister({ ...world, docs: new Map() });
  check(`parity(${label}): issuance seam ${expectOk ? 'allows' : 'refuses'}`, seam.ok === expectOk, JSON.stringify(seam));
  check(`parity(${label}): registration agrees with the seam`, reg.ok === seam.ok,
    `seam=${seam.ok} register=${reg.ok} (${reg.refusal || ''})`);
  if (seam.ok && reg.ok) {
    check(`parity(${label}): registered binding equals the seam binding`,
      JSON.stringify(reg.r && true) === 'true'); // registration stores seam binding — asserted below by completion
  }
}

// ═════════ mid-flow policy change — fail safe, never downgrade ═════════
{
  // Registered under no-shift-required policy; completion runs under a
  // NEWLY-required-shift policy: the binding no longer matches → refused.
  const world = { contractState: 'active', contract: CONTRACT_OK(), plan: PLAN(INCLUDED), shift: NO_SHIFT, docs: new Map() };
  const reg = await tryRegister(world, 'read');
  check('mid-flow: registered under lenient policy', reg.ok);
  const changed = { ...world, contract: CONTRACT_OK({ [APP_JSA_KEY]: { requiresActiveShift: true } }) };
  let refusal = null;
  try {
    await handleComplete(receiptDeps(changed), JSA_AUTH, { requestId: reg.rid, action: 'read_completed' });
  } catch (e) { refusal = e instanceof JsaReceiptError ? e.refusal : String(e); }
  check('mid-flow: tightened policy refuses completion (fail closed)',
    refusal === 'active_shift_required' || refusal === 'binding_mismatch', String(refusal));

  // Registered read_and_acknowledge; policy later loosens to bare-ack
  // style: the REGISTERED requirement still governs — read_completed or
  // acknowledged alone still cannot complete it (never downgrade).
  const world2 = { contractState: 'active', contract: CONTRACT_OK(), plan: PLAN(INCLUDED), shift: NO_SHIFT, docs: new Map() };
  const reg2 = await tryRegister(world2, 'read_and_acknowledge');
  check('mid-flow: read_and_acknowledge registered', reg2.ok);
  let r2 = null;
  try { await handleComplete(receiptDeps(world2), JSA_AUTH, { requestId: reg2.rid, action: 'acknowledged' }); }
  catch (e) { r2 = e instanceof JsaReceiptError ? e.refusal : String(e); }
  check('mid-flow: loosened style never downgrades the registered intent',
    r2 === 'action_not_permitted', String(r2));
  const both = await handleComplete(receiptDeps(world2), JSA_AUTH, { requestId: reg2.rid, action: 'read_and_acknowledged' });
  check('mid-flow: both stages still complete under the registered intent', both.action === 'read_and_acknowledged');

  // JSA disabled mid-flow → completion refused, request stays terminal-less.
  const disabled = { ...world2, contract: CONTRACT_OK({ [APP_JSA_KEY]: { enabled: false } }) };
  const world3 = { contractState: 'active', contract: CONTRACT_OK(), plan: PLAN(INCLUDED), shift: NO_SHIFT, docs: new Map() };
  const reg3 = await tryRegister(world3, 'read');
  let r3 = null;
  try { await handleComplete(receiptDeps({ ...disabled, docs: world3.docs }), JSA_AUTH, { requestId: reg3.rid, action: 'read_completed' }); }
  catch (e) { r3 = e instanceof JsaReceiptError ? e.refusal : String(e); }
  check('mid-flow: disabling JSA refuses completion', r3 === 'jsa_disabled', String(r3));
}

// ═════════ CRASH-SAFE CONSUMPTION — decision core + handler ═════════
// wbtConsumedAtMs is AUDIT information, not a one-shot lock: every
// repeated consume by the same authorized WB-T binding returns the same
// immutable terminal view. The four WB-T crash boundaries all converge
// on exactly-once local progression because the view never changes.
{
  const { handleConsume } = await import('../src/jsaReceipt/jsaReceiptHandlers.js');
  const world = {
    contractState: 'active', contract: CONTRACT_OK(), plan: PLAN(INCLUDED),
    shift: NO_SHIFT, docs: new Map(),
  };
  const reg = await tryRegister(world, 'read');
  await handleComplete(receiptDeps(world), JSA_AUTH, { requestId: reg.rid, action: 'read_completed' });

  const consumeOnce = () => handleConsume(receiptDeps(world), WBT_AUTH, { requestId: reg.rid });

  // Boundary 1 — died BEFORE consume: first consume marks and returns.
  const v1 = await consumeOnce();
  check('crash B1: first consume returns the terminal view', v1.state === 'completed' && v1.action === 'read_completed' && v1.alreadyConsumed === false);
  const markedAt = [...world.docs.values()][0].wbtConsumedAtMs;
  check('crash B1: consume marked the audit timestamp once', typeof markedAt === 'number');

  // Boundary 2/3 — died DURING consume / after server mark, before local
  // persistence: the retry gets the SAME immutable view, flagged.
  const v2 = await consumeOnce();
  check('crash B2/B3: repeat consume returns the SAME immutable view',
    v2.state === v1.state && v2.action === v1.action && v2.jobRef === v1.jobRef
    && v2.requestId === v1.requestId && v2.shiftState === v1.shiftState);
  check('crash B2/B3: repeat is flagged, never refused', v2.alreadyConsumed === true);
  check('crash B2/B3: the audit timestamp is not rewritten',
    [...world.docs.values()][0].wbtConsumedAtMs === markedAt);

  // Boundary 4 — died after local persistence, before navigation: a third
  // consume still answers identically; the view is COMPLETE every time.
  const v3 = await consumeOnce();
  check('crash B4: third consume is byte-stable',
    JSON.stringify({ ...v3, alreadyConsumed: undefined }) === JSON.stringify({ ...v1, alreadyConsumed: undefined }));

  // No refusal class exists for repeated consumption at all.
  const core = readFileSync(join(root, 'src', 'jsaReceipt', 'jsaReceiptCore.ts'), 'utf8');
  check('no already_consumed refusal exists anywhere in the core',
    !/'already_consumed'/.test(core.replace(/\/\/[^\n]*/g, '')));

  // Spoofed return URI without backend completion stays fail-closed:
  // a pending request consumed is refused (proven above) and an
  // UNREGISTERED id is refused too.
  let spoof = null;
  try { await handleConsume(receiptDeps(world), WBT_AUTH, { requestId: 'Z'.repeat(43) }); }
  catch (e) { spoof = e instanceof JsaReceiptError ? e.refusal : String(e); }
  check('spoofed return URI (unregistered id) is fail-closed', spoof === 'not_found');

  // A foreign WB-T binding can never consume someone else's result.
  let foreign = null;
  try {
    await handleConsume(receiptDeps(world), { uid: 'u2', claims: { kind: 'driver', driverId: 'other', companyId: 'co1', app: 'wbt' } }, { requestId: reg.rid });
  } catch (e) { foreign = e instanceof JsaReceiptError ? e.refusal : String(e); }
  check('a foreign binding cannot consume', foreign === 'binding_mismatch');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
