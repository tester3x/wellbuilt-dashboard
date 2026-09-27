import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectDispatchDriverRoster } from '../dispatchRosterProjection.ts';
import { assignmentIdentityForDriver } from '../dispatchWriterIdentity.ts';
import { resolveDispatchDriver, dispatchMatchesDriver } from '../dispatchDriverIdentity.ts';

const CANON_UUID_1 = '4a2f8b50-3211-4820-b455-812e9b0e271a';
const CANON_UUID_2 = '8c3d9a10-9876-4321-a123-abcdef012345';
const LEGACY_HASH_1 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const LEGACY_HASH_2 = 'f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f';

test('1. Modern secure driver (profiles only) is projected and visible with canonical UUID', () => {
  const catalog = {
    approved: {},
    profiles: {
      [CANON_UUID_1]: {
        displayName: 'adan',
        legalName: 'Adan Driver',
        name: 'adan',
        active: true,
        companyId: 'liquid-gold',
        companyName: 'Liquid Gold',
        assignedRoutes: ['North', 'East'],
        phone: '555-123-4567',
      },
    },
  };

  const roster = projectDispatchDriverRoster(catalog, 'liquid-gold');
  assert.equal(roster.length, 1);
  const driver = roster[0];
  assert.equal(driver.key, CANON_UUID_1);
  assert.equal(driver.driverId, CANON_UUID_1);
  assert.equal(driver.displayName, 'adan');
  assert.equal(driver.legalName, 'Adan Driver');
  assert.equal(driver.companyId, 'liquid-gold');
  assert.deepEqual(driver.assignedRoutes, ['North', 'East']);
  assert.deepEqual(driver.legacyAliases, []);

  // Dispatch write contract stamps canonical UUID and real name
  const assignment = assignmentIdentityForDriver(driver);
  assert.equal(assignment.driverId, CANON_UUID_1);
  assert.equal(assignment.driverHash, CANON_UUID_1);
  assert.equal(assignment.driverName, 'Adan Driver');
});

test('2. Legacy approved driver (approved only, 64-hex hash) keeps legacy key and no canonical UUID', () => {
  const catalog = {
    approved: {
      [LEGACY_HASH_1]: {
        displayName: 'Old Timer',
        legalName: 'Old Timer Sr.',
        name: 'oldtimer',
        active: true,
        companyId: 'liquid-gold',
      },
    },
    profiles: {},
  };

  const roster = projectDispatchDriverRoster(catalog, 'liquid-gold');
  assert.equal(roster.length, 1);
  const driver = roster[0];
  assert.equal(driver.key, LEGACY_HASH_1);
  assert.equal(driver.driverId, undefined);
  assert.equal(driver.driverHash, LEGACY_HASH_1);
  assert.deepEqual(driver.legacyAliases, [LEGACY_HASH_1]);

  // Writer preserves legacy compat hash without fabricating a canonical UUID
  const assignment = assignmentIdentityForDriver(driver);
  assert.equal(assignment.driverId, undefined);
  assert.equal(assignment.driverHash, LEGACY_HASH_1);
  assert.equal(assignment.driverName, 'Old Timer Sr.');
});

test('3. Migrated driver links approved row and canonical profile into a single canonical entry', () => {
  const catalog = {
    approved: {
      [LEGACY_HASH_1]: {
        displayName: 'Mikezfold',
        legalName: 'Mike ZFold7 Burger',
        name: 'mikezfold',
        active: true,
        companyId: 'liquid-gold',
        migratedToDriverId: CANON_UUID_1,
      },
    },
    profiles: {
      [CANON_UUID_1]: {
        displayName: 'Mikezfold',
        legalName: 'Mike ZFold7 Burger',
        name: 'mikezfold',
        active: true,
        companyId: 'liquid-gold',
        assignedRoutes: ['South'],
        phone: '701-555-0199',
      },
    },
  };

  const roster = projectDispatchDriverRoster(catalog, 'liquid-gold');
  assert.equal(roster.length, 1); // unified into ONE driver, not two duplicates!
  const driver = roster[0];
  assert.equal(driver.driverId, CANON_UUID_1);
  assert.equal(driver.legalName, 'Mike ZFold7 Burger');
  assert.deepEqual(driver.legacyAliases, [LEGACY_HASH_1]);
  assert.deepEqual(driver.assignedRoutes, ['South']);

  // Resolves both canonical dispatches AND legacy hash dispatches
  const canonicalDispatch = { driverId: CANON_UUID_1, companyId: 'liquid-gold' };
  const legacyDispatch = { driverHash: LEGACY_HASH_1, companyId: 'liquid-gold' };
  assert.equal(dispatchMatchesDriver(canonicalDispatch, driver), true);
  assert.equal(dispatchMatchesDriver(legacyDispatch, driver), true);
  assert.equal(resolveDispatchDriver(canonicalDispatch, roster)?.driverId, CANON_UUID_1);
  assert.equal(resolveDispatchDriver(legacyDispatch, roster)?.driverId, CANON_UUID_1);
});

test('4. Cross-company tenant isolation strictly excludes other tenants', () => {
  const catalog = {
    approved: {
      [LEGACY_HASH_1]: {
        displayName: 'LG Driver',
        active: true,
        companyId: 'liquid-gold',
      },
      [LEGACY_HASH_2]: {
        displayName: 'Acme Driver',
        active: true,
        companyId: 'acme-hauling',
      },
    },
    profiles: {
      [CANON_UUID_1]: {
        displayName: 'LG Secure',
        active: true,
        companyId: 'liquid-gold',
      },
      [CANON_UUID_2]: {
        displayName: 'Acme Secure',
        active: true,
        companyId: 'acme-hauling',
      },
    },
  };

  const lgRoster = projectDispatchDriverRoster(catalog, 'liquid-gold');
  assert.equal(lgRoster.length, 2);
  assert.ok(lgRoster.every((d) => d.companyId === 'liquid-gold'));
  assert.ok(!lgRoster.some((d) => d.displayName.includes('Acme')));

  const acmeRoster = projectDispatchDriverRoster(catalog, 'acme-hauling');
  assert.equal(acmeRoster.length, 2);
  assert.ok(acmeRoster.every((d) => d.companyId === 'acme-hauling'));
  assert.ok(!acmeRoster.some((d) => d.displayName.includes('LG')));

  // Platform admin (unscoped) sees all 4 drivers
  const platRoster = projectDispatchDriverRoster(catalog, undefined);
  assert.equal(platRoster.length, 4);
});

test('5. Inactive drivers are excluded from dispatch roster', () => {
  const catalog = {
    approved: {
      [LEGACY_HASH_1]: {
        displayName: 'Inactive Approved',
        active: false,
        companyId: 'liquid-gold',
      },
    },
    profiles: {
      [CANON_UUID_1]: {
        displayName: 'Inactive Profile',
        active: false,
        companyId: 'liquid-gold',
      },
      [CANON_UUID_2]: {
        displayName: 'Active Driver',
        active: true,
        companyId: 'liquid-gold',
      },
    },
  };

  const roster = projectDispatchDriverRoster(catalog, 'liquid-gold');
  assert.equal(roster.length, 1);
  assert.equal(roster[0].displayName, 'Active Driver');
});

test('6. Alphabetical ordering by real display name', () => {
  const catalog = {
    profiles: {
      [CANON_UUID_1]: { displayName: 'Zach', active: true, companyId: 'liquid-gold' },
      [CANON_UUID_2]: { displayName: 'Aaron', active: true, companyId: 'liquid-gold' },
    },
    approved: {
      [LEGACY_HASH_1]: { displayName: 'Bob', active: true, companyId: 'liquid-gold' },
    },
  };

  const roster = projectDispatchDriverRoster(catalog, 'liquid-gold');
  assert.deepEqual(
    roster.map((d) => d.displayName),
    ['Aaron', 'Bob', 'Zach'],
  );
});
