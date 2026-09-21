/**
 * Wired RTDB rules matrix. Loads firebase.json -> database.rules.json.
 * Never database.rules.secure.json.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import { ref, set, update, remove } from 'firebase/database';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const firebaseJson = JSON.parse(readFileSync(join(root, 'firebase.json'), 'utf8'));
const wired = firebaseJson.database?.rules;
if (wired !== 'database.rules.json') {
  console.error(`wired rules file is ${wired}, expected database.rules.json`);
  process.exit(1);
}
const rules = readFileSync(join(root, wired), 'utf8');

const PROJECT_ID = 'demo-g010';
let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const testEnv = await initializeTestEnvironment({
  projectId: PROJECT_ID,
  database: { rules, host: '127.0.0.1', port: 9000 },
});

await testEnv.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.database();
  await set(ref(db, 'users/staff-1'), { role: 'dispatch', companyId: 'liquid-gold', email: 's@x' });
  await set(ref(db, 'users/emp-2'), { role: 'viewer', companyId: 'liquid-gold', email: 'e@x' });
  await set(ref(db, 'drivers/profiles/drv-1'), { companyId: 'liquid-gold', legalName: 'Pat', active: true });
  await set(ref(db, 'well_config/Python'), { ndicName: 'PYTHON 1', tanks: 1, route: 'North' });
  await set(ref(db, 'drivers/approved/hash1'), { displayName: 'Pat', companyId: 'liquid-gold' });
});

const unauth = testEnv.unauthenticatedContext();
const user = testEnv.authenticatedContext('staff-1');
const other = testEnv.authenticatedContext('emp-2');

async function denied(name, promise) {
  try {
    await assertFails(promise);
    check(name, true);
  } catch (err) {
    check(name, false, err?.message || String(err));
  }
}
async function allowed(name, promise) {
  try {
    await assertSucceeds(promise);
    check(name, true);
  } catch (err) {
    check(name, false, err?.message || String(err));
  }
}

await denied('unauthenticated users role write', set(ref(unauth.database(), 'users/staff-1/role'), 'it'));
await denied('unauthenticated root write', set(ref(unauth.database(), 'hack'), { x: 1 }));
await denied('auth users role write', set(ref(user.database(), 'users/staff-1/role'), 'it'));
await denied('auth users roles write', set(ref(user.database(), 'users/emp-2/roles'), ['it']));
await denied('auth users companyId write', set(ref(user.database(), 'users/staff-1/companyId'), 'other'));
await denied('auth users capabilities write', set(ref(user.database(), 'users/staff-1/capabilities'), ['manageDrivers']));
await denied('auth users isPlatformAdmin write', set(ref(user.database(), 'users/staff-1/isPlatformAdmin'), true));
await denied('auth users wellbuiltAdmin write', set(ref(user.database(), 'users/staff-1/wellbuiltAdmin'), true));
await denied('auth users roleCapabilities write', set(ref(user.database(), 'users/staff-1/roleCapabilities'), { manageDrivers: true }));
await denied('parent users replacement', set(ref(user.database(), 'users/staff-1'), { role: 'it', companyId: 'x' }));
await denied('create user with protected children', set(ref(user.database(), 'users/staff-1'), { email: 'n@x.com', role: 'it' }));
await denied('mixed email + role update', update(ref(user.database(), 'users/staff-1'), { email: 'n@x', role: 'it' }));
await allowed('parent email+displayName update', update(ref(user.database(), 'users/staff-1'), { email: 'n@x.com', displayName: 'Staff' }));
await denied('users parent delete', remove(ref(user.database(), 'users/staff-1')));
await denied('users role null delete', set(ref(user.database(), 'users/staff-1/role'), null));
await allowed('self email write', set(ref(user.database(), 'users/staff-1/email'), 'new@x.com'));
await allowed('self displayName write', set(ref(user.database(), 'users/staff-1/displayName'), 'Staff'));
await denied('other user email write', set(ref(user.database(), 'users/emp-2/email'), 'stolen@x.com'));
await denied('users role priority write', update(ref(user.database(), 'users/staff-1/role'), { '.priority': 1 }));

await denied('profiles create', set(ref(user.database(), 'drivers/profiles/forged'), { companyId: 'liquid-gold', legalName: 'Fake', active: true }));
await denied('profiles update', set(ref(user.database(), 'drivers/profiles/drv-1/companyId'), 'other'));
await denied('profiles delete', remove(ref(user.database(), 'drivers/profiles/drv-1')));
await denied('profiles parent write', set(ref(user.database(), 'drivers/profiles'), { x: { legalName: 'Z' } }));
await denied('drivers parent replacement', set(ref(user.database(), 'drivers'), { profiles: { y: { legalName: 'Y' } } }));

await denied('wellConfig create', set(ref(user.database(), 'wellConfig/Python'), { wellName: 'Python', ndicName: 'PYTHON 1' }));
await denied('wellConfig update', update(ref(user.database(), 'wellConfig/Python'), { ndicName: 'X' }));
await denied('wellConfig delete', remove(ref(user.database(), 'wellConfig/Python')));

await denied('well_config identity create', set(ref(user.database(), 'well_config/Forged'), { ndicName: 'FORGED 1' }));
await denied('well_config ndicName patch', set(ref(user.database(), 'well_config/Python/ndicName'), 'HACK'));
await denied('well_config wellName patch', set(ref(user.database(), 'well_config/Python/wellName'), 'HACK'));
await denied('well_config parent replace', set(ref(user.database(), 'well_config/Python'), { ndicName: 'PYTHON 1', tanks: 9 }));
await denied('well_config delete', remove(ref(user.database(), 'well_config/Python')));
await denied('well_config companyId patch', set(ref(user.database(), 'well_config/Python/companyId'), 'other'));
await denied('well_config aliases patch', set(ref(user.database(), 'well_config/Python/aliases'), ['HACK']));
await allowed('well_config routeRecording on existing well', set(ref(user.database(), 'well_config/Python/routeRecording'), true));
await allowed('well_config route on existing well', set(ref(user.database(), 'well_config/Python/route'), 'Unrouted'));
await allowed('well_config routeGroupWell on existing well', set(ref(user.database(), 'well_config/Python/routeGroupWell'), 'Python'));
await denied('well_config routeRecording on missing well', set(ref(user.database(), 'well_config/Missing/routeRecording'), true));
await denied('unauthenticated well_config route', set(ref(unauth.database(), 'well_config/Python/route'), 'Hack'));
await denied('root mixed permitted+forbidden well', update(ref(user.database()), {
  'well_config/Python/route': 'South',
  'well_config/Python/ndicName': 'HACK',
}));
await allowed('root multi-location permitted route children', update(ref(user.database()), {
  'well_config/Python/route': 'South',
}));

await denied('root multi-location users+profiles', update(ref(user.database()), {
  'users/staff-1/role': 'it',
  'drivers/profiles/drv-1/companyId': 'other',
}));
await denied('root multi-location well identity', update(ref(user.database()), {
  'well_config/Python/ndicName': 'HACK',
  'well_config/Forged': { ndicName: 'FORGED 1' },
}));
await denied('unknown top-level path', set(ref(other.database(), 'secret/x'), { a: 1 }));
await denied('trusted_staff_authority write', set(ref(user.database(), 'trusted_staff_authority/staff-1'), { companyId: 'liquid-gold' }));
await denied('malformed well_config object via client', set(ref(user.database(), 'well_config/Python'), 'nope'));

await allowed('packets/incoming pull create', set(ref(user.database(), 'packets/incoming/p1'), {
  wellName: 'Python',
  requestType: 'pull',
  bblsTaken: 140,
}));
await denied('packets/incoming with companyId', set(ref(user.database(), 'packets/incoming/p2'), {
  wellName: 'Python',
  requestType: 'pull',
  companyId: 'liquid-gold',
}));
await allowed('drivers/approved operational write', set(ref(user.database(), 'drivers/approved/hash1/active'), false));
await allowed('drivers/pending operational write', set(ref(user.database(), 'drivers/pending/p1'), { displayName: 'Pat', status: 'pending' }));
await denied('unauthenticated packets/incoming', set(ref(unauth.database(), 'packets/incoming/p0'), {
  wellName: 'Python',
  requestType: 'pull',
}));
await denied('packets/incoming delete', remove(ref(user.database(), 'packets/incoming/p1')));
await denied('packets/processed client write', set(ref(user.database(), 'packets/processed/x'), { wellName: 'Python' }));
await denied('performance client write', set(ref(user.database(), 'performance/Python'), { x: 1 }));

await testEnv.withSecurityRulesDisabled(async (ctx) => {
  try {
    await set(ref(ctx.database(), 'drivers/profiles/admin-write'), { legalName: 'Admin', companyId: 'liquid-gold', active: true });
    check('Admin SDK / rules-disabled can still write profiles', true);
  } catch (err) {
    check('Admin SDK / rules-disabled can still write profiles', false, err?.message || String(err));
  }
});

await testEnv.cleanup();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
