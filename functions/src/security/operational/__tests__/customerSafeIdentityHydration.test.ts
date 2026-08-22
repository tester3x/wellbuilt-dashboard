/**
 * Customer-safe identity / hydration proofs.
 *
 * Synthetic identities only. Never production names, hashes, or passcodes.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { TEST_PASSCODE_RECORD } from '../approvedRowConversion';
import {
  decideBindIdentity,
  decideRetireLegacyLogin,
} from '../identityBinding';
import {
  applyHydrationCopy,
  previewCanonicalHydration,
  profileContainsForbiddenLegacyKey,
  projectDriverHydration,
} from '../canonicalProfileHydration';
import {
  decideTrustedHistoryKeys,
  recordMatchesTrustedHistory,
} from '../trustedHistoryAlias';
import {
  createMemoryUpgradeStore,
  runCustomerOwnedUpgrade,
  type UpgradeInput,
} from '../customerOwnedUpgrade';

const ALPHA_KEY = 'syn_alpha_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BRAVO_KEY = 'syn_bravo_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ALPHA_NAME = 'FixtureDriverAlpha';
const BRAVO_NAME = 'FixtureDriverBravo';
const OTHER_KEY = 'syn_other_cccccccccccccccccccccccccccccccccccccccccccc';

const CUSTOMERS = [{ companyId: 'fixture-co', name: 'FIXTURE OPERATOR LLC' }];

function alphaRow(): Record<string, unknown> {
  return {
    active: true,
    displayName: ALPHA_NAME,
    legalName: 'Alpha Legal',
    name: ALPHA_NAME,
    companyId: 'fixture-co',
    companyName: 'Fixture Company',
    assignedCustomers: CUSTOMERS,
    assignedRoutes: ['North Route', 'South Route'],
    truckNumber: 'T-100',
    trailerNumber: 'TR-9',
    profile: {
      signature: 'data:image/png;base64,AAAASYN',
      truckNumber: 'T-100',
      trailerNumber: 'TR-9',
      language: 'en',
      phone: '555-0100',
    },
    isAdmin: false,
    isViewer: false,
    approvedAt: 1,
  };
}

function bravoRow(): Record<string, unknown> {
  return {
    active: true,
    displayName: BRAVO_NAME,
    legalName: 'Bravo Legal',
    name: BRAVO_NAME,
    companyId: 'fixture-co',
    companyName: 'Fixture Company',
    assignedCustomers: [{ companyId: 'fixture-co', name: 'OTHER OPERATOR' }],
    assignedRoutes: ['East Route'],
    isAdmin: false,
    isViewer: false,
    approvedAt: 2,
  };
}

function baseInput(over: Partial<UpgradeInput> = {}): UpgradeInput {
  return {
    displayName: ALPHA_NAME,
    provenApprovedKey: ALPHA_KEY,
    passcodeRecord: TEST_PASSCODE_RECORD,
    callerUid: 'customer',
    opId: over.opId || 'op-1',
    ...over,
  };
}

describe('one-to-one uniqueness', () => {
  it('refuses binding the same approved key to a second UUID', () => {
    const d = decideBindIdentity({
      driverId: 'bbbbbbbb-cccc-4ddd-8eee-000000000001',
      approvedKey: ALPHA_KEY,
      existingByDriver: null,
      existingByApproved: {
        driverId: 'bbbbbbbb-cccc-4ddd-8eee-000000000002',
        approvedKey: ALPHA_KEY,
        status: 'active',
        opId: 'op-x',
      },
    });
    expect(d).toEqual({ action: 'refuse', reason: 'approved_key_already_bound' });
  });

  it('refuses binding a second approved key onto one UUID', () => {
    const d = decideBindIdentity({
      driverId: 'bbbbbbbb-cccc-4ddd-8eee-000000000001',
      approvedKey: BRAVO_KEY,
      existingByDriver: {
        driverId: 'bbbbbbbb-cccc-4ddd-8eee-000000000001',
        approvedKey: ALPHA_KEY,
        status: 'active',
        opId: 'op-x',
      },
      existingByApproved: null,
    });
    expect(d).toEqual({ action: 'refuse', reason: 'driver_already_bound' });
  });

  it('two synthetic identities stay strictly isolated', async () => {
    const store = createMemoryUpgradeStore();
    store.approved.set(ALPHA_KEY, alphaRow());
    store.approved.set(BRAVO_KEY, bravoRow());
    const a = await runCustomerOwnedUpgrade(store, baseInput({ opId: 'op-a' }));
    const b = await runCustomerOwnedUpgrade(store, baseInput({
      displayName: BRAVO_NAME,
      provenApprovedKey: BRAVO_KEY,
      opId: 'op-b',
    }));
    expect(a.status).toBe('ok');
    expect(b.status).toBe('ok');
    expect(a.driverId).not.toBe(b.driverId);
    expect(store.bindingsByApproved.get(ALPHA_KEY)?.driverId).toBe(a.driverId);
    expect(store.bindingsByApproved.get(BRAVO_KEY)?.driverId).toBe(b.driverId);
    expect(store.profiles.get(a.driverId!)!.assignedRoutes).toEqual(['North Route', 'South Route']);
    expect(store.profiles.get(b.driverId!)!.assignedRoutes).toEqual(['East Route']);
    expect(store.profiles.get(a.driverId!)!.legalName).toBe('Alpha Legal');
    expect(store.profiles.get(b.driverId!)!.legalName).toBe('Bravo Legal');
  });
});

describe('alias spoof rejection', () => {
  it('refuses client-supplied approvedKey / legacyHash / historyKeys', () => {
    const binding = {
      driverId: 'bbbbbbbb-cccc-4ddd-8eee-000000000001',
      approvedKey: ALPHA_KEY,
      status: 'active' as const,
      opId: 'op-1',
    };
    for (const requestData of [
      { approvedKey: OTHER_KEY },
      { legacyHash: OTHER_KEY },
      { historyKeys: [OTHER_KEY] },
      { aliases: [OTHER_KEY] },
      { trustedHistoryDriverIds: [OTHER_KEY] },
    ]) {
      expect(decideTrustedHistoryKeys({
        authenticatedDriverId: binding.driverId,
        binding,
        requestData,
      })).toEqual({ action: 'refuse', reason: 'alias_spoof' });
    }
  });

  it('server-resolved keys are UUID plus bound key only', () => {
    const driverId = 'bbbbbbbb-cccc-4ddd-8eee-000000000001';
    const decided = decideTrustedHistoryKeys({
      authenticatedDriverId: driverId,
      binding: {
        driverId,
        approvedKey: ALPHA_KEY,
        status: 'legacy_login_retired',
        opId: 'op-1',
      },
      requestData: {},
    });
    expect(decided).toEqual({ action: 'ok', keys: [driverId, ALPHA_KEY] });
    expect(recordMatchesTrustedHistory(ALPHA_KEY, decided.action === 'ok' ? decided.keys : [])).toBe(true);
    expect(recordMatchesTrustedHistory(OTHER_KEY, decided.action === 'ok' ? decided.keys : [])).toBe(false);
  });
});

describe('field preservation and canonical conflicts', () => {
  it('copies name, company, customers, routes, truck, trailer, signature', async () => {
    const store = createMemoryUpgradeStore();
    store.approved.set(ALPHA_KEY, alphaRow());
    const r = await runCustomerOwnedUpgrade(store, baseInput());
    expect(r.status).toBe('ok');
    const p = store.profiles.get(r.driverId!)!;
    expect(p.displayName).toBe(ALPHA_NAME);
    expect(p.legalName).toBe('Alpha Legal');
    expect(p.companyId).toBe('fixture-co');
    expect(p.assignedCustomers).toEqual(CUSTOMERS);
    expect(p.assignedRoutes).toEqual(['North Route', 'South Route']);
    expect(p.truckNumber).toBe('T-100');
    expect(p.trailerNumber).toBe('TR-9');
    expect(p.signature).toBe('data:image/png;base64,AAAASYN');
    expect((p.profile as Record<string, unknown>).signature).toBe('data:image/png;base64,AAAASYN');
    expect(profileContainsForbiddenLegacyKey(p)).toBe(false);
  });

  it('does not overwrite a newer canonical value; preview reports the conflict', () => {
    const canonical = {
      displayName: ALPHA_NAME,
      assignedRoutes: ['Canonical Only'],
      assignmentRevision: 1,
      companyId: 'fixture-co',
    };
    const preview = previewCanonicalHydration(canonical, alphaRow());
    expect(preview.conflicts.some((c) => c.field === 'assignedRoutes' && c.keep === 'canonical')).toBe(true);
    expect(preview.copy.assignedRoutes).toBeUndefined();
    expect(preview.copy.signature).toBe('data:image/png;base64,AAAASYN');
    const applied = applyHydrationCopy(canonical, preview);
    expect(applied.assignedRoutes).toEqual(['Canonical Only']);
    expect(applied.assignmentRevision).toBe(1);
    expect(applied.signature).toBe('data:image/png;base64,AAAASYN');
  });
});

describe('WB-T profile hydration projector', () => {
  it('projects canonical profile fields and never treats UUID as approved/{hash}', () => {
    const driverId = 'bbbbbbbb-cccc-4ddd-8eee-000000000001';
    const snap = projectDriverHydration({
      driverId,
      profile: {
        displayName: ALPHA_NAME,
        assignedCustomers: CUSTOMERS,
        truckNumber: 'T-100',
        profile: { signature: 'sig', trailerNumber: 'TR-9' },
      },
      trustedHistoryDriverIds: [driverId, ALPHA_KEY],
    });
    expect(snap.driverId).toBe(driverId);
    expect(snap.assignedCustomers).toEqual(CUSTOMERS);
    expect(snap.truckNumber).toBe('T-100');
    expect(snap.trailerNumber).toBe('TR-9');
    expect(snap.signature).toBe('sig');
    expect(snap.trustedHistoryDriverIds).toEqual([driverId, ALPHA_KEY]);
    expect(JSON.stringify(snap)).not.toMatch(/approvedKey/);
    const hydrationSrc = readFileSync(join(__dirname, '../../getOwnDriverHydration.ts'), 'utf8');
    expect(hydrationSrc).toMatch(/drivers\/profiles\/\$\{driver\.driverId\}/);
    expect(hydrationSrc).not.toMatch(/drivers\/approved\/\$\{driver/);
  });
});

describe('WB-T historical-ticket union and WB-M historical-pull union', () => {
  it('unions UUID-keyed and bound-hash-keyed records; rejects a foreign key', () => {
    const driverId = 'bbbbbbbb-cccc-4ddd-8eee-000000000001';
    const keys = decideTrustedHistoryKeys({
      authenticatedDriverId: driverId,
      binding: {
        driverId, approvedKey: ALPHA_KEY, status: 'active', opId: 'op-1',
      },
    });
    expect(keys.action).toBe('ok');
    const trusted = keys.action === 'ok' ? keys.keys : [];
    expect(recordMatchesTrustedHistory(driverId, trusted)).toBe(true);
    expect(recordMatchesTrustedHistory(ALPHA_KEY, trusted)).toBe(true);
    expect(recordMatchesTrustedHistory(BRAVO_KEY, trusted)).toBe(false);
  });
});

describe('customer-owned password setup', () => {
  it('stores only the scrypt record; never the plaintext; admin is not the caller', async () => {
    const store = createMemoryUpgradeStore();
    store.approved.set(ALPHA_KEY, alphaRow());
    const r = await runCustomerOwnedUpgrade(store, baseInput({ callerUid: 'customer' }));
    expect(r.status).toBe('ok');
    const cred = store.credentials.get(r.driverId!)!;
    expect(cred.setBy).toBe('customer');
    expect(cred.passcode).toEqual(TEST_PASSCODE_RECORD);
    expect(JSON.stringify(cred)).not.toMatch(/new-password|currentPasscode/i);
    expect(store.profiles.get(r.driverId!)!).not.toHaveProperty('approvedKey');
    const upgradeSrc = readFileSync(join(__dirname, '../../upgradeOwnLegacyDriverLogin.ts'), 'utf8');
    expect(upgradeSrc).toMatch(/hashPasscodeScrypt\(fields\.passcode\)/);
    expect(upgradeSrc).not.toMatch(/detail:[\s\S]{0,200}passcodeRecord/);
    expect(upgradeSrc).not.toMatch(/detail:[\s\S]{0,200}currentPasscode/);
    expect(upgradeSrc).not.toMatch(/detail:[\s\S]{0,200}newPasscode/);
  });
});

describe('idempotent resume', () => {
  it('retries reuse the same UUID and succeed without minting a second identity', async () => {
    const store = createMemoryUpgradeStore();
    store.approved.set(ALPHA_KEY, alphaRow());
    const first = await runCustomerOwnedUpgrade(store, baseInput({ opId: 'op-1' }));
    expect(first.status).toBe('ok');
    const second = await runCustomerOwnedUpgrade(store, baseInput({ opId: 'op-2' }));
    expect(second.status).toBe('ok');
    expect(second.reason).toBe('already_completed');
    expect(second.driverId).toBe(first.driverId);
    expect(store.credentials.size).toBe(1);
    expect(store.bindingsByApproved.size).toBe(1);
  });
});

describe('failed migration rollback', () => {
  it('rolls back identity and profile when failure is before binding', async () => {
    const store = createMemoryUpgradeStore();
    store.approved.set(ALPHA_KEY, alphaRow());
    const r = await runCustomerOwnedUpgrade(store, baseInput({ failAfter: 'profile', opId: 'op-fail' }));
    expect(r.status).toBe('rolled_back');
    expect(store.credentials.size).toBe(0);
    expect(store.index.size).toBe(0);
    expect(store.profiles.size).toBe(0);
    expect(store.bindingsByDriver.size).toBe(0);
    expect(store.bindingsByApproved.size).toBe(0);
  });

  it('does not roll back after the binding is committed', async () => {
    const store = createMemoryUpgradeStore();
    store.approved.set(ALPHA_KEY, alphaRow());
    const r = await runCustomerOwnedUpgrade(store, baseInput({ failAfter: 'binding', opId: 'op-bound' }));
    expect(r.status).toBe('bound_resumable');
    expect(store.bindingsByDriver.size).toBe(1);
    expect(store.credentials.size).toBe(1);
  });
});

describe('separate legacy retirement', () => {
  it('refuses retirement until secure login and hydration are proven', () => {
    expect(decideRetireLegacyLogin({
      binding: null,
      secureLoginProven: true,
      hydrationProven: true,
    }).action).toBe('refuse');
    expect(decideRetireLegacyLogin({
      binding: {
        driverId: 'bbbbbbbb-cccc-4ddd-8eee-000000000001',
        approvedKey: ALPHA_KEY,
        status: 'active',
        opId: 'op-1',
      },
      secureLoginProven: false,
      hydrationProven: true,
    })).toEqual({ action: 'refuse', reason: 'secure_login_unproven' });
  });

  it('retirement does not remove the history binding', async () => {
    const store = createMemoryUpgradeStore();
    store.approved.set(ALPHA_KEY, alphaRow());
    const r = await runCustomerOwnedUpgrade(store, baseInput());
    expect(r.status).toBe('ok');
    const binding = store.bindingsByDriver.get(r.driverId!)!;
    expect(decideRetireLegacyLogin({
      binding,
      secureLoginProven: true,
      hydrationProven: true,
    }).action).toBe('retire');
    expect(recordMatchesTrustedHistory(
      ALPHA_KEY,
      [r.driverId!, ALPHA_KEY],
    )).toBe(true);
    expect(store.approved.get(ALPHA_KEY)).toBeTruthy();
  });
});

describe('callable supersession source', () => {
  it('staffConvertApprovedDriverSecureLogin is superseded and is not called by the upgrade path', () => {
    const convert = readFileSync(join(__dirname, '../../staffConvertApprovedDriverSecureLogin.ts'), 'utf8');
    const upgrade = readFileSync(join(__dirname, '../../upgradeOwnLegacyDriverLogin.ts'), 'utf8');
    expect(convert).toContain('superseded_by_customer_owned_upgrade');
    expect(upgrade).not.toContain('staffConvertApprovedDriverSecureLogin');
    expect(upgrade).not.toContain('runApprovedRowConversion');
  });
});
