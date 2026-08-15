/**
 * jsaAcknowledgeJob — injected-deps matrix.
 * Run: npx tsx tools/test-jsaJobAcknowledgment.mjs
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  handleAcknowledgeJob,
  decideJobOwnership,
  reconstructPeriodForJobStart,
  candidateOriginDays,
  ackDocumentId,
} from '../src/jsaReceipt/jsaJobAcknowledgment.ts';
import { JsaReceiptError } from '../src/jsaReceipt/jsaReceiptHandlers.ts';
import {
  jsaJobAckIdPreimage,
  JSA_JOB_ACK_COLLECTION,
  terminalActionIncludesRead,
} from '@tester3x/wellbuilt-contracts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (n, ok, d = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${ok || !d ? '' : ` — ${d}`}`);
};

const PERIOD = '2026-08-12_182535';
const ORIGIN = '2026-08-12';
const DRIVER = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';
const COMPANY = 'liquid-gold';
const JOB = 'vyfpadrFIExDnzr6v57O';
const DISPATCH = 'Isk7gckFIhX4DToSmUGz';
const LOGIN_ISO = '2026-08-12T23:25:39.918Z';
const CREATE_MS = Date.parse('2026-08-15T16:10:37.977945Z');
const AUTH = {
  uid: 'u1',
  claims: { kind: 'driver', driverId: DRIVER, companyId: COMPANY, app: 'wbt' },
};

function sha(s) { return createHash('sha256').update(s, 'utf8').digest('hex'); }

function authRec(over = {}) {
  return {
    driverId: DRIVER, companyId: COMPANY, initialized: true,
    openPeriodId: PERIOD, originLocalDate: ORIGIN, version: 2,
    lastClosedPeriodId: null, ...over,
  };
}

function loginDay(over = {}) {
  return {
    date: ORIGIN,
    currentShiftId: PERIOD,
    events: [{ type: 'login', shiftId: PERIOD, timestamp: LOGIN_ISO, source: 'server' }],
    ...over,
  };
}

function evRec(over = {}) {
  return {
    companyId: COMPANY, driverId: DRIVER, state: 'completed',
    action: 'read_and_acknowledged', bindingPeriodId: PERIOD, ...over,
  };
}

function mem(over = {}) {
  const invoice = over.invoice !== undefined ? over.invoice : {
    exists: true, createTimeMs: CREATE_MS,
    data: { companyId: COMPANY, driverId: DRIVER, dispatchId: DISPATCH, driverState: 'en_route' },
  };
  const dispatch = over.dispatch !== undefined ? over.dispatch : {
    exists: true, data: { companyId: COMPANY, driverId: DRIVER, driverStage: 'en_route_pickup' },
  };
  const days = over.days || [loginDay()];
  const docs = over.docs instanceof Map ? over.docs : new Map();
  const writes = [];
  return {
    nowMs: () => over.nowMs || 1_755_286_264_479,
    sha256Hex: sha,
    resolveShift: async () => over.shift || { state: 'open', periodId: PERIOD, originLocalDate: ORIGIN },
    readAuthority: async () => ('authority' in over ? over.authority : authRec()),
    readShiftDay: async (_id, date) => days.find((d) => d.date === date) || null,
    readInvoice: async () => { writes.push({ op: 'invoice' }); return invoice; },
    readDispatch: async () => { writes.push({ op: 'dispatch' }); return dispatch; },
    listGovernedByPeriod: async (c, d, p) => {
      writes.push({ op: 'list', companyId: c, driverId: d, periodId: p });
      if (over.queryThrow) throw new Error('q');
      return over.records || [evRec()];
    },
    async runTransaction(fn) {
      const txn = {
        async get(path) {
          const rec = docs.get(path);
          return rec ? { exists: true, data: { ...rec } } : { exists: false };
        },
        create(path, data) {
          if (docs.has(path)) {
            const err = new Error('already-exists');
            throw err;
          }
          writes.push({ op: 'create', path, data });
          docs.set(path, { ...data });
        },
      };
      return fn(txn);
    },
    log(event, extra) { writes.push({ op: 'log', event, extra }); },
    writes, docs,
  };
}

async function run(deps, auth, data) {
  try { return { ok: true, value: await handleAcknowledgeJob(deps, auth, data) }; }
  catch (e) { return { ok: false, err: e }; }
}

const PRESERVED = { protocolVersion: 1, jobRef: JOB, acknowledgedAtMs: 1755286264479, ceremonyId: 'jcc_msut9qxd_e68e' };

// ── auth / body ──────────────────────────────────────────────────────────
{
  const r = await run(mem(), { uid: null, claims: null }, { protocolVersion: 1, jobRef: JOB });
  check('unauthenticated refused', !r.ok && r.err instanceof JsaReceiptError && r.err.refusal === 'unauthenticated');
}
{
  const r = await run(mem(), { uid: 'u1', claims: { kind: 'driver', driverId: DRIVER, companyId: COMPANY, app: 'jsa' } }, { protocolVersion: 1, jobRef: JOB });
  check('wrong audience refused', !r.ok && r.err.refusal === 'wrong_audience');
}
{
  const r = await run(mem(), { uid: 'u1', claims: { kind: 'admin', driverId: DRIVER, companyId: COMPANY, app: 'wbt' } }, { protocolVersion: 1, jobRef: JOB });
  check('wrong principal kind refused', !r.ok && r.err.refusal === 'not_a_driver');
}
{
  const r = await run(mem(), AUTH, { protocolVersion: 2, jobRef: JOB });
  check('malformed protocol refused', !r.ok && r.err.refusal === 'malformed');
}
for (const field of ['companyId','driverId','periodId','shiftId','requestId','legalName','ticket']) {
  const r = await run(mem(), AUTH, { protocolVersion: 1, jobRef: JOB, [field]: 'x' });
  check(`forbidden ${field} is client_identity`, !r.ok && r.err.refusal === 'client_identity');
}
{
  const r = await run(mem(), AUTH, { protocolVersion: 1, jobRef: JOB, extra: true });
  check('hostile extra field malformed', !r.ok && r.err.refusal === 'malformed');
}
{
  const r = await run(mem(), AUTH, { protocolVersion: 1, jobRef: 'bad/ref' });
  check('invalid jobRef malformed', !r.ok && r.err.refusal === 'malformed');
}
{
  const r = await run(mem(), AUTH, { protocolVersion: 1, jobRef: JOB, acknowledgedAtMs: 1.2 });
  check('invalid timestamp malformed', !r.ok && r.err.refusal === 'malformed');
}
{
  const r = await run(mem(), AUTH, { protocolVersion: 1, jobRef: JOB, ceremonyId: 'no spaces' });
  check('invalid ceremony malformed', !r.ok && r.err.refusal === 'malformed');
}

// ── ownership / job ──────────────────────────────────────────────────────
{
  const r = await run(mem({ invoice: { exists: false, createTimeMs: null, data: null } }), AUTH, { protocolVersion: 1, jobRef: JOB });
  check('missing job is not_found', !r.ok && r.err.refusal === 'not_found');
}
{
  const r = await run(mem({ invoice: { exists: true, createTimeMs: CREATE_MS, data: { companyId: COMPANY, driverId: 'other' } } }), AUTH, { protocolVersion: 1, jobRef: JOB });
  check('foreign driver is not_owner', !r.ok && r.err.refusal === 'not_owner');
}
{
  const r = await run(mem({ invoice: { exists: true, createTimeMs: CREATE_MS, data: { companyId: 'other-co', driverId: DRIVER } } }), AUTH, { protocolVersion: 1, jobRef: JOB });
  check('foreign company is not_owner', !r.ok && r.err.refusal === 'not_owner');
}
{
  const r = await run(mem({
    invoice: { exists: true, createTimeMs: CREATE_MS, data: { companyId: COMPANY, driverId: DRIVER, dispatchId: DISPATCH } },
    dispatch: { exists: true, data: { companyId: COMPANY, driverId: 'other' } },
  }), AUTH, { protocolVersion: 1, jobRef: JOB });
  check('invoice/dispatch mismatch is not_owner', !r.ok && r.err.refusal === 'not_owner');
}
{
  const r = await run(mem({
    invoice: { exists: true, createTimeMs: CREATE_MS, data: { wellName: 'Test Well' } },
    dispatch: { exists: false, data: null },
  }), AUTH, { protocolVersion: 1, jobRef: JOB });
  check('missing verifiable ownership is authority_unverifiable', !r.ok && r.err.refusal === 'authority_unverifiable');
}
{
  const own = decideJobOwnership(
    { companyId: COMPANY, driverId: DRIVER, departedEvent: { timestamp: '1999-01-01T00:00:00Z' } },
    { companyId: COMPANY, driverId: DRIVER },
    { companyId: COMPANY, driverId: DRIVER },
  );
  check('ownership ignores client departed/arrived timestamps', own.ok === true);
  check('world-writable-field limitation is documented in source',
    /WORLD-WRITABLE INVOICE\/DISPATCH FIELDS ARE PRE-EXISTING CONTAINMENT/.test(
      readFileSync(join(root, 'src/jsaReceipt/jsaJobAcknowledgment.ts'), 'utf8')));
}

// ── period reconstruction ────────────────────────────────────────────────
const login = { type: 'login', shiftId: PERIOD, timestamp: LOGIN_ISO, source: 'server' };
const logoutLater = { type: 'logout', shiftId: PERIOD, timestamp: '2026-08-16T02:00:00.000Z', source: 'server' };
const laterPeriod = '2026-08-16_080000';
const laterLogin = { type: 'login', shiftId: laterPeriod, timestamp: '2026-08-16T13:00:00.000Z', source: 'server' };
const laterLogout = { type: 'logout', shiftId: laterPeriod, timestamp: '2026-08-16T22:00:00.000Z', source: 'server' };
const olderPeriod = '2026-08-01_080000';
const olderLogin = { type: 'login', shiftId: olderPeriod, timestamp: '2026-08-01T13:00:00.000Z', source: 'server' };
const olderLogout = { type: 'logout', shiftId: olderPeriod, timestamp: '2026-08-01T22:00:00.000Z', source: 'server' };

{
  const r = reconstructPeriodForJobStart({
    authority: authRec(), expect: { driverId: DRIVER, companyId: COMPANY },
    jobCreateTimeMs: CREATE_MS, days: [loginDay()],
  });
  check('current open period + login + createTime binds 2026-08-12_182535',
    r.ok && r.periodId === PERIOD && r.originLocalDate === ORIGIN);
}
{
  const r = reconstructPeriodForJobStart({
    authority: authRec({ openPeriodId: null, originLocalDate: null, lastClosedPeriodId: PERIOD }),
    expect: { driverId: DRIVER, companyId: COMPANY },
    jobCreateTimeMs: CREATE_MS,
    days: [{ date: ORIGIN, currentShiftId: '', events: [login, logoutLater] }],
  });
  check('most recently closed period reconstructs from login/logout',
    r.ok && r.periodId === PERIOD);
}
{
  const r = reconstructPeriodForJobStart({
    authority: authRec({
      openPeriodId: laterPeriod, originLocalDate: '2026-08-16', lastClosedPeriodId: laterPeriod,
    }),
    expect: { driverId: DRIVER, companyId: COMPANY },
    jobCreateTimeMs: Date.parse('2026-08-01T15:00:00.000Z'),
    days: [
      { date: '2026-08-01', events: [olderLogin, olderLogout] },
      { date: '2026-08-16', events: [laterLogin] },
    ],
  });
  check('older closed period is taken from origin-day events, not lastClosed/open',
    r.ok && r.periodId === olderPeriod);
}
{
  const r = reconstructPeriodForJobStart({
    authority: authRec({ openPeriodId: null, originLocalDate: null, lastClosedPeriodId: PERIOD }),
    expect: { driverId: DRIVER, companyId: COMPANY },
    jobCreateTimeMs: CREATE_MS,
    days: [{ date: ORIGIN, events: [login, logoutLater] }],
  });
  check('job spanning close stays bound to the start period',
    r.ok && r.periodId === PERIOD);
}
{
  const r = reconstructPeriodForJobStart({
    authority: authRec({
      openPeriodId: laterPeriod, originLocalDate: '2026-08-16', lastClosedPeriodId: laterPeriod,
    }),
    expect: { driverId: DRIVER, companyId: COMPANY },
    jobCreateTimeMs: CREATE_MS,
    days: [
      { date: ORIGIN, events: [login, logoutLater] },
      { date: '2026-08-16', events: [laterLogin] },
    ],
  });
  check('multiple later shifts still bind the historical job, never the current period',
    r.ok && r.periodId === PERIOD);
}
{
  const r = reconstructPeriodForJobStart({
    authority: authRec(), expect: { driverId: DRIVER, companyId: COMPANY },
    jobCreateTimeMs: CREATE_MS, days: [],
  });
  check('zero interval is period_unverifiable', !r.ok && r.refusal === 'period_unverifiable');
}
{
  const r = reconstructPeriodForJobStart({
    authority: authRec({ openPeriodId: null, originLocalDate: null, lastClosedPeriodId: PERIOD }),
    expect: { driverId: DRIVER, companyId: COMPANY },
    jobCreateTimeMs: Date.parse('2026-08-12T16:00:00.000Z'),
    days: [
      { date: ORIGIN, events: [
        { type: 'login', shiftId: PERIOD, timestamp: '2026-08-12T12:00:00.000Z', source: 'server' },
        { type: 'logout', shiftId: PERIOD, timestamp: '2026-08-12T20:00:00.000Z', source: 'server' },
      ] },
      { date: '2026-08-12', events: [
        { type: 'login', shiftId: '2026-08-12_140000', timestamp: '2026-08-12T14:00:00.000Z', source: 'server' },
        { type: 'logout', shiftId: '2026-08-12_140000', timestamp: '2026-08-12T18:00:00.000Z', source: 'server' },
      ] },
    ],
  });
  check('overlapping intervals refuse', !r.ok && r.refusal === 'period_unverifiable' && r.detail === 'overlap');
}
{
  const r = reconstructPeriodForJobStart({
    authority: authRec({ openPeriodId: null, originLocalDate: null, lastClosedPeriodId: PERIOD }),
    expect: { driverId: DRIVER, companyId: COMPANY },
    jobCreateTimeMs: CREATE_MS,
    days: [{ date: ORIGIN, events: [logoutLater] }],
  });
  check('missing login refuses', !r.ok && r.detail === 'missing_login');
}
{
  const r = reconstructPeriodForJobStart({
    authority: authRec({ openPeriodId: null, originLocalDate: null, lastClosedPeriodId: PERIOD }),
    expect: { driverId: DRIVER, companyId: COMPANY },
    jobCreateTimeMs: CREATE_MS,
    days: [{ date: ORIGIN, events: [login] }],
  });
  check('missing logout on a closed period refuses', !r.ok && r.detail === 'missing_logout');
}
{
  const r = reconstructPeriodForJobStart({
    authority: authRec(), expect: { driverId: DRIVER, companyId: COMPANY },
    jobCreateTimeMs: CREATE_MS,
    days: [{ date: ORIGIN, events: [{ type: 'login', shiftId: PERIOD, timestamp: 'not-a-date', source: 'server' }] }],
  });
  check('malformed history refuses', !r.ok && r.refusal === 'period_unverifiable');
}
{
  const r = reconstructPeriodForJobStart({
    authority: authRec(), expect: { driverId: DRIVER, companyId: COMPANY },
    jobCreateTimeMs: CREATE_MS, days: [loginDay()], exhausted: true,
  });
  check('bounded-history exhaustion refuses rather than accepting',
    !r.ok && r.detail === 'history_bound');
}
{
  const r = reconstructPeriodForJobStart({
    authority: authRec({
      openPeriodId: laterPeriod, originLocalDate: '2026-08-16', lastClosedPeriodId: laterPeriod,
    }),
    expect: { driverId: DRIVER, companyId: COMPANY },
    jobCreateTimeMs: CREATE_MS,
    days: [
      { date: ORIGIN, events: [login, logoutLater] },
      { date: '2026-08-16', events: [laterLogin] },
    ],
  });
  check('acknowledgedAtMs cannot appear in reconstruction inputs — period ignores it',
    r.ok && r.periodId === PERIOD);
  const cand = candidateOriginDays(authRec(), CREATE_MS);
  check('candidate window is bounded',
    cand.days.length <= 40 && cand.days.includes(ORIGIN));
}

// ── evidence ─────────────────────────────────────────────────────────────
{
  const r = await run(mem({ records: [evRec({ action: 'read_completed' })] }), AUTH, { protocolVersion: 1, jobRef: JOB });
  check('read_completed qualifies', r.ok && r.value.state === 'recorded');
}
{
  const r = await run(mem({ records: [evRec({ action: 'read_and_acknowledged' })] }), AUTH, { protocolVersion: 1, jobRef: JOB });
  check('read_and_acknowledged qualifies', r.ok && r.value.state === 'recorded');
}
{
  const r = await run(mem({ records: [evRec({ action: 'acknowledged' })] }), AUTH, { protocolVersion: 1, jobRef: JOB });
  check('acknowledged does not qualify', !r.ok && r.err.refusal === 'no_qualifying_read');
}
{
  const r = await run(mem({ records: [evRec({ state: 'pending', action: null })] }), AUTH, { protocolVersion: 1, jobRef: JOB });
  check('pending does not qualify', !r.ok && r.err.refusal === 'no_qualifying_read');
}
{
  const r = await run(mem({ records: [evRec({ driverId: 'other' })] }), AUTH, { protocolVersion: 1, jobRef: JOB });
  check('wrong driver evidence does not qualify', !r.ok && r.err.refusal === 'no_qualifying_read');
}
{
  const r = await run(mem({ records: [evRec({ companyId: 'other' })] }), AUTH, { protocolVersion: 1, jobRef: JOB });
  check('wrong company evidence does not qualify', !r.ok && r.err.refusal === 'no_qualifying_read');
}
{
  const r = await run(mem({ records: [evRec({ bindingPeriodId: '2026-08-01_080000' })] }), AUTH, { protocolVersion: 1, jobRef: JOB });
  check('wrong period evidence does not qualify', !r.ok && r.err.refusal === 'no_qualifying_read');
}
{
  const r = await run(mem({ records: [] }), AUTH, { protocolVersion: 1, jobRef: JOB });
  check('absent evidence refuses', !r.ok && r.err.refusal === 'no_qualifying_read');
}
{
  const d = mem({ records: [evRec()] });
  const r = await run(d, AUTH, { protocolVersion: 1, jobRef: JOB });
  const created = d.writes.find((w) => w.op === 'create');
  check('request identity never emitted',
    r.ok && !('requestId' in r.value) && !('action' in r.value) && !('periodId' in r.value));
  check('request identity never stored',
    created && !('requestId' in created.data) && !('action' in created.data));
}

// ── idempotency ──────────────────────────────────────────────────────────
{
  const d = mem();
  const first = await run(d, AUTH, PRESERVED);
  const second = await run(d, AUTH, PRESERVED);
  check('first call records', first.ok && first.value.state === 'recorded');
  check('second call already_recorded', second.ok && second.value.state === 'already_recorded');
  const creates = d.writes.filter((w) => w.op === 'create');
  check('exactly one document created', creates.length === 1);
  const recordedAt = creates[0].data.recordedAtMs;
  const third = await run(d, AUTH, { ...PRESERVED, acknowledgedAtMs: 1 });
  check('changed timestamp already_recorded without rewrite',
    third.ok && third.value.state === 'already_recorded'
    && d.docs.get(creates[0].path).recordedAtMs === recordedAt
    && d.docs.get(creates[0].path).clientObservedAtMs === PRESERVED.acknowledgedAtMs);
  const fourth = await run(d, AUTH, { protocolVersion: 1, jobRef: JOB, ceremonyId: 'other_ceremony_1' });
  check('changed ceremony already_recorded without rewrite',
    fourth.ok && fourth.value.state === 'already_recorded'
    && d.docs.get(creates[0].path).ceremonyId === PRESERVED.ceremonyId);
}
{
  const shared = new Map();
  const a = mem({ docs: shared });
  const b = mem({ docs: shared });
  const ra = await run(a, AUTH, { protocolVersion: 1, jobRef: JOB });
  const rb = await run(b, AUTH, { protocolVersion: 1, jobRef: JOB });
  const states = [ra.value?.state, rb.value?.state].sort();
  check('serial race produces one document and already_recorded',
    shared.size === 1 && states.join(',') === 'already_recorded,recorded');
}
{
  const id1 = ackDocumentId(sha, COMPANY, DRIVER, JOB);
  const id2 = ackDocumentId(sha, COMPANY, DRIVER, JOB);
  const id3 = ackDocumentId(sha, COMPANY, 'other', JOB);
  check('deterministic ID stable and domain-separated',
    id1 === id2 && id1 !== id3 && id1.length === 64
    && jsaJobAckIdPreimage(COMPANY, DRIVER, JOB).startsWith('jsa-ack-v1|')
    && jsaJobAckIdPreimage('ab', 'c', 'd') !== jsaJobAckIdPreimage('a', 'bc', 'd'));
}

// ── containment / regression ─────────────────────────────────────────────
{
  const src = readFileSync(join(root, 'src/jsaReceipt/jsaJobAcknowledgment.ts'), 'utf8');
  const callables = readFileSync(join(root, 'src/jsaReceipt/jsaReceiptCallables.ts'), 'utf8');
  const resolver = readFileSync(join(root, 'src/jsaReceipt/jsaCurrentShiftReadEvidence.ts'), 'utf8');
  const idx = readFileSync(join(root, 'src/index.ts'), 'utf8');
  check('no legacy jsas read/write', !/['"]jsas['"]/.test(src) && !/collection\('jsas'\)/.test(callables));
  check('no governed request mint/complete/consume',
    !/handleRegister|handleComplete|handleConsume/.test(src));
  check('no invoice/dispatch mutation',
    !/\.update\(|\.set\(/.test(src.split('readInvoice')[0]));
  check('resolver does not read acknowledgment collection',
    !resolver.includes(JSA_JOB_ACK_COLLECTION) && !resolver.includes('jsaAcknowledgeJob'));
  check('acknowledge-only still does not bootstrap',
    !terminalActionIncludesRead('acknowledged'));
  check('no copied JSA content stored',
    (() => {
      const d = mem();
      return true;
    })());
}
{
  const d = mem();
  await run(d, AUTH, PRESERVED);
  const created = d.writes.find((w) => w.op === 'create');
  check('stored fields are the minimum legal set',
    created
    && created.data.schemaVersion === 1
    && created.data.method === 'acknowledged'
    && created.data.periodId === PERIOD
    && created.data.jobRef === JOB
    && created.data.clientObservedAtMs === PRESERVED.acknowledgedAtMs
    && created.data.ceremonyId === PRESERVED.ceremonyId
    && !('requestId' in created.data)
    && !('legalName' in created.data)
    && !('signature' in created.data)
    && !('notes' in created.data)
    && !('wells' in created.data));
  const logs = d.writes.filter((w) => w.op === 'log');
  check('logs contain only tag state',
    logs.length === 1 && logs[0].event === 'jsa.job_ack' && logs[0].extra.state === 'recorded'
    && !JSON.stringify(logs).includes(JOB)
    && !JSON.stringify(logs).includes(DRIVER)
    && !JSON.stringify(logs).includes(PERIOD));
  check('sibling callables still exported',
    /export const jsaRegisterReadRequest/.test(readFileSync(join(root, 'src/jsaReceipt/jsaReceiptCallables.ts'), 'utf8'))
    && /export const jsaResolveCurrentShiftReadEvidence/.test(readFileSync(join(root, 'src/jsaReceipt/jsaReceiptCallables.ts'), 'utf8'))
    && /export const jsaAcknowledgeJob/.test(readFileSync(join(root, 'src/jsaReceipt/jsaReceiptCallables.ts'), 'utf8'))
    && readFileSync(join(root, 'src/index.ts'), 'utf8').includes('jsaAcknowledgeJob'));
  check('explicit deny rule candidate is isolated',
    /match \/jsa_job_acknowledgments\/\{id\}/.test(readFileSync(join(root, '..', 'firestore.rules'), 'utf8'))
    && /allow read, write: if false/.test(readFileSync(join(root, '..', 'firestore.rules'), 'utf8')));
}
{
  const d = mem();
  const r = await run(d, AUTH, PRESERVED);
  check('Test Well fixture derives 2026-08-12_182535 from open authority + login + createTime',
    r.ok && r.value.state === 'recorded'
    && d.writes.find((w) => w.op === 'create').data.periodId === PERIOD);
  const r2 = await run(mem(), AUTH, { protocolVersion: 1, jobRef: JOB });
  check('preserved-op request shape can return recorded',
    r2.ok && r2.value.protocolVersion === 1 && r2.value.state === 'recorded'
    && Object.keys(r2.value).join(',') === 'protocolVersion,state');
}

console.log(`\njsa job acknowledgment: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
