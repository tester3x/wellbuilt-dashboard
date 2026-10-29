// Executes the shipped auth wrapper with Firebase replaced at its boundary.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
let currentUser = null, calls = [], createError, loginError, callableError;
const modules = {
  './firebase': { getFirebaseAuth: () => ({ currentUser }), getFirebaseFunctions: () => ({}) },
  'firebase/database': {},
  'firebase/auth': {
    EmailAuthProvider: { credential: (email, password) => ({ email, password }) },
    reauthenticateWithCredential: async () => calls.push('reauth'),
    createUserWithEmailAndPassword: async () => { calls.push('create'); if (createError) throw createError; },
    signInWithEmailAndPassword: async () => { calls.push('sign-in'); if (loginError) throw loginError; },
  },
  'firebase/functions': { httpsCallable: (_functions, name) => async payload => {
    calls.push({ name, payload }); if (callableError) throw callableError;
    return { data: { ok: true, companyId: 'new-company', displayName: payload.displayName } };
  } },
};
const exportsObject = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/auth.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: exportsObject, require: id => {
  if (!(id in modules)) throw Error(`Unexpected dependency ${id}`); return modules[id];
}, console });
const run = () => exportsObject.registerOwnerWithEmail('owner@example.test', 'test-password', 'Hots Oiler LLC', 'Owner One');
(async () => {
  await run(); assert.equal(calls[0], 'create'); assert.equal(calls[1].name, 'createOwnerCompany');
  calls = []; currentUser = { email: 'owner@example.test' }; await run(); assert.equal(calls[0], 'reauth');
  calls = []; currentUser = null; createError = { code: 'auth/email-already-in-use' };
  await run(); assert.equal(calls[1], 'sign-in'); assert.equal(calls[2].name, 'createOwnerCompany');
  calls = []; loginError = Error('wrong password'); await assert.rejects(run, /wrong password/);
  assert.equal(calls.length, 2, 'wrong password must not reach company creation');
  calls = []; createError = Error('network'); loginError = undefined; await assert.rejects(run, /network/);
  assert.equal(calls.length, 1, 'network errors must not be treated as an existing account');
  calls = []; createError = undefined; callableError = Error('provisioning interrupted');
  await assert.rejects(run, /provisioning interrupted/); callableError = undefined;
  await run(); assert.equal(calls.filter(c => c?.name === 'createOwnerCompany').length, 2);
  calls = []; await assert.rejects(() => exportsObject.registerOwnerWithEmail('x', 'short', '', 'x'));
  assert.equal(calls.length, 0, 'invalid registration must not create an Auth user');
  console.log('Owner signup: new account, reauthentication, interrupted retry, password proof and validation passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
