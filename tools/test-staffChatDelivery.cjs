const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript'), assert = require('node:assert/strict');
const memory = new Map(), sent = [];
const first = { uid: 'first' }, second = { uid: 'second' }, auth = { currentUser: first };
let confirmed = false, serial = 0;
const mocks = {
  'firebase/functions': { httpsCallable: () => async data => { sent.push(data); return { data: { ok: confirmed, messageId: `c_${data.clientId}` } }; } },
  'firebase/auth': { onIdTokenChanged: () => () => {} }, './firebase': { getFirebaseAuth: () => auth, getFirebaseFunctions: () => ({}) },
};
const fixture = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/staffChatClient.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { module: fixture, exports: fixture.exports, require: name => mocks[name], crypto: { randomUUID: () => `intent-${++serial}` },
    localStorage: { getItem: key => memory.get(key), setItem: (key, value) => memory.set(key, value) }, Set, Promise, Date });
(async () => {
  const api = fixture.exports;
  await api.sendStaffChat('thread', 'Fixture', 'fixture-co'); await api.flushStaffChat();
  const id = JSON.parse(memory.get('wb_staff_chat_v1:first'))[0].clientId;
  assert.equal(id, sent[0].clientId);
  auth.currentUser = second; confirmed = true; const before = sent.length;
  await api.flushStaffChat(); assert.equal(sent.length, before, 'second account cannot transmit first account work');
  auth.currentUser = first; await api.flushStaffChat(); assert.equal(sent.at(-1).clientId, id); assert.equal(JSON.parse(memory.get('wb_staff_chat_v1:first')).length, 0);
  for (const path of ['src/app/chat/page.tsx', 'src/components/chat/ChatSidebar.tsx']) {
    const code = fs.readFileSync(path, 'utf8');
    assert.ok(!/\b(addDoc|updateDoc|writeBatch|deleteDoc)\s*\(/.test(code), `${path}: no direct writes that bypass server authority`);
    assert.ok(code.includes('sendStaffChat(') && code.includes('watchStaffChat('));
  }
  console.log('Staff chat: durable same-ID retry, account fence and governed UI entry points passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
