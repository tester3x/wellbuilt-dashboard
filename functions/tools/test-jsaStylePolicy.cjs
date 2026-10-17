// Exercise the production policy reader, not an independently mocked policy.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { decideIntentAllowed } = require('../lib/jsaReceipt/jsaReceiptCore.js');
const source = fs.readFileSync(path.join(__dirname, '../src/jsaReceipt/jsaReceiptCallables.ts'), 'utf8');
const start = source.indexOf('    async getJsaStylePolicy(companyId) {');
const end = source.indexOf('    async readInvoice(jobRef)', start);
assert.ok(start >= 0 && end > start);
const method = source.slice(start, end).trim().replace(/,$/, '');
let data = {}, failed = false;
const db = { collection: () => ({ doc: () => ({ get: async () => {
  if (failed) throw Error('offline');
  return { data: () => data };
} }) }) };
const read = new Function('db', `return ({${method}}).getJsaStylePolicy;`)(db);
(async () => {
  for (const fixture of [
    { data: { jsaJobPolicy: 'acknowledge' }, ack: true },
    { data: { jsaJobPolicy: 'read' }, ack: false },
    { data: { jsaJobPolicy: 'read_and_acknowledge' }, ack: true },
    { data: {}, ack: true },
    { data: { jsaAllowAcknowledge: false }, ack: false },
    { data: { jsaJobPolicy: 'read', jsaAllowAcknowledge: true }, ack: false },
  ]) {
    data = fixture.data;
    const style = await read('fixture-company');
    assert.equal(style.allowRead, true, 'first-job full read must be permitted even for acknowledgement customers');
    assert.equal(style.allowAcknowledge, fixture.ack);
    const policy = { ...style, jsaEnabled: true, requiresActiveShift: true };
    assert.equal(decideIntentAllowed('read', policy).ok, true);
    assert.equal(decideIntentAllowed('acknowledge', policy).ok, fixture.ack);
    assert.equal(decideIntentAllowed('read', { ...policy, jsaEnabled: false }).ok, false);
  }
  failed = true;
  assert.deepEqual(await read('fixture-company'), { allowRead: true, allowAcknowledge: false });
  console.log('PASS production policy reader: first-job read, subsequent acknowledgement, explicit policy precedence, disabled entitlement and read-failure fallback');
})().catch(error => { console.error(error); process.exitCode = 1; });
