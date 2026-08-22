/**
 * Customer-safe identity / hydration proofs.
 *
 * Synthetic identities only. Never production names, hashes, or passcodes.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { TEST_PASSCODE_RECORD } from '../approvedRowConversion';
import {
  classifyApprovedRowForRetirement,
  decideBindIdentity,
  decideBindingTerminalProof,
  decideRetireLegacyLogin,
  evaluateApprovedRetirementStamp,
  evaluateRetirementApplyGate,
  evaluateRetirementPreview,
  legacyLoginIsRetired,
  retirementTerminalAllowsApprovedStamp,
} from '../identityBinding';
import {
  applyHydrationCopy,
  previewCanonicalHydration,
  profileContainsForbiddenLegacyKey,
  projectDriverHydration,
  hydrationContextDigest,
} from '../canonicalProfileHydration';
import { evaluateBindingTreeWrite } from '../bindingApplyTransaction';
import { evaluateHydrationTransaction } from '../hydrationApplyTransaction';
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
      opId: 'op-new',
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
      opId: 'op-new',
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
    const preview = previewCanonicalHydration(canonical, alphaRow(), {
      driverId: 'bbbbbbbb-cccc-4ddd-8eee-000000000001',
      approvedKey: ALPHA_KEY,
    });
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
  const complete = {
    driverId: 'bbbbbbbb-cccc-4ddd-8eee-000000000001',
    approvedKey: ALPHA_KEY,
    status: 'active' as const,
    opId: 'op-1',
  };
  const proven = {
    secureLoginAt: 1,
    secureLoginDriverId: complete.driverId,
    secureLoginUid: 'uid-1',
    hydrationAt: 2,
    hydrationDriverId: complete.driverId,
  };

  it('refuses retirement until secure login and hydration are proven', () => {
    expect(decideRetireLegacyLogin({
      requestedDriverId: complete.driverId,
      byDriver: null,
      byApproved: null,
      proof: proven,
    }).action).toBe('refuse');
    expect(decideRetireLegacyLogin({
      requestedDriverId: complete.driverId,
      byDriver: complete,
      byApproved: complete,
      proof: { ...proven, secureLoginAt: null, secureLoginDriverId: null },
    })).toEqual({ action: 'refuse', reason: 'secure_login_unproven' });
  });

  it('retirement does not remove the history binding', async () => {
    const store = createMemoryUpgradeStore();
    store.approved.set(ALPHA_KEY, alphaRow());
    const r = await runCustomerOwnedUpgrade(store, baseInput());
    expect(r.status).toBe('ok');
    const binding = store.bindingsByDriver.get(r.driverId!)!;
    expect(decideRetireLegacyLogin({
      requestedDriverId: r.driverId!,
      byDriver: binding,
      byApproved: binding,
      proof: {
        secureLoginAt: 1,
        secureLoginDriverId: r.driverId,
        secureLoginUid: 'uid',
        hydrationAt: 2,
        hydrationDriverId: r.driverId,
      },
      approvedRow: store.approved.get(ALPHA_KEY),
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

describe('atomic bidirectional binding', () => {
  const driverA = 'bbbbbbbb-cccc-4ddd-8eee-000000000001';
  const driverB = 'bbbbbbbb-cccc-4ddd-8eee-000000000002';

  it('one-sided state is incomplete, not already_exact', () => {
    const d = decideBindIdentity({
      driverId: driverA,
      approvedKey: ALPHA_KEY,
      opId: 'op-1',
      existingByDriver: { driverId: driverA, approvedKey: ALPHA_KEY, status: 'active', opId: 'op-1' },
      existingByApproved: null,
    });
    expect(d.action).toBe('repair');
    expect(decideBindingTerminalProof({
      driverId: driverA,
      approvedKey: ALPHA_KEY,
      byDriver: { driverId: driverA, approvedKey: ALPHA_KEY, status: 'active', opId: 'op-1' },
      byApproved: null,
    }).ok).toBe(false);
  });

  it('terminal proof requires both records to agree on UUID, key, status, and opId', () => {
    const a = { driverId: driverA, approvedKey: ALPHA_KEY, status: 'active' as const, opId: 'op-1' };
    expect(decideBindingTerminalProof({
      driverId: driverA, approvedKey: ALPHA_KEY, byDriver: a, byApproved: a,
    }).ok).toBe(true);
    expect(decideBindingTerminalProof({
      driverId: driverA,
      approvedKey: ALPHA_KEY,
      byDriver: a,
      byApproved: { ...a, opId: 'op-other' },
    }).ok).toBe(false);
  });

  it('repairs a partial write on retry', async () => {
    const store = createMemoryUpgradeStore();
    store.approved.set(ALPHA_KEY, alphaRow());
    const partial = await runCustomerOwnedUpgrade(store, baseInput({
      failAfter: 'after_binding_byDriver',
      opId: 'op-partial',
    }));
    expect(partial.status).toBe('bound_resumable');
    expect(store.bindingsByDriver.size).toBe(1);
    expect(store.bindingsByApproved.size).toBe(0);
    const resume = await runCustomerOwnedUpgrade(store, baseInput({ opId: 'op-resume' }));
    expect(resume.status).toBe('ok');
    expect(store.bindingsByDriver.size).toBe(1);
    expect(store.bindingsByApproved.size).toBe(1);
    expect(store.bindingsByDriver.get(resume.driverId!)!.approvedKey).toBe(ALPHA_KEY);
    expect(store.bindingsByApproved.get(ALPHA_KEY)!.driverId).toBe(resume.driverId);
  });

  it('competing operations cannot cross-bind', () => {
    const tree = {
      byDriver: { [driverA]: { driverId: driverA, approvedKey: ALPHA_KEY, status: 'active', opId: 'op-a' } },
      byApproved: { [ALPHA_KEY]: { driverId: driverA, approvedKey: ALPHA_KEY, status: 'active', opId: 'op-a' } },
    };
    const second = evaluateBindingTreeWrite({
      tree,
      driverId: driverB,
      approvedKey: ALPHA_KEY,
      status: 'active',
      opId: 'op-b',
    });
    expect(second.decision.action).toBe('refuse');
    if (second.decision.action === 'refuse') {
      expect(second.decision.reason).toBe('approved_key_already_bound');
    }
    expect(second.nextTree).toBeUndefined();
  });
});

describe('authorization array presence', () => {
  it('explicit [] is authoritative and is not replaced from legacy', () => {
    const canonical = {
      displayName: ALPHA_NAME,
      assignedRoutes: [] as string[],
      assignedWells: [] as string[],
      assignedCustomers: [] as unknown[],
      roles: [] as string[],
    };
    const preview = previewCanonicalHydration(canonical, alphaRow(), {
      driverId: 'bbbbbbbb-cccc-4ddd-8eee-000000000001',
      approvedKey: ALPHA_KEY,
    });
    expect(preview.copy.assignedRoutes).toBeUndefined();
    expect(preview.copy.assignedWells).toBeUndefined();
    expect(preview.copy.assignedCustomers).toBeUndefined();
    expect(preview.copy.roles).toBeUndefined();
    expect(preview.conflicts.some((c) => c.field === 'assignedRoutes' && c.keep === 'canonical')).toBe(true);
    const applied = applyHydrationCopy(canonical, preview);
    expect(applied.assignedRoutes).toEqual([]);
  });
});

describe('hydration concurrency', () => {
  it('a concurrent assignment change produces stale_preview and no write', () => {
    const driverId = 'bbbbbbbb-cccc-4ddd-8eee-000000000001';
    const currentAtPreview = { displayName: ALPHA_NAME, assignedRoutes: ['North Route'], assignmentRevision: 1 };
    const preview = previewCanonicalHydration(currentAtPreview, alphaRow(), { driverId, approvedKey: ALPHA_KEY });
    const afterAssignment = { ...currentAtPreview, assignedRoutes: ['West Route'], assignmentRevision: 2 };
    const gate = evaluateHydrationTransaction({
      current: afterAssignment,
      driverId,
      approvedKey: ALPHA_KEY,
      expectedDigest: preview.digest,
      legacyRow: alphaRow(),
      copy: preview.copy,
      preview,
      opId: 'op-1',
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toBe('stale_preview');
  });

  it('digest is bound to driverId, approvedKey, canonical, legacy, and copy', () => {
    const driverId = 'bbbbbbbb-cccc-4ddd-8eee-000000000001';
    const canonical = { displayName: ALPHA_NAME };
    const a = hydrationContextDigest({
      driverId, approvedKey: ALPHA_KEY, canonical, legacyRow: alphaRow(), copy: { signature: 'x' },
    });
    const b = hydrationContextDigest({
      driverId, approvedKey: BRAVO_KEY, canonical, legacyRow: alphaRow(), copy: { signature: 'x' },
    });
    expect(a).not.toBe(b);
  });
});

describe('legacy login retirement enforcement', () => {
  it('retired binding or approved flag blocks the legacy path', () => {
    expect(legacyLoginIsRetired({
      approvedKey: ALPHA_KEY,
      approvedRow: { legacyLoginRetired: true },
      byApproved: null,
    })).toBe(true);
    expect(legacyLoginIsRetired({
      approvedKey: ALPHA_KEY,
      approvedRow: { active: true },
      byApproved: { driverId: 'bbbbbbbb-cccc-4ddd-8eee-000000000001', approvedKey: ALPHA_KEY, status: 'legacy_login_retired', opId: 'op-1' },
    })).toBe(true);
    expect(legacyLoginIsRetired({
      approvedKey: ALPHA_KEY,
      approvedRow: { active: true },
      byApproved: { driverId: 'bbbbbbbb-cccc-4ddd-8eee-000000000001', approvedKey: ALPHA_KEY, status: 'active', opId: 'op-1' },
    })).toBe(false);
  });
});

describe('history alias model is session-fenced client filter, not extra reads', () => {
  it('server-issued aliases never include a foreign key and reject client supply', () => {
    const driverId = 'bbbbbbbb-cccc-4ddd-8eee-000000000001';
    const ok = decideTrustedHistoryKeys({
      authenticatedDriverId: driverId,
      binding: { driverId, approvedKey: ALPHA_KEY, status: 'active', opId: 'op-1' },
    });
    expect(ok).toEqual({ action: 'ok', keys: [driverId, ALPHA_KEY] });
    expect(decideTrustedHistoryKeys({
      authenticatedDriverId: driverId,
      binding: { driverId, approvedKey: ALPHA_KEY, status: 'active', opId: 'op-1' },
      requestData: { approvedKey: BRAVO_KEY },
    }).action).toBe('refuse');
  });
});

describe('source contracts', () => {
  it('upgradeOwnLegacyDriverLogin uses the authenticateDriver App Check policy', () => {
    const upgrade = readFileSync(join(__dirname, '../../upgradeOwnLegacyDriverLogin.ts'), 'utf8');
    const auth = readFileSync(join(__dirname, '../../driverAuthCallables.ts'), 'utf8');
    expect(upgrade).toMatch(/SECURITY_ENFORCE_APPCHECK/);
    expect(upgrade).toMatch(/assertAppCheck/);
    expect(auth).toMatch(/SECURITY_ENFORCE_APPCHECK/);
  });

  it('DriversTab no longer full-set migrates approved rows', () => {
    const tab = readFileSync(join(__dirname, '../../../../../src/components/admin/DriversTab.tsx'), 'utf8');
    expect(tab).not.toMatch(/set\(ref\(db, `drivers\/approved\/\$\{driver\.key\}`\)/);
    expect(tab).toMatch(/Legacy row rewrite is disabled/);
  });

  it('customer upgrade commits hydration through the transaction, not writeProfile/set', () => {
    const src = readFileSync(join(__dirname, '../customerOwnedUpgrade.ts'), 'utf8');
    const run = src.slice(src.indexOf('export async function runCustomerOwnedUpgrade'));
    expect(run).toMatch(/commitProfileHydration/);
    expect(run).not.toMatch(/await store\.writeProfile\(/);
    expect(run).toMatch(/expectedPreviewDigest \|\| preview\.digest/);
  });

  it('upgradeOwnLegacyDriverLogin refuses retired login from either flag or binding', () => {
    const src = readFileSync(join(__dirname, '../../upgradeOwnLegacyDriverLogin.ts'), 'utf8');
    expect(src).toMatch(/legacyLoginRetired === true/);
    expect(src).toMatch(/BINDING_BY_APPROVED/);
    expect(src).toMatch(/status === 'legacy_login_retired'/);
  });

  it('staffRetire requires the approved row, stamps through an aborting transaction, and rereads', () => {
    const retire = readFileSync(join(__dirname, '../../staffRetireLegacyDriverLogin.ts'), 'utf8');
    const stamp = readFileSync(join(__dirname, '../retirementApplyTransaction.ts'), 'utf8');
    expect(retire).toMatch(/approvedRow/);
    expect(retire).toMatch(/evaluateRetirementApplyGate/);
    expect(retire).toMatch(/commitApprovedRetirementStamp/);
    expect(retire).toMatch(/legacyLoginRetired !== true/);
    expect(retire).not.toMatch(/\.update\(/);
    expect(retire.indexOf('retirementTerminalAllowsApprovedStamp')).toBeLessThan(
      retire.indexOf('commitApprovedRetirementStamp'),
    );
    expect(retire.indexOf('commitApprovedRetirementStamp')).toBeLessThan(
      retire.indexOf('legacyLoginRetired !== true'),
    );
    expect(stamp).toMatch(/evaluateApprovedRetirementStamp/);
    expect(stamp).toMatch(/approvedRef\.on\('value', listener/);
    expect(stamp).toMatch(/approvedRef\.off\('value', listener\)/);
    expect(stamp).not.toMatch(/\.update\(/);
  });
});

describe('customer upgrade never adopts a name-index incumbent', () => {
  it('two unrelated people sharing a normalized name: legacy proof does not touch the incumbent', async () => {
    const store = createMemoryUpgradeStore();
    const incumbentId = 'bbbbbbbb-cccc-4ddd-8eee-000000000099';
    store.index.set('fixturedriveralpha', { driverId: incumbentId });
    store.credentials.set(incumbentId, {
      displayNameNorm: 'fixturedriveralpha',
      displayName: ALPHA_NAME,
      passcode: TEST_PASSCODE_RECORD,
      active: true,
      opId: 'op-incumbent',
      setBy: 'other',
    });
    store.profiles.set(incumbentId, { displayName: ALPHA_NAME, companyId: 'other-co' });
    store.approved.set(ALPHA_KEY, alphaRow());

    const r = await runCustomerOwnedUpgrade(store, baseInput({ opId: 'op-legacy' }));
    expect(r.status).toBe('refused');
    expect(r.reason).toBe('name_taken');
    expect(r.driverId).toBeNull();
    expect(store.credentials.get(incumbentId)?.opId).toBe('op-incumbent');
    expect(store.profiles.get(incumbentId)).toEqual({ displayName: ALPHA_NAME, companyId: 'other-co' });
    expect(store.index.get('fixturedriveralpha')?.driverId).toBe(incumbentId);
    expect(store.bindingsByDriver.size).toBe(0);
    expect(store.bindingsByApproved.size).toBe(0);
    expect(store.profiles.size).toBe(1);
  });
});

describe('customer hydration compare-and-commit race', () => {
  it('assignment change between read and transaction is stale_preview with no overwrite', async () => {
    const store = createMemoryUpgradeStore();
    store.approved.set(ALPHA_KEY, alphaRow());
    const orig = store.commitProfileHydration.bind(store);
    store.commitProfileHydration = async (input) => {
      const current = store.profiles.get(input.driverId);
      if (current) {
        store.profiles.set(input.driverId, {
          ...current,
          assignedRoutes: ['Hijacked'],
          assignmentRevision: 99,
        });
      } else {
        store.profiles.set(input.driverId, {
          displayName: ALPHA_NAME,
          assignedRoutes: ['Hijacked'],
          assignmentRevision: 99,
        });
      }
      return orig(input);
    };
    const r = await runCustomerOwnedUpgrade(store, baseInput({ opId: 'op-race' }));
    expect(r.status).toBe('refused');
    expect(r.reason).toBe('stale_preview');
    const written = [...store.profiles.values()];
    const routes = written.map((p) => p.assignedRoutes);
    expect(routes).toEqual([['Hijacked']]);
  });
});

describe('retry after lost upgrade response', () => {
  it('second call with the same new password reuses the UUID and binding', async () => {
    const store = createMemoryUpgradeStore();
    store.approved.set(ALPHA_KEY, alphaRow());
    const first = await runCustomerOwnedUpgrade(store, baseInput({ opId: 'op-1' }));
    expect(first.status).toBe('ok');
    const second = await runCustomerOwnedUpgrade(store, baseInput({ opId: 'op-lost-retry' }));
    expect(second.status).toBe('ok');
    expect(second.driverId).toBe(first.driverId);
    expect(store.credentials.size).toBe(1);
    expect(store.bindingsByApproved.size).toBe(1);
    expect(store.bindingsByDriver.size).toBe(1);
  });
});

describe('one-sided retirement applies requested status', () => {
  it('repair copies established pair/opId and the requested retired status', () => {
    const driverId = 'bbbbbbbb-cccc-4ddd-8eee-000000000001';
    const d = decideBindIdentity({
      driverId,
      approvedKey: ALPHA_KEY,
      status: 'legacy_login_retired',
      opId: 'op-new',
      existingByDriver: {
        driverId, approvedKey: ALPHA_KEY, status: 'active', opId: 'op-orig',
      },
      existingByApproved: null,
    });
    expect(d.action).toBe('repair');
    if (d.action === 'repair') {
      expect(d.payload).toEqual({
        driverId,
        approvedKey: ALPHA_KEY,
        status: 'legacy_login_retired',
        opId: 'op-orig',
      });
    }
  });
});

describe('retirement proofs gate repair in both partial directions', () => {
  const driverId = 'bbbbbbbb-cccc-4ddd-8eee-000000000001';
  const surviving = {
    driverId,
    approvedKey: ALPHA_KEY,
    status: 'active' as const,
    opId: 'op-orig',
  };
  const proven = {
    secureLoginAt: 1,
    secureLoginDriverId: driverId,
    secureLoginUid: 'uid-1',
    hydrationAt: 2,
    hydrationDriverId: driverId,
  };

  it('byDriver-only incomplete binding without login proof is refuse, not repair', () => {
    const d = decideRetireLegacyLogin({
      requestedDriverId: driverId,
      byDriver: surviving,
      byApproved: null,
      proof: { ...proven, secureLoginAt: null, secureLoginDriverId: null },
    });
    expect(d).toEqual({ action: 'refuse', reason: 'secure_login_unproven' });
  });

  it('byApproved-only incomplete binding without hydration proof is refuse, not repair', () => {
    const d = decideRetireLegacyLogin({
      requestedDriverId: driverId,
      byDriver: null,
      byApproved: surviving,
      byApprovedOwnedByDriver: [surviving],
      proof: { ...proven, hydrationAt: null, hydrationDriverId: null },
    });
    expect(d).toEqual({ action: 'refuse', reason: 'hydration_unproven' });
  });

  it('byDriver-only with both proofs is exact repair', () => {
    const d = decideRetireLegacyLogin({
      requestedDriverId: driverId,
      byDriver: surviving,
      byApproved: null,
      proof: proven,
      approvedRow: alphaRow(),
    });
    expect(d.action).toBe('repair');
    if (d.action === 'repair') {
      expect(d.surviving).toEqual(surviving);
      expect(d.complete).toBe(false);
    }
  });

  it('byApproved-only with both proofs is exact repair', () => {
    const d = decideRetireLegacyLogin({
      requestedDriverId: driverId,
      byDriver: null,
      byApproved: surviving,
      byApprovedOwnedByDriver: [surviving],
      proof: proven,
      approvedRow: alphaRow(),
    });
    expect(d.action).toBe('repair');
    if (d.action === 'repair') {
      expect(d.surviving.approvedKey).toBe(ALPHA_KEY);
      expect(d.surviving.opId).toBe('op-orig');
      expect(d.complete).toBe(false);
    }
  });

  it('ambiguous byApproved-only candidates are refused, not repaired', () => {
    const d = decideRetireLegacyLogin({
      requestedDriverId: driverId,
      byDriver: null,
      byApproved: null,
      byApprovedOwnedByDriver: [
        surviving,
        { ...surviving, approvedKey: BRAVO_KEY, opId: 'op-other' },
      ],
      proof: proven,
    });
    expect(d).toEqual({ action: 'refuse', reason: 'binding_ambiguous' });
  });

  it('concurrent binding change stale-previews and does not allow an approved-row stamp', () => {
    const preview = evaluateRetirementPreview({
      requestedDriverId: driverId,
      byDriver: surviving,
      byApproved: surviving,
      proof: proven,
      approvedRow: alphaRow(),
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const concurrent = evaluateRetirementPreview({
      requestedDriverId: driverId,
      byDriver: { ...surviving, opId: 'op-hijack' },
      byApproved: { ...surviving, opId: 'op-hijack' },
      proof: proven,
      approvedRow: alphaRow(),
    });
    expect(concurrent.ok).toBe(true);
    if (!concurrent.ok) return;
    expect(concurrent.digest).not.toBe(preview.digest);

    const failedTx = retirementTerminalAllowsApprovedStamp({
      driverId,
      approvedKey: ALPHA_KEY,
      expectedOpId: surviving.opId,
      byDriver: { ...surviving, status: 'active' },
      byApproved: null,
    });
    expect(failedTx.ok).toBe(false);
  });

  it('successful repair reread allows the approved-row stamp only after both sides agree retired', () => {
    const retired = { ...surviving, status: 'legacy_login_retired' as const };
    const allowed = retirementTerminalAllowsApprovedStamp({
      driverId,
      approvedKey: ALPHA_KEY,
      expectedOpId: 'op-orig',
      byDriver: retired,
      byApproved: retired,
    });
    expect(allowed).toEqual({ ok: true });
    const incomplete = retirementTerminalAllowsApprovedStamp({
      driverId,
      approvedKey: ALPHA_KEY,
      expectedOpId: 'op-orig',
      byDriver: retired,
      byApproved: null,
    });
    expect(incomplete.ok).toBe(false);
  });
});

describe('approved-row retirement existence guard', () => {
  const driverId = 'bbbbbbbb-cccc-4ddd-8eee-000000000001';
  const surviving = {
    driverId,
    approvedKey: ALPHA_KEY,
    status: 'active' as const,
    opId: 'op-orig',
  };
  const proven = {
    secureLoginAt: 1,
    secureLoginDriverId: driverId,
    secureLoginUid: 'uid-1',
    hydrationAt: 2,
    hydrationDriverId: driverId,
  };
  const previewArgs = {
    requestedDriverId: driverId,
    byDriver: surviving,
    byApproved: surviving,
    proof: proven,
  };

  it('row missing at Preview is approved_row_missing, not an unretired digest', () => {
    const missing = evaluateRetirementPreview({ ...previewArgs, approvedRow: null });
    expect(missing).toEqual({ ok: false, reason: 'approved_row_missing' });
    const present = evaluateRetirementPreview({ ...previewArgs, approvedRow: alphaRow() });
    expect(present.ok).toBe(true);
    expect(classifyApprovedRowForRetirement(null).fingerprint).toBe('missing');
    expect(classifyApprovedRowForRetirement(alphaRow()).fingerprint).not.toBe('missing');
  });

  it('row deleted between Preview and Apply is stale_preview', () => {
    const preview = evaluateRetirementPreview({ ...previewArgs, approvedRow: alphaRow() });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const afterDelete = evaluateRetirementPreview({ ...previewArgs, approvedRow: null });
    expect(afterDelete).toEqual({ ok: false, reason: 'approved_row_missing' });
    const gate = evaluateRetirementApplyGate({
      preview: afterDelete,
      expectedPreviewDigest: preview.digest,
    });
    expect(gate).toEqual({ ok: false, reason: 'stale_preview' });
  });

  it('malformed approved row is refused at Preview', () => {
    expect(evaluateRetirementPreview({ ...previewArgs, approvedRow: [] }))
      .toEqual({ ok: false, reason: 'approved_row_malformed' });
    expect(evaluateRetirementPreview({ ...previewArgs, approvedRow: { active: true } }))
      .toEqual({ ok: false, reason: 'approved_row_malformed' });
    expect(evaluateRetirementPreview({ ...previewArgs, approvedRow: 'not-a-row' }))
      .toEqual({ ok: false, reason: 'approved_row_malformed' });
    const malformedApply = evaluateRetirementApplyGate({
      preview: { ok: false, reason: 'approved_row_malformed' },
      expectedPreviewDigest: 'prior-digest',
    });
    expect(malformedApply).toEqual({ ok: false, reason: 'stale_preview' });
  });

  it('replacement of the approved row changes the digest', () => {
    const original = evaluateRetirementPreview({ ...previewArgs, approvedRow: alphaRow() });
    const replaced = evaluateRetirementPreview({
      ...previewArgs,
      approvedRow: { ...alphaRow(), displayName: 'ReplacedName' },
    });
    expect(original.ok).toBe(true);
    expect(replaced.ok).toBe(true);
    if (!original.ok || !replaced.ok) return;
    expect(replaced.digest).not.toBe(original.digest);
    expect(evaluateRetirementApplyGate({
      preview: replaced,
      expectedPreviewDigest: original.digest,
    })).toEqual({ ok: false, reason: 'stale_preview' });
  });

  it('evaluateApprovedRetirementStamp never produces a ghost from missing or malformed', () => {
    expect(evaluateApprovedRetirementStamp(null)).toEqual({
      ok: false, reason: 'approved_row_missing',
    });
    expect(evaluateApprovedRetirementStamp(undefined)).toEqual({
      ok: false, reason: 'approved_row_missing',
    });
    expect(evaluateApprovedRetirementStamp([])).toEqual({
      ok: false, reason: 'approved_row_malformed',
    });
    expect(evaluateApprovedRetirementStamp({ active: true })).toEqual({
      ok: false, reason: 'approved_row_malformed',
    });
  });

  it('normal existing-row retirement succeeds and preserves the row', () => {
    const preview = evaluateRetirementPreview({ ...previewArgs, approvedRow: alphaRow() });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.decision.action).toBe('retire');
    const stamp = evaluateApprovedRetirementStamp(alphaRow());
    expect(stamp.ok).toBe(true);
    if (!stamp.ok) return;
    expect(stamp.next.legacyLoginRetired).toBe(true);
    expect(stamp.next.displayName).toBe(ALPHA_NAME);
    expect(stamp.next.companyId).toBe('fixture-co');
    expect(evaluateRetirementApplyGate({
      preview,
      expectedPreviewDigest: preview.digest,
    })).toEqual(preview);
  });
});

describe('authorization array projection', () => {
  it('uses nested nonempty and empty arrays when top-level is absent', () => {
    const driverId = 'bbbbbbbb-cccc-4ddd-8eee-000000000001';
    const nestedOnly = projectDriverHydration({
      driverId,
      profile: {
        profile: {
          assignedRoutes: ['Nested Route'],
          assignedWells: [],
          assignedCustomers: [{ companyId: 'c', name: 'N' }],
          roles: [],
        },
      },
      trustedHistoryDriverIds: [driverId],
    });
    expect(nestedOnly.assignedRoutes).toEqual(['Nested Route']);
    expect(nestedOnly.assignedWells).toEqual([]);
    expect(nestedOnly.assignedCustomers).toEqual([{ companyId: 'c', name: 'N' }]);
    expect(nestedOnly.roles).toEqual([]);

    const topEmpty = projectDriverHydration({
      driverId,
      profile: {
        assignedRoutes: [],
        assignedWells: [],
        assignedCustomers: [],
        roles: [],
        profile: { assignedRoutes: ['Should not win'] },
      },
      trustedHistoryDriverIds: [driverId],
    });
    expect(topEmpty.assignedRoutes).toEqual([]);
    expect(topEmpty.assignedWells).toEqual([]);
    expect(topEmpty.assignedCustomers).toEqual([]);
    expect(topEmpty.roles).toEqual([]);
  });
});


