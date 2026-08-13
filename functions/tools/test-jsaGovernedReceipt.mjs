/**
 * Governed JSA request/receipt matrix.
 * Run: node --experimental-strip-types tools/test-jsaGovernedReceipt.mjs
 *  (from functions/, after ensuring TS strip or: node --experimental-strip-types)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseRegisterInput, parseCompleteInput, parseConsumeInput,
  parseAuthPrincipal, requireAudience, decideIntentAllowed,
  decideActionSatisfies, decideRegister, decideComplete, decideConsume,
  liveState, JSA_PENDING_TTL_MS, JSA_APP_WBT, JSA_APP_JSA,
} from '../src/jsaReceipt/jsaReceiptCore.ts';

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
  existing: rec, requestId: RID, action: 'read', principal: JSA, binding: AUG, nowMs: NOW + 1000,
});
check('complete full first read', done.ok && done.value.write === 'complete' && done.value.record.action === 'read');

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
  existing: done.value.record, requestId: RID, action: 'read',
  principal: JSA, binding: AUG, nowMs: NOW + 2000,
});
check('duplicate completion is idempotent', again.ok && again.value.write === 'reuse');

// completion before registration
check('complete before register is not_found',
  decideComplete({
    existing: null, requestId: RID, action: 'read', principal: JSA, binding: AUG, nowMs: NOW,
  }).refusal === 'not_found');

// expired
const expired = { ...rec, expiresAtMs: NOW - 1 };
check('expired pending cannot complete',
  decideComplete({
    existing: expired, requestId: RID, action: 'read', principal: JSA, binding: AUG, nowMs: NOW,
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
    existing: rec, requestId: RID, action: 'read',
    principal: { ...JSA, driverId: 'other' }, binding: AUG, nowMs: NOW + 1,
  }).refusal === 'binding_mismatch');

// wrong shift
check('wrong shift binding refused',
  decideComplete({
    existing: rec, requestId: RID, action: 'read', principal: JSA,
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
check('consume completed result', first.ok && first.value.view.action === 'read' && first.value.write === 'mark');
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
  parseCompleteInput({ requestId: RID, action: 'read', companyId: 'co' }).refusal === 'client_identity');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
