/**
 * Deterministic approved-row conversion proofs. In-memory store only —
 * no production identities, no passcodes resembling live credentials.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  TEST_PASSCODE_RECORD,
  clientOutcomeFor,
  createMemoryConversionStore,
  decideAuthorityDelete,
  decideProfileFieldProof,
  decidePrerequisiteProof,
  decideProfileWrite,
  runApprovedRowConversion,
  type ConversionInput,
  type ConversionInspect,
} from '../approvedRowConversion';
import { decideCreateSecureLoginLink } from '../legacySecureLink';

const MARCIAL_KEY = '7413cd7d106a0f49c2a670064bc049e3260a522a09a6a5a7fad0c53522e63c27';
const LUIZ_KEY = 'cf04d010ffd151b878e4377ca9c51cd90eeaae1660e19387fa51942b56c15780';
const MARCIAL_ROUTES = ['Dunn County', 'Watford', 'Gunslingers'];
const LUIZ_ROUTES = ['Montana', 'River Bottoms', 'Stock Yards', 'Watford', 'Dunn County', 'Gabriels'];

const SLAWSON = [{ companyId: 'liquid-gold', name: 'SLAWSON EXPLORATION COMPANY, INC.' }];

function marcialRow(): Record<string, unknown> {
  return {
    active: true,
    displayName: 'Marcial Lebaron',
    legalName: 'Marcial Lebaron',
    name: 'Marcial Lebaron',
    companyId: 'liquid-gold',
    companyName: 'Liquid Gold Trucking LLC',
    assignedCustomers: SLAWSON,
    assignedRoutes: [...MARCIAL_ROUTES],
    isAdmin: false,
    isViewer: false,
    approvedAt: 1772370850548,
    // assignedWells intentionally missing
  };
}

function luizRow(): Record<string, unknown> {
  return {
    active: true,
    displayName: 'Wisho-135',
    legalName: 'Luiz Lebaron',
    name: 'Wisho-135',
    companyId: 'liquid-gold',
    companyName: 'Liquid Gold Trucking LLC',
    assignedCustomers: SLAWSON,
    assignedRoutes: [...LUIZ_ROUTES],
    isAdmin: false,
    isViewer: false,
    approvedAt: 1772371310138,
  };
}

function baseInput(over: Partial<ConversionInput> = {}): ConversionInput {
  return {
    displayName: 'Marcial Lebaron',
    approvedKey: MARCIAL_KEY,
    companyId: 'liquid-gold',
    companyName: 'Liquid Gold Trucking LLC',
    legalName: 'Marcial Lebaron',
    passcodeRecord: TEST_PASSCODE_RECORD,
    temporary: false,
    callerUid: 'admin-test',
    opId: over.opId || 'op-1',
    ...over,
  };
}

function seedBoth(store: ReturnType<typeof createMemoryConversionStore>) {
  store.approved.set(MARCIAL_KEY, marcialRow());
  store.approved.set(LUIZ_KEY, luizRow());
}

describe('approved-row conversion refusals write nothing', () => {
  it('1. missing approvedKey/legacyHash → legacy_link_required, zero writes', async () => {
    const store = createMemoryConversionStore();
    seedBoth(store);
    const r = await runApprovedRowConversion(store, baseInput({ approvedKey: undefined }));
    expect(r.status).toBe('refused');
    expect(r.reason).toBe('legacy_link_required');
    expect(store.credentials.size).toBe(0);
    expect(store.index.size).toBe(0);
    expect(store.profiles.size).toBe(0);
    expect(store.approved.get(MARCIAL_KEY)?.migratedToDriverId).toBeUndefined();
  });

  it('2. malformed key → refusal, zero writes', async () => {
    const store = createMemoryConversionStore();
    seedBoth(store);
    const r = await runApprovedRowConversion(store, baseInput({ approvedKey: 'Marcial Lebaron' }));
    expect(r).toMatchObject({ status: 'refused', reason: 'approved_key_malformed' });
    expect(store.profiles.size).toBe(0);
  });

  it('3. exact key but mismatched displayName → refusal, zero writes', async () => {
    const store = createMemoryConversionStore();
    seedBoth(store);
    const r = await runApprovedRowConversion(store, baseInput({ displayName: 'Wisho-135' }));
    expect(r.reason).toBe('approved_row_name_mismatch');
    expect(store.credentials.size).toBe(0);
    expect(store.approved.get(MARCIAL_KEY)?.migratedToDriverId).toBeUndefined();
  });

  it('4. already-linked row → refusal, zero writes', async () => {
    const store = createMemoryConversionStore();
    seedBoth(store);
    store.approved.set(MARCIAL_KEY, {
      ...marcialRow(),
      migratedToDriverId: 'aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff',
    });
    const r = await runApprovedRowConversion(store, baseInput());
    expect(r.reason).toBe('approved_row_already_linked');
    expect(store.credentials.size).toBe(0);
  });

  it('inactive approved row is classified and writes nothing', async () => {
    const store = createMemoryConversionStore();
    store.approved.set(MARCIAL_KEY, { ...marcialRow(), active: false });
    const r = await runApprovedRowConversion(store, baseInput());
    expect(r.reason).toBe('approved_row_inactive');
    expect(store.credentials.size).toBe(0);
  });

  it('malformed approved row is classified and writes nothing', async () => {
    const store = createMemoryConversionStore();
    store.approved.set(MARCIAL_KEY, { ...marcialRow(), active: 'yes' });
    const r = await runApprovedRowConversion(store, baseInput());
    expect(r.reason).toBe('approved_row_malformed');
    expect(store.profiles.size).toBe(0);
  });

  it('18. keyless 31072-shaped request fails and writes nothing', async () => {
    const store = createMemoryConversionStore();
    seedBoth(store);
    const r = await runApprovedRowConversion(store, baseInput({
      approvedKey: undefined,
      legacyHash: undefined,
      driverId: undefined,
    }));
    expect(decideCreateSecureLoginLink({})).toEqual({ action: 'refuse', reason: 'legacy_link_required' });
    expect(r.reason).toBe('legacy_link_required');
    expect(store.journalMap.size).toBe(0);
    expect(store.credentials.size).toBe(0);
    expect(store.profiles.size).toBe(0);
    expect(store.authority.size).toBe(0);
  });
});

describe('approved-row conversion copies exact scope and isolates identities', () => {
  it('client-supplied company/legalName cannot override the approved row', async () => {
    const store = createMemoryConversionStore();
    seedBoth(store);
    const r = await runApprovedRowConversion(store, baseInput({
      companyId: 'acme-eog-test',
      companyName: 'Nope',
      legalName: 'Someone Else',
    }));
    expect(r.status).toBe('ok');
    const profile = store.profiles.get(r.driverId!)!;
    expect(profile.companyId).toBe('liquid-gold');
    expect(profile.companyName).toBe('Liquid Gold Trucking LLC');
    expect(profile.legalName).toBe('Marcial Lebaron');
    expect(profile.isAdmin).toBe(false);
    expect(profile.assignedCustomers).toEqual(SLAWSON);
  });

  it('5. Marcial-shaped fixture copies exactly Dunn County, Watford, Gunslingers', async () => {
    const store = createMemoryConversionStore();
    seedBoth(store);
    const r = await runApprovedRowConversion(store, baseInput({ opId: 'op-m' }));
    expect(r.status).toBe('ok');
    expect(r.copiedRoutes).toEqual(MARCIAL_ROUTES);
    const profile = store.profiles.get(r.driverId!)!;
    expect(profile.assignedRoutes).toEqual(MARCIAL_ROUTES);
    expect(profile.displayName).toBe('Marcial Lebaron');
    expect(store.approved.get(LUIZ_KEY)?.migratedToDriverId).toBeUndefined();
  });

  it('6. Luiz-shaped fixture copies his six routes only', async () => {
    const store = createMemoryConversionStore();
    seedBoth(store);
    const r = await runApprovedRowConversion(store, baseInput({
      approvedKey: LUIZ_KEY,
      displayName: 'Wisho-135',
      legalName: 'Luiz Lebaron',
      opId: 'op-l',
    }));
    expect(r.status).toBe('ok');
    expect(r.copiedRoutes).toEqual(LUIZ_ROUTES);
    expect(store.profiles.get(r.driverId!)!.assignedRoutes).toEqual(LUIZ_ROUTES);
    expect(store.approved.get(MARCIAL_KEY)?.migratedToDriverId).toBeUndefined();
  });

  it('7. missing assignedWells is stored as null on the canonical profile', async () => {
    const store = createMemoryConversionStore();
    seedBoth(store);
    const r = await runApprovedRowConversion(store, baseInput());
    expect(r.copiedWells).toBeNull();
    expect(store.profiles.get(r.driverId!)!.assignedWells).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(marcialRow(), 'assignedWells')).toBe(false);
  });

  it('16. Marcial and Luiz remain two independent identities and name-index keys', async () => {
    const store = createMemoryConversionStore();
    seedBoth(store);
    const m = await runApprovedRowConversion(store, baseInput({ opId: 'op-m' }));
    const l = await runApprovedRowConversion(store, baseInput({
      approvedKey: LUIZ_KEY,
      displayName: 'Wisho-135',
      legalName: 'Luiz Lebaron',
      opId: 'op-l',
    }));
    expect(m.driverId).not.toBe(l.driverId);
    expect(store.index.get('marcial lebaron')!.driverId).toBe(m.driverId);
    expect(store.index.get('wisho-135')!.driverId).toBe(l.driverId);
    expect(store.approved.get(MARCIAL_KEY)!.migratedToDriverId).toBe(m.driverId);
    expect(store.approved.get(LUIZ_KEY)!.migratedToDriverId).toBe(l.driverId);
  });
});

describe('forced failures: owned compensation and resume', () => {
  it('8. failure after credential/index commit rolls identity back', async () => {
    const store = createMemoryConversionStore();
    seedBoth(store);
    const r = await runApprovedRowConversion(store, baseInput({ failAfter: 'identity', opId: 'op-f8' }));
    expect(r.status).toBe('rolled_back');
    expect(clientOutcomeFor(r).success).toBe(false);
    expect(store.credentials.size).toBe(0);
    expect(store.index.size).toBe(0);
    expect(store.profiles.size).toBe(0);
    expect(store.approved.get(MARCIAL_KEY)!.migratedToDriverId).toBeUndefined();
  });

  it('9. failure after profile write leaves no orphan profile', async () => {
    const store = createMemoryConversionStore();
    seedBoth(store);
    const r = await runApprovedRowConversion(store, baseInput({ failAfter: 'profile', opId: 'op-f9' }));
    expect(r.status).toBe('rolled_back');
    expect(store.profiles.size).toBe(0);
    expect(store.credentials.size).toBe(0);
    expect(store.approved.get(MARCIAL_KEY)!.migratedToDriverId).toBeUndefined();
  });

  it('10. failure during legacy-link write leaves no broken credential/profile pair', async () => {
    const store = createMemoryConversionStore();
    seedBoth(store);
    const r = await runApprovedRowConversion(store, baseInput({
      failAfter: 'during_legacy_link',
      opId: 'op-f10',
    }));
    expect(r.status).toBe('rolled_back');
    expect(store.credentials.size).toBe(0);
    expect(store.profiles.size).toBe(0);
    expect(store.authority.size).toBe(0);
    expect(store.approved.get(MARCIAL_KEY)!.migratedToDriverId).toBeUndefined();
    expect(store.approved.get(MARCIAL_KEY)!.secureProfileLinked).toBeUndefined();
  });

  it('11. failure after legacy-link write is resumable; same UUID completes', async () => {
    const store = createMemoryConversionStore();
    seedBoth(store);
    const first = await runApprovedRowConversion(store, baseInput({ failAfter: 'legacy_link', opId: 'op-f11a' }));
    expect(first.status).toBe('linked_resumable');
    expect(first.terminalProven).toBe(false);
    expect(clientOutcomeFor(first).success).toBe(false);
    expect(store.approved.get(MARCIAL_KEY)!.migratedToDriverId).toBe(first.driverId);
    expect(store.credentials.has(first.driverId!)).toBe(true);
    const retry = await runApprovedRowConversion(store, baseInput({ opId: 'op-f11b' }));
    expect(retry.status).toBe('ok');
    expect(retry.driverId).toBe(first.driverId);
    expect(store.journalMap.get(`legacy:${MARCIAL_KEY}`)!.completed).toBe(true);
  });

  it('12. shift-authority exception/refusal does not permanently link', async () => {
    const store = createMemoryConversionStore();
    seedBoth(store);
    const afterEnsure = await runApprovedRowConversion(store, baseInput({
      failAfter: 'authority',
      opId: 'op-f12a',
    }));
    expect(afterEnsure.status).toBe('rolled_back');
    expect(store.approved.get(MARCIAL_KEY)!.migratedToDriverId).toBeUndefined();
    expect(store.approved.get(MARCIAL_KEY)!.secureProfileLinked).toBeUndefined();
    expect(store.authority.size).toBe(0);
    expect(store.credentials.size).toBe(0);

    const refuseStore = createMemoryConversionStore();
    seedBoth(refuseStore);
    refuseStore.ensureAuthority = async () => ({ action: 'refuse', wrote: false });
    const refused = await runApprovedRowConversion(refuseStore, baseInput({ opId: 'op-f12b' }));
    expect(refused.status).toBe('rolled_back');
    expect(refuseStore.approved.get(MARCIAL_KEY)!.migratedToDriverId).toBeUndefined();
    expect(refuseStore.credentials.size).toBe(0);
    expect(refuseStore.profiles.size).toBe(0);
  });

  it('13. journal completion failure is resumable with deterministic recovery', async () => {
    const store = createMemoryConversionStore();
    seedBoth(store);
    const first = await runApprovedRowConversion(store, baseInput({
      failAfter: 'journal_complete',
      opId: 'op-f13a',
    }));
    expect(first.status).toBe('linked_resumable');
    expect(first.terminalProven).toBe(false);
    expect(clientOutcomeFor(first).success).toBe(false);
    expect(store.approved.get(MARCIAL_KEY)!.migratedToDriverId).toBe(first.driverId);
    const retry = await runApprovedRowConversion(store, baseInput({ opId: 'op-f13b' }));
    expect(retry.status).toBe('ok');
    expect(retry.driverId).toBe(first.driverId);
  });

  it('14. concurrent newer credential/index/profile/link cannot be removed by stale compensation', async () => {
    const store = createMemoryConversionStore();
    seedBoth(store);
    const first = await runApprovedRowConversion(store, baseInput({ failAfter: 'identity', opId: 'op-old' }));
    expect(first.status).toBe('rolled_back');
    const newer = await runApprovedRowConversion(store, baseInput({ opId: 'op-new' }));
    expect(newer.status).toBe('ok');
    const id = newer.driverId!;
    expect(store.credentials.get(id)!.opId).toBe('op-new');
    await store.compensateIdentity({
      driverId: id,
      nameNorm: 'marcial lebaron',
      opId: 'op-old',
    });
    expect(await store.removeProfileIfOwned(id, 'op-old')).toBe('left_intact');
    expect(await store.removeAuthorityIfOwned(id, 'op-old')).toBe('left_intact');
    expect(await store.unstampLegacyLinkIfOwned({
      approvedKey: MARCIAL_KEY,
      driverId: id,
      opId: 'op-old',
    })).toBe('left_intact');
    expect(store.credentials.get(id)!.opId).toBe('op-new');
    expect(store.index.get('marcial lebaron')!.driverId).toBe(id);
    expect(store.profiles.get(id)!.provisioningOpId).toBe('op-new');
    expect(store.approved.get(MARCIAL_KEY)).toMatchObject({
      migratedToDriverId: id,
      secureProfileLinked: true,
    });
  });

  it('15. retry uses the same journal UUID and cannot mint a duplicate', async () => {
    const store = createMemoryConversionStore();
    seedBoth(store);
    const a = await runApprovedRowConversion(store, baseInput({ failAfter: 'profile', opId: 'op-a' }));
    expect(a.status).toBe('rolled_back');
    const b = await runApprovedRowConversion(store, baseInput({ opId: 'op-b' }));
    expect(b.status).toBe('ok');
    expect(b.driverId).toBe(a.driverId);
    expect(store.profiles.size).toBe(1);
    expect(store.credentials.size).toBe(1);
  });
});

describe('full success', () => {
  it('17. creates credential, name index, profile, authority, and exact legacy linkage', async () => {
    const store = createMemoryConversionStore();
    seedBoth(store);
    const r = await runApprovedRowConversion(store, baseInput({ opId: 'op-ok' }));
    expect(r.status).toBe('ok');
    expect(r.terminalProven).toBe(true);
    expect(clientOutcomeFor(r).success).toBe(true);
    const id = r.driverId!;
    expect(store.credentials.get(id)).toBeTruthy();
    expect(store.index.get('marcial lebaron')!.driverId).toBe(id);
    expect(store.profiles.get(id)!.assignedRoutes).toEqual(MARCIAL_ROUTES);
    expect(store.authority.get(id)).toMatchObject({ driverId: id, companyId: 'liquid-gold', initialized: true });
    expect(store.approved.get(MARCIAL_KEY)).toMatchObject({
      migratedToDriverId: id,
      secureProfileLinked: true,
    });
    expect(store.journalMap.get(`legacy:${MARCIAL_KEY}`)!.completed).toBe(true);
    expect(JSON.stringify(store.credentials.get(id))).not.toMatch(/passcode-plain|secret123/i);
  });
});

describe('client success is only proven terminal state', () => {
  it('11b. inspection failure before linkage cannot return success', async () => {
    const store = createMemoryConversionStore();
    seedBoth(store);
    const r = await runApprovedRowConversion(store, baseInput({ failAfter: 'inspect', opId: 'op-ins' }));
    expect(r.status).toBe('unproven');
    expect(r.reason).toBe('compensation_unproven');
    expect(r.terminalProven).toBe(false);
    expect(clientOutcomeFor(r)).toMatchObject({ success: false, reason: 'compensation_unproven' });
    expect(store.approved.get(MARCIAL_KEY)!.migratedToDriverId).toBeUndefined();
  });

  it('13b. a foreign profile is refused and never linked', async () => {
    const store = createMemoryConversionStore();
    seedBoth(store);
    const first = await runApprovedRowConversion(store, baseInput({ opId: 'op-ok' }));
    expect(first.status).toBe('ok');
    const id = first.driverId!;
    store.profiles.set(id, {
      ...store.profiles.get(id)!,
      displayName: 'Someone Else',
      provisioningOpId: 'op-other',
      assignedRoutes: ['Other Route'],
    });
    store.journalMap.set(`legacy:${MARCIAL_KEY}`, {
      ...store.journalMap.get(`legacy:${MARCIAL_KEY}`)!,
      completed: false,
    });
    store.approved.set(MARCIAL_KEY, marcialRow());
    const r = await runApprovedRowConversion(store, baseInput({ opId: 'op-foreign' }));
    expect(r.status).toBe('refused');
    expect(r.reason).toBe('profile_foreign');
    expect(clientOutcomeFor(r).success).toBe(false);
    expect(store.approved.get(MARCIAL_KEY)!.migratedToDriverId).toBeUndefined();
  });

  it('12b. authority cleanup cannot delete a concurrently opened pointer', () => {
    expect(decideAuthorityDelete({
      existing: {
        driverId: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001',
        companyId: 'liquid-gold',
        initialized: true,
        openPeriodId: '2026-08-21_120000',
        provisioningOpId: 'op-old',
      },
      myOpId: 'op-old',
      myDriverId: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001',
      expectedCompanyId: 'liquid-gold',
    })).toBe('left_intact');
    expect(decideProfileWrite({
      existing: { displayName: 'Other', companyId: 'x', provisioningOpId: 'op-b', assignedRoutes: [] },
      incoming: { displayName: 'Marcial Lebaron', companyId: 'liquid-gold', provisioningOpId: 'op-a', assignedRoutes: ['Dunn County'] },
    })).toBe('foreign');
  });
});

describe('dedicated callable wiring: 31072 keyless refuse is before any conversion write', () => {
  it('staffConvertApprovedDriverSecureLogin is platform-admin only and never audits the approved key', () => {
    const src = readFileSync(join(__dirname, '../../staffConvertApprovedDriverSecureLogin.ts'), 'utf8');
    expect(src).toContain('requirePlatformAdmin');
    expect(src).not.toContain('requireManageDrivers(');
    expect(src).toContain('runApprovedRowConversion');
    expect(src).toContain('clientOutcomeFor');
    expect(src).toContain('legacy_link_required');
    expect(src).toContain('driverId_reset_forbidden');
    expect(src).toContain('legacyHash_forbidden');
    expect(src).toContain('terminalProven');
    expect(src).not.toMatch(/approvedKeyPrefix/);
    expect(src).not.toMatch(/approvedKey\.slice/);
    expect(src).not.toMatch(/console\.(log|info|debug|warn|error).*passcode/i);
    expect(src).not.toMatch(/legacyHash: data/);
    expect(src).not.toMatch(/legalName: fields/);
    expect(src).not.toMatch(/companyId: typeof raw/);
    expect(JSON.stringify(TEST_PASSCODE_RECORD)).not.toMatch(/Wisho|Marcial|liquid-gold/i);
  });
});

describe('terminal proof rejects inactive/malformed credentials and mismatched profile fields', () => {
  const expected = {
    displayName: 'Marcial Lebaron',
    name: 'Marcial Lebaron',
    legalName: 'Marcial Lebaron',
    active: true,
    isAdmin: false,
    isViewer: false,
    companyId: 'liquid-gold',
    companyName: 'Liquid Gold Trucking LLC',
    assignedCustomers: SLAWSON,
    assignedRoutes: MARCIAL_ROUTES,
    assignedWells: null,
    roles: null,
    approvedAt: 1772370850548,
    schemaVersion: 1,
    mustUseSecureAuth: true,
  };

  const liveOk = (): ConversionInspect => ({
    credentialOpId: 'op-1',
    credentialDisplayNameNorm: 'marcial lebaron',
    credentialActive: true,
    credentialScryptValid: true,
    indexDriverId: 'uuid-1',
    profile: { ...expected },
    profileOpId: 'op-1',
    authority: {
      driverId: 'uuid-1',
      companyId: 'liquid-gold',
      initialized: true,
      openPeriodId: null,
    },
    authorityOpId: 'op-1',
    authorityOpenPeriodId: null,
    legacyLinkedDriverId: 'uuid-1',
    legacyLinkOpId: 'op-1',
    approvedDisplayName: 'Marcial Lebaron',
    approvedSecureProfileLinked: true,
    journalCompleted: true,
  });

  it('rejects credential active that is not exactly true', () => {
    const live = liveOk();
    live.credentialActive = false;
    expect(decidePrerequisiteProof({
      driverId: 'uuid-1',
      nameNorm: 'marcial lebaron',
      companyId: 'liquid-gold',
      expectedProfile: expected,
      live,
    })).toEqual({ ok: false, reason: 'credential_inactive' });
    live.credentialActive = null;
    expect(decidePrerequisiteProof({
      driverId: 'uuid-1',
      nameNorm: 'marcial lebaron',
      companyId: 'liquid-gold',
      expectedProfile: expected,
      live,
    })).toEqual({ ok: false, reason: 'credential_malformed' });
  });

  it('rejects a malformed scrypt record without comparing the hash', () => {
    const live = liveOk();
    live.credentialScryptValid = false;
    expect(decidePrerequisiteProof({
      driverId: 'uuid-1',
      nameNorm: 'marcial lebaron',
      companyId: 'liquid-gold',
      expectedProfile: expected,
      live,
    })).toEqual({ ok: false, reason: 'credential_scrypt_invalid' });
  });

  it('rejects every mismatched canonical profile field', () => {
    for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
      const profile = { ...expected, [key]: key === 'active' ? false : 'NOPE' };
      expect(decideProfileFieldProof(profile, expected))
        .toEqual({ ok: false, reason: `profile_${key}_mismatch` });
    }
  });
});
