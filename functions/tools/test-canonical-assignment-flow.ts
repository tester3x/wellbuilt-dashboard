/**
 * Integrated assignment + DVIR identity sequence against the local emulators.
 *
 *   npx firebase emulators:exec --only firestore,database --project wellbuilt-sync \
 *     "npx tsx tools/test-canonical-assignment-flow.ts"
 *
 * Synthetic company and drivers only. Does not touch a live project.
 */
import admin from 'firebase-admin';

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
  console.error('Refusing to run without the Firestore and Realtime Database emulators.');
  process.exit(1);
}

const PROJECT = 'wellbuilt-sync';
const COMPANY = 'co-canon-asg';
const DRIVER = '11111111-1111-4111-8111-111111111111';
const NEXT = '22222222-2222-4222-8222-222222222222';
const INACTIVE = '33333333-3333-4333-8333-333333333333';
const FOREIGN = '44444444-4444-4444-8444-444444444444';

admin.initializeApp({
  projectId: PROJECT,
  databaseURL: 'https://wellbuilt-sync-default-rtdb.firebaseio.com',
});

const fs = admin.firestore();
const rtdb = admin.database();
let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}

async function seedDriver(driverId: string, companyId: string, active: boolean): Promise<void> {
  await fs.collection('driver_credentials').doc(driverId).set({ active });
  await rtdb.ref(`drivers/profiles/${driverId}`).set({
    active,
    companyId,
    displayName: 'Synthetic',
  });
}

async function seedEquipment(equipmentId: string, equipmentTypeId: string, unitNumber: string): Promise<void> {
  await fs.collection(`companies/${COMPANY}/equipment`).doc(equipmentId).set({
    equipmentId,
    companyId: COMPANY,
    equipmentTypeId,
    unitNumber,
    active: true,
    status: 'ready',
  });
}

const manager = {
  authUid: 'mgr-canon',
  authToken: { kind: 'staff' },
};

function driverAuth(driverId: string) {
  return {
    authUid: `uid-${driverId.slice(0, 8)}`,
    authToken: { kind: 'driver', driverId, companyId: COMPANY },
  };
}

function driverLookupAuth(driverId: string) {
  const auth = driverAuth(driverId);
  return { uid: auth.authUid, token: auth.authToken };
}

async function main(): Promise<void> {
  const { handleAssignmentRequest } = await import('../src/equipment/services/assignmentService.ts');
  const { lookupDvirAssetIdentity, productionIdentityLookupIo } = await import(
    '../src/equipment/services/dvirAssetIdentityLookup.ts'
  );
  await rtdb.ref('users/mgr-canon').set({ role: 'manager', companyId: COMPANY, displayName: 'Manager' });
  await seedDriver(DRIVER, COMPANY, true);
  await seedDriver(NEXT, COMPANY, true);
  await seedDriver(INACTIVE, COMPANY, false);
  await seedDriver(FOREIGN, 'co-other', true);
  await seedEquipment('eq-truck-1', 'truck', 'T-1');
  await seedEquipment('eq-truck-2', 'truck', 'T-2');
  await seedEquipment('eq-trailer-1', 'trailer', 'TR-1');
  await seedEquipment('eq-old', 'truck', 'OLD');
  await fs.collection(`companies/${COMPANY}/assignments`).doc('hash-only').set({
    assignmentId: 'hash-only',
    companyId: COMPANY,
    equipmentId: 'eq-old',
    driverHash: 'legacy-passcode-key',
    active: true,
    startedAt: '2026-01-01T00:00:00.000Z',
  });

  const hashRejected = await handleAssignmentRequest({
    action: 'assignment.start',
    payload: { companyId: COMPANY, equipmentId: 'eq-truck-1', driverHash: 'legacy-passcode-key' },
  }, manager).then(() => 'allowed').catch((err: { message?: string }) => err.message || 'denied');
  check('client hash is rejected', hashRejected.includes('alias') || hashRejected.includes('driverHash') || hashRejected.includes('invalid'));

  const inactive = await handleAssignmentRequest({
    action: 'assignment.start',
    payload: { companyId: COMPANY, equipmentId: 'eq-truck-1', driverId: INACTIVE, assignmentId: 'as-inactive' },
  }, manager).then(() => 'allowed').catch((err: { message?: string }) => err.message || 'denied');
  check('inactive driver denied', inactive === 'inactive', inactive);

  const cross = await handleAssignmentRequest({
    action: 'assignment.start',
    payload: { companyId: COMPANY, equipmentId: 'eq-truck-1', driverId: FOREIGN, assignmentId: 'as-foreign' },
  }, manager).then(() => 'allowed').catch((err: { message?: string }) => err.message || 'denied');
  check('cross-company driver denied', cross === 'cross_company', cross);

  const started = await handleAssignmentRequest({
    action: 'assignment.start',
    payload: { companyId: COMPANY, equipmentId: 'eq-truck-1', driverId: DRIVER, assignmentId: 'as-truck-1' },
  }, manager) as { assignment: Record<string, unknown>; events: Array<Record<string, unknown>> };
  check('start stores driverId', started.assignment.driverId === DRIVER);
  check('start does not store driverHash', !('driverHash' in started.assignment));
  check('start actor is dashboard uid', (started.assignment.assignedBy as { type?: string; uid?: string }).type === 'dashboard'
    && (started.assignment.assignedBy as { uid?: string }).uid === 'mgr-canon');
  check('start event uses driverId', started.events[0]?.driverId === DRIVER && !('driverHash' in started.events[0]));

  await handleAssignmentRequest({
    action: 'assignment.start',
    payload: { companyId: COMPANY, equipmentId: 'eq-truck-2', driverId: DRIVER, assignmentId: 'as-truck-2' },
  }, manager);
  await handleAssignmentRequest({
    action: 'assignment.start',
    payload: { companyId: COMPANY, equipmentId: 'eq-trailer-1', driverId: DRIVER, assignmentId: 'as-trailer-1' },
  }, manager);

  const own = await handleAssignmentRequest({
    action: 'assignment.listActiveForDriver',
    payload: { companyId: COMPANY },
  }, driverAuth(DRIVER)) as { assignments: Array<{ equipmentId: string; driverId: string }> };
  const ownIds = own.assignments.map((row) => row.equipmentId).sort();
  check('driver reads own truck and trailer', ownIds.join(',') === 'eq-trailer-1,eq-truck-1,eq-truck-2', ownIds.join(','));
  check('hash-only row is excluded', !ownIds.includes('eq-old'));

  const other = await handleAssignmentRequest({
    action: 'assignment.listActiveForDriver',
    payload: { companyId: COMPANY },
  }, driverAuth(NEXT)) as { assignments: unknown[] };
  check('other driver sees none of those assignments', other.assignments.length === 0);

  const before = (await fs.collection(`companies/${COMPANY}/assignments`).get()).size;
  const resolved = await lookupDvirAssetIdentity({
    auth: driverLookupAuth(DRIVER),
    payload: { requests: [{ role: 'truck' }, { role: 'trailer' }] },
    io: productionIdentityLookupIo(),
  });
  const after = (await fs.collection(`companies/${COMPANY}/assignments`).get()).size;
  check('identity lookup writes nothing', before === after);
  check('two trucks stay ambiguous', resolved.ok && resolved.roles[0].status === 'ambiguous', JSON.stringify(resolved));
  check('trailer resolves independently', resolved.ok
    && resolved.roles[1].status === 'resolved'
    && resolved.roles[1].status === 'resolved'
    && 'equipmentId' in resolved.roles[1]
    && resolved.roles[1].equipmentId === 'eq-trailer-1');
  check('lookup is not a Start Job pass', resolved.ok && resolved.startJobSatisfied === false);

  const transferred = await handleAssignmentRequest({
    action: 'assignment.transfer',
    payload: {
      companyId: COMPANY,
      equipmentId: 'eq-truck-1',
      driverId: NEXT,
      newAssignmentId: 'as-truck-1b',
    },
  }, manager) as { assignment: { driverId: string }; events: Array<Record<string, unknown>> };
  check('transfer event names canonical ids',
    transferred.assignment.driverId === NEXT
    && transferred.events.every((event) => !('driverHash' in event)));

  const driverAfter = await lookupDvirAssetIdentity({
    auth: driverLookupAuth(DRIVER),
    payload: { requests: [{ role: 'truck' }] },
    io: productionIdentityLookupIo(),
  });
  check('original driver still has the other truck',
    driverAfter.ok && driverAfter.roles[0].status === 'resolved'
    && 'equipmentId' in driverAfter.roles[0]
    && driverAfter.roles[0].equipmentId === 'eq-truck-2');

  const nextSees = await lookupDvirAssetIdentity({
    auth: driverLookupAuth(NEXT),
    payload: { requests: [{ role: 'truck' }] },
    io: productionIdentityLookupIo(),
  });
  check('receiving driver resolves the transferred truck',
    nextSees.ok && nextSees.roles[0].status === 'resolved'
    && 'equipmentId' in nextSees.roles[0]
    && nextSees.roles[0].equipmentId === 'eq-truck-1');

  await handleAssignmentRequest({
    action: 'assignment.end',
    payload: { companyId: COMPANY, assignmentId: 'as-truck-2' },
  }, manager);
  const ended = await lookupDvirAssetIdentity({
    auth: driverLookupAuth(DRIVER),
    payload: { requests: [{ role: 'truck' }] },
    io: productionIdentityLookupIo(),
  });
  check('ended truck is no longer resolved', ended.ok && ended.roles[0].status === 'unregistered');

  const hidden = await handleAssignmentRequest({
    action: 'assignment.getActiveForEquipment',
    payload: { companyId: COMPANY, equipmentId: 'eq-old' },
  }, manager) as { assignment: unknown };
  check('hash-only active row is not returned', hidden.assignment === null);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
