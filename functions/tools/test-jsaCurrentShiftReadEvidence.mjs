/**
 * jsaResolveCurrentShiftReadEvidence — injected-deps matrix.
 * Run: npx tsx tools/test-jsaCurrentShiftReadEvidence.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleResolveCurrentShiftReadEvidence } from '../src/jsaReceipt/jsaCurrentShiftReadEvidence.ts';
import { JsaReceiptError } from '../src/jsaReceipt/jsaReceiptHandlers.ts';
import { terminalActionIncludesRead } from '@tester3x/wellbuilt-contracts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (n, ok, d = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${ok || !d ? '' : ` — ${d}`}`);
};

const PERIOD = '2026-08-12_182535';
const DRIVER = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';
const COMPANY = 'liquid-gold';
const AUTH = {
  uid: 'u1',
  claims: { kind: 'driver', driverId: DRIVER, companyId: COMPANY, app: 'wbt' },
};

function rec(over = {}) {
  return {
    companyId: COMPANY,
    driverId: DRIVER,
    state: 'completed',
    action: 'read_and_acknowledged',
    bindingPeriodId: PERIOD,
    ...over,
  };
}

function mem(opts = {}) {
  const writes = [];
  const logs = [];
  return {
    writes,
    logs,
    resolveShift: async (driverId, companyId) => {
      if (opts.resolveThrow) throw new Error('boom');
      if (opts.shift) return opts.shift;
      return { state: 'open', periodId: PERIOD, originLocalDate: '2026-08-12' };
    },
    listGovernedByPeriod: async (companyId, driverId, periodId) => {
      if (opts.queryThrow) throw new Error('query');
      writes.push({ op: 'list', companyId, driverId, periodId });
      return opts.records || [];
    },
    log: (event, extra) => { logs.push({ event, extra }); },
  };
}

async function run(deps, auth, data) {
  try {
    return { ok: true, value: await handleResolveCurrentShiftReadEvidence(deps, auth, data) };
  } catch (e) {
    return { ok: false, err: e };
  }
}

// 1 empty request
{
  const d = mem({ records: [rec()] });
  const r = await run(d, AUTH, { protocolVersion: 1 });
  check('1 empty request resolves current identity and shift server-side',
    r.ok && r.value.state === 'read_bootstrapped' && r.value.periodId === PERIOD
    && d.writes[0].companyId === COMPANY && d.writes[0].driverId === DRIVER
    && d.writes[0].periodId === PERIOD);
}

// 2-4 hostile fields refused — cannot affect authority
for (const [label, field, value] of [
  ['2 companyId', 'companyId', 'evil-co'],
  ['3 driverId', 'driverId', 'evil-drv'],
  ['4a shiftId', 'shiftId', '2026-08-11_000000'],
  ['4b periodId', 'periodId', '2026-08-11_000000'],
]) {
  const d = mem({ records: [rec()] });
  const r = await run(d, AUTH, { protocolVersion: 1, [field]: value });
  check(`${label} is rejected and never queried`,
    !r.ok && r.err instanceof JsaReceiptError && r.err.refusal === 'client_identity'
    && d.writes.length === 0);
}

// 5 no active shift
{
  const d = mem({ shift: { state: 'none' }, records: [rec()] });
  const r = await run(d, AUTH, { protocolVersion: 1 });
  check('5 no active shift returns no_active_shift and does not query',
    r.ok && r.value.state === 'no_active_shift' && !('periodId' in r.value)
    && d.writes.length === 0);
}

// 6-7 matching completed reads
{
  const d = mem({ records: [rec({ action: 'read_completed' })] });
  const r = await run(d, AUTH, { protocolVersion: 1 });
  check('6 matching completed read returns read_bootstrapped',
    r.ok && r.value.state === 'read_bootstrapped');
}
{
  const d = mem({ records: [rec({ action: 'read_and_acknowledged' })] });
  const r = await run(d, AUTH, { protocolVersion: 1 });
  check('7 matching completed read_and_acknowledged returns read_bootstrapped',
    r.ok && r.value.state === 'read_bootstrapped');
}

// 8-10 non-reads
{
  const d = mem({ records: [rec({ action: 'acknowledged' })] });
  check('8 acknowledge-only returns none',
    (await run(d, AUTH, { protocolVersion: 1 })).value?.state === 'none');
}
{
  const d = mem({ records: [rec({ state: 'pending', action: null })] });
  check('9 pending returns none',
    (await run(d, AUTH, { protocolVersion: 1 })).value?.state === 'none');
}
{
  const d = mem({ records: [rec({ state: 'failed', action: 'read_completed' })] });
  check('10 failed returns none',
    (await run(d, AUTH, { protocolVersion: 1 })).value?.state === 'none');
}

// 11-13 wrong subject (list already scoped; extra hostile rows still ignored)
{
  const d = mem({ records: [
    rec({ companyId: 'other-co' }),
    rec({ driverId: 'other-drv' }),
    rec({ bindingPeriodId: '2026-08-11_000000' }),
  ] });
  const r = await run(d, AUTH, { protocolVersion: 1 });
  check('11-13 wrong company/driver/period are ignored → none',
    r.ok && r.value.state === 'none' && r.value.periodId === PERIOD);
}

// 14 multiple records deterministic
{
  const d = mem({ records: [
    rec({ action: 'acknowledged' }),
    rec({ action: 'read_completed' }),
    rec({ action: 'read_and_acknowledged' }),
  ] });
  check('14 multiple records remain deterministic (bootstrapped, no pick)',
    (await run(d, AUTH, { protocolVersion: 1 })).value?.state === 'read_bootstrapped');
}

// 15 DNCL-shaped
{
  const d = mem({ records: [rec({
    action: 'read_and_acknowledged',
    state: 'completed',
    bindingPeriodId: '2026-08-12_182535',
  })] });
  const r = await run(d, AUTH, { protocolVersion: 1 });
  check('15 DNCL-shaped completed evidence resolves true for 2026-08-12_182535',
    r.ok && r.value.state === 'read_bootstrapped' && r.value.periodId === PERIOD);
}

// 16 response contains no leak fields
{
  const d = mem({ records: [rec()] });
  const r = await run(d, AUTH, { protocolVersion: 1 });
  const keys = Object.keys(r.value || {}).sort().join(',');
  check('16 response contains no requestId, jobRef, action, name, or signature',
    keys === 'periodId,protocolVersion,state'
    && !JSON.stringify(r.value).includes('requestId')
    && !JSON.stringify(r.value).includes('jobRef')
    && !JSON.stringify(r.value).includes('read_and_acknowledged')
    && !JSON.stringify(r.value).includes('legalName'));
}

// 17 auth failure fail-closed
{
  const d = mem({ records: [rec()] });
  const r = await run(d, { uid: null, claims: {} }, { protocolVersion: 1 });
  check('17 authentication failure fails closed',
    !r.ok && r.err instanceof JsaReceiptError && r.err.http === 'unauthenticated'
    && d.writes.length === 0);
}

// 18 authority / read failure does not degrade to none
{
  const d = mem({ resolveThrow: true, records: [rec()] });
  const r = await run(d, AUTH, { protocolVersion: 1 });
  check('18a resolve throw does not become none',
    !r.ok && r.err instanceof JsaReceiptError && r.value === undefined);
}
{
  const d = mem({
    shift: { state: 'unverifiable', reason: 'authority_inconsistent' },
    records: [],
  });
  const r = await run(d, AUTH, { protocolVersion: 1 });
  check('18b unverifiable authority does not become none or no_active_shift',
    !r.ok && r.err instanceof JsaReceiptError && r.err.refusal === 'authority_unverifiable');
}
{
  const d = mem({ queryThrow: true });
  const r = await run(d, AUTH, { protocolVersion: 1 });
  check('18c query failure does not become none',
    !r.ok && r.err instanceof JsaReceiptError && r.value === undefined);
}

// 19 no write
{
  const d = mem({ records: [rec()] });
  await run(d, AUTH, { protocolVersion: 1 });
  check('19 no governed or legacy write occurs',
    d.writes.every((w) => w.op === 'list'));
}

// 20 existing four callables still exported / handlers untouched
{
  const callables = readFileSync(join(root, 'src/jsaReceipt/jsaReceiptCallables.ts'), 'utf8');
  const idx = readFileSync(join(root, 'src/index.ts'), 'utf8');
  check('20a existing four callables still exported',
    /export const jsaRegisterReadRequest/.test(callables)
    && /export const jsaGetReadRequest/.test(callables)
    && /export const jsaCompleteReadRequest/.test(callables)
    && /export const jsaConsumeReadResult/.test(callables)
    && idx.includes('jsaRegisterReadRequest')
    && idx.includes('jsaResolveCurrentShiftReadEvidence'));
  check('20b new callable is additive',
    /export const jsaResolveCurrentShiftReadEvidence/.test(callables));
}

// 21 logs carry no identity / payload
{
  const d = mem({ records: [rec()] });
  await run(d, AUTH, { protocolVersion: 1 });
  const blob = JSON.stringify(d.logs);
  check('21 no sensitive identity or governed payload is logged',
    d.logs.length === 1
    && d.logs[0].event === 'jsa.shift_read_evidence'
    && d.logs[0].extra.state === 'read_bootstrapped'
    && !blob.includes(DRIVER)
    && !blob.includes(PERIOD)
    && !blob.includes('requestId')
    && !blob.includes('legalName')
    && !blob.includes('DNCL'));
}

check('canonical terminalActionIncludesRead is the contracts helper',
  terminalActionIncludesRead('read_and_acknowledged')
  && !terminalActionIncludesRead('acknowledged'));

check('unsupported protocol is failed-precondition, not none',
  ((await run(mem(), AUTH, { protocolVersion: 99 })).err instanceof JsaReceiptError)
  && (await run(mem(), AUTH, { protocolVersion: 99 })).err.http === 'failed-precondition');

console.log(`\njsa current-shift read evidence: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
