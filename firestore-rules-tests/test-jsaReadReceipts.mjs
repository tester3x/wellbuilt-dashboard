/**
 * jsa_read_receipts rules matrix (8/6, contract v1) — runs INSIDE the
 * Firestore emulator via:
 *
 *   npx firebase emulators:exec --only firestore --project wellbuilt-sync \
 *     "node firestore-rules-tests/test-jsaReadReceipts.mjs"
 *
 * ENV NOTE (Windows): if the emulator dies with "Unable to establish
 * loopback connection" / UnixDomainSockets "Invalid argument", the JDK's
 * NIO pipe is tripping on the 8.3-mangled default temp path. Fix:
 *   mkdir D:\tmp   (once)
 *   JAVA_TOOL_OPTIONS="-Djdk.net.unixdomain.tmpdir=D:\tmp" npx firebase emulators:exec ...
 *
 * Uses plain REST against the emulator (no SDK deps). All requests are
 * UNAUTHENTICATED — that IS the suite's deployed model (API-key REST, no
 * Firebase Auth), so the identity-binding cases below assert the HONEST
 * limitation: schema/immutability are enforced; company/driver identity
 * cannot be (documented in the rules; deployment needs a security review).
 */

const host = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const PID = 'wellbuilt-sync';
const BASE = `http://${host}/v1/projects/${PID}/databases/(default)/documents`;

const RID = 'A'.repeat(20) + 'b'.repeat(20) + '-_c';
const RID2 = 'B'.repeat(20) + 'c'.repeat(20) + '-_d';

const s = (v) => ({ stringValue: v });
const goodFields = (requestId = RID) => ({
  receiptVersion: { integerValue: '1' },
  requestId: s(requestId),
  jobDocId: s('INV_123'),
  haulGroupId: s('hg9'),
  companyId: s('liquid-gold'),
  driverHash: s('da561bc4'),
  shiftId: s('2026-08-06_060000'),
  operator: s('SLAWSON'),
  jsaRecordId: s('1754470000000'),
  completedAt: s('2026-08-06T09:12:00.000Z'),
  completionType: s('full_flow'),
});

async function patchDoc(docId, fields) {
  const r = await fetch(`${BASE}/jsa_read_receipts/${docId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  return r.status;
}

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (got ${actual}, want ${expected})`);
};

// Valid create — unauthenticated, as the deployed model actually is.
check('valid create succeeds', await patchDoc(RID, goodFields()), 200);
// Read back (unguessable doc id is the practical read scope).
check('read succeeds', (await fetch(`${BASE}/jsa_read_receipts/${RID}`)).status, 200);
// Update/replay — immutable: identity mutation bounces.
check('update mutating identity denied',
  await patchDoc(RID, { ...goodFields(), jobDocId: s('INV_OTHER') }), 403);
check('replayed identical write denied (create-only)',
  await patchDoc(RID, goodFields()), 403);
// Delete denied.
check('delete denied',
  (await fetch(`${BASE}/jsa_read_receipts/${RID}`, { method: 'DELETE' })).status, 403);
// Doc-id / syntax / schema failures.
check('docId ≠ requestId denied', await patchDoc(RID2, goodFields(RID)), 403);
check('bad id syntax denied', await patchDoc('short-id', { ...goodFields('short-id') }), 403);
{
  const extra = { ...goodFields('C'.repeat(20) + 'd'.repeat(20) + '-_e') };
  extra.requestId = s('C'.repeat(20) + 'd'.repeat(20) + '-_e');
  extra.surprise = s('nope');
  check('extra field denied', await patchDoc('C'.repeat(20) + 'd'.repeat(20) + '-_e', extra), 403);
}
{
  const id = 'D'.repeat(20) + 'e'.repeat(20) + '-_f';
  const f = goodFields(id); f.receiptVersion = { integerValue: '2' };
  check('unsupported version denied', await patchDoc(id, f), 403);
}
{
  const id = 'E'.repeat(20) + 'f'.repeat(20) + '-_g';
  const f = goodFields(id); f.completionType = s('shift');
  check('non-full_flow completion denied', await patchDoc(id, f), 403);
}
{
  const id = 'F'.repeat(20) + 'g'.repeat(20) + '-_h';
  const f = goodFields(id); f.driverHash = s('short');
  check('short driverHash denied', await patchDoc(id, f), 403);
}
{
  const id = 'G'.repeat(20) + 'h'.repeat(20) + '-_i';
  const f = goodFields(id); delete f.jsaRecordId;
  check('missing submission id denied', await patchDoc(id, f), 403);
}
// HONEST LIMITATION (documented, not a bug): with no auth model, a create
// claiming any company/driver is accepted if well-formed — the 256-bit
// unguessable request id is the practical binding. These are labeled
// expectations, not aspirations.
{
  const id = 'H'.repeat(20) + 'i'.repeat(20) + '-_j';
  const f = goodFields(id); f.companyId = s('other-co'); f.driverHash = s('ffffffff');
  check('LIMITATION: foreign company/driver create allowed (no auth model)', await patchDoc(id, f), 200);
}
// Bad timestamp type (integer where string required).
{
  const id = 'I'.repeat(20) + 'j'.repeat(20) + '-_k';
  const f = goodFields(id); f.completedAt = { integerValue: '1754470000000' };
  check('non-string completedAt denied', await patchDoc(id, f), 403);
}

// ── vc51.4: enumeration is impossible through reads ─────────────────────────
// `list: false` denies the plain collection list AND every query shape —
// receipt ids cannot be discovered; only exact possession retrieves.
async function runQuery(body) {
  const r = await fetch(`http://${host}/v1/projects/${PID}/databases/(default)/documents:runQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.status;
}
const fieldEq = (path, value) => ({
  fieldFilter: { field: { fieldPath: path }, op: 'EQUAL', value: { stringValue: value } },
});
check('collection list denied',
  (await fetch(`${BASE}/jsa_read_receipts`)).status, 403);
check('unfiltered query denied',
  await runQuery({ structuredQuery: { from: [{ collectionId: 'jsa_read_receipts' }] } }), 403);
check('query filtered by company denied',
  await runQuery({ structuredQuery: { from: [{ collectionId: 'jsa_read_receipts' }], where: fieldEq('companyId', 'liquid-gold') } }), 403);
check('query filtered by driver denied',
  await runQuery({ structuredQuery: { from: [{ collectionId: 'jsa_read_receipts' }], where: fieldEq('driverHash', 'da561bc4') } }), 403);
check('query filtered by job denied',
  await runQuery({ structuredQuery: { from: [{ collectionId: 'jsa_read_receipts' }], where: fieldEq('jobDocId', 'INV_123') } }), 403);
check('limit-1 query denied',
  await runQuery({ structuredQuery: { from: [{ collectionId: 'jsa_read_receipts' }], limit: 1 } }), 403);
// Exact get with the known id still works (capability model).
check('exact get with possessed id still succeeds',
  (await fetch(`${BASE}/jsa_read_receipts/${RID}`)).status, 200);
// A GET for a malformed/unknown id yields nothing useful.
check('exact get of unknown id → 404 (no discovery signal)',
  (await fetch(`${BASE}/jsa_read_receipts/${'Z'.repeat(20) + 'z'.repeat(20) + '-_z'}`)).status, 404);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
