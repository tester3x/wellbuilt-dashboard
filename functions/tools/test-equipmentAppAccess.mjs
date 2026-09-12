import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { issueEquipmentAppAccess, exchangeEquipmentAppAccess } from '../lib/sso/equipmentAppAccess.js';
import { WELLBUILT_APP_EQUIPMENT } from '@tester3x/wellbuilt-contracts';
const sha = text => createHash('sha256').update(text).digest('hex');
const auth = { uid: 'uid-a', claims: { kind: 'driver', driverId: 'driver-a', companyId: 'company-a' } };
function world() {
  const docs = new Map(); let now = 1000, active = true, included = true, companyId = 'company-a';
  let serial = Promise.resolve();
  const minted = [];
  const deps = {
    nowMs: () => now, randomBytes, sha256Hex: sha, base64Url: bytes => Buffer.from(bytes).toString('base64url'),
    expiresAtTimestamp: ms => ({ ms }),
    getDriver: async () => ({ driverId: 'driver-a', companyId, displayName: 'Test', active }),
    getCompanyContract: async () => ({ state: 'active', contract: { planId: 'p', contractEnforced: true } }),
    getPlan: async () => ({ contractVersion: 1, planId: 'p', displayName: 'P', capabilities: [], status: 'active',
      apps: { [WELLBUILT_APP_EQUIPMENT]: { included, requiresActiveShift: true } } }),
    getShiftAuthority: async () => { throw new Error('General app access must not read/mutate shifts'); },
    getShiftDay: async () => { throw new Error('General app access must not read/mutate shifts'); },
    mintCustomToken: async (uid, claims) => { minted.push({ uid, claims }); return 'test-token'; },
    runTransaction: fn => {
      const run = serial.then(async () => {
        const writes = [];
        const result = await fn({ get: async path => ({ exists: docs.has(path), data: docs.get(path) }),
          create: (path, data) => writes.push(() => { assert(!docs.has(path)); docs.set(path, data); }),
          update: (path, data) => writes.push(() => { assert(docs.has(path)); docs.set(path, { ...docs.get(path), ...data }); }) });
        writes.forEach(write => write()); return result;
      }); serial = run.catch(() => {}); return run;
    },
  };
  return { deps, docs, minted, expire: () => { now += 60001; }, disable: () => { active = false; },
    exclude: () => { included = false; }, move: () => { companyId = 'company-b'; } };
}
const verifier = randomBytes(32).toString('base64url');
const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
const issue = w => issueEquipmentAppAccess(w.deps, auth, { version: 1, codeChallenge });
const exchange = (w, code, codeVerifier = verifier) => exchangeEquipmentAppAccess(w.deps, { version: 1, code, codeVerifier });
let checks = 0;
{
 const w = world(); const { code } = await issue(w);
 assert(!JSON.stringify([...w.docs.values()]).includes(code)); checks++;
 const results = await Promise.allSettled([exchange(w, code), exchange(w, code)]);
 assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); checks++;
 assert.deepEqual(w.minted, [{ uid: 'uid-a', claims: { kind: 'driver', driverId: 'driver-a', companyId: 'company-a', app: 'equipment' } }]); checks++;
 assert(!('shiftBinding' in results.find(r => r.status === 'fulfilled').value)); checks++;
}
for (const mutation of ['expire', 'disable', 'exclude', 'move']) {
 const w = world(); const { code } = await issue(w); w[mutation]();
 await assert.rejects(exchange(w, code)); assert.equal(w.minted.length, 0); checks++;
}
{
 const w = world(); const { code } = await issue(w);
 await assert.rejects(exchange(w, code, randomBytes(32).toString('base64url'))); checks++;
 await exchange(w, code); checks++;
 await assert.rejects(issueEquipmentAppAccess(w.deps, { uid: '', claims: {} }, { version: 1, codeChallenge })); checks++;
 await assert.rejects(issueEquipmentAppAccess(w.deps, auth, { version: 1, codeChallenge, driverId: 'other' })); checks++;
 await assert.rejects(exchangeEquipmentAppAccess(w.deps, { version: 1, code, codeVerifier: verifier, shiftId: 'fake' })); checks++;
}
console.log(`${checks} Equipment app-access checks passed`);
