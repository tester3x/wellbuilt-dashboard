import {
  projectDashboardCatalog,
  isSensitiveCatalogKey,
  WELL_CONFIG_ALLOWLIST,
  callerCanViewGlobalWellPool,
} from '../dashboardCatalogProjection';

const platform = { companyId: undefined, isPlatformAdmin: true };
const liquidGold = { companyId: 'liquid-gold', isPlatformAdmin: false };
const otherTenant = { companyId: 'acme-hauling', isPlatformAdmin: false };
const missingCompany = { companyId: undefined, isPlatformAdmin: false };

const rawApproved = {
  gab: {
    displayName: 'Gab1',
    legalName: 'Gabriel',
    companyId: 'liquid-gold',
    active: true,
    passcode: '9999',
    passcodeHash: 'should-not-leak',
    passwordHash: 'nope',
    token: 'session-token',
    sessionToken: 'sess',
    profile: { legalName: 'Gabriel Legal', phone: '555-0100', passcode: 'hidden' },
  },
  otherco: {
    displayName: 'Other',
    companyId: 'acme-hauling',
    passcode: '1111',
  },
  unscoped: {
    displayName: 'NoCo',
    token: 'x',
  },
  nested: {
    deviceA: {
      displayName: 'Nested Driver',
      companyId: 'liquid-gold',
      passcodeHash: 'nested-secret',
    },
  },
};

const rawUsers = {
  uidPlat: { email: 'mike@wellbuilt', displayName: 'Mike', role: 'admin' },
  uidLg: {
    email: 'disp@lg',
    displayName: 'LG Dispatch',
    role: 'manager',
    companyId: 'liquid-gold',
    driverHash: 'gab',
    passwordHash: 'user-secret',
    session: { token: 'no' },
  },
  uidAcme: { email: 'a@acme', displayName: 'Acme', role: 'admin', companyId: 'acme-hauling' },
};

const addedTest = {
  activeTanks: 1,
  allowedBottom: 3,
  avgFlowRate: '2:13:49',
  avgFlowRateMinutes: 133.82,
  bblPerFoot: 20,
  bottomLevel: 3,
  equalizedTanks: false,
  h2sStatus: 'unknown',
  numTanks: 1,
  pullBbls: 140,
  requireActualBottom: false,
  route: 'Test Route',
  tankCapacity: 400,
  tankHeight: 20,
  tanks: 1,
};

const rawWells = {
  'Gabriel 1': { route: 'North', tanks: 3, pullBbls: 140, companyId: 'liquid-gold', secret: 'x' },
  'Acme Well': { route: 'South', companyId: 'acme-hauling' },
  'Global Well': { route: 'Unrouted', ndicName: 'GLOBAL 1-1H' },
  AddedTest: addedTest,
};

const rawOutgoing = {
  response_20260206_103659_Python: {
    wellName: 'Python',
    currentLevel: '5\'0"',
    flowRate: '273:37:53',
    timestamp: '12/3/2026, 7:45 AM',
    timestampUTC: '2026-12-03T13:45:00.000Z',
    wellDown: false,
    timeTillPull: '8036:31',
    rawCalculatedBottomInches: 99,
    lastPullPacketId: 'secret-packet',
    processedBy: 'fn',
  },
};

describe('callerCanViewGlobalWellPool', () => {
  it('allows platform, liquid-gold, and unscoped callers; denies other tenants', () => {
    expect(callerCanViewGlobalWellPool(platform)).toBe(true);
    expect(callerCanViewGlobalWellPool(liquidGold)).toBe(true);
    expect(callerCanViewGlobalWellPool(missingCompany)).toBe(true);
    expect(callerCanViewGlobalWellPool(otherTenant)).toBe(false);
  });
});

describe('projectDashboardCatalog', () => {
  it('platform administrator receives the authorized all-company employee view and the full well pool', () => {
    const out = projectDashboardCatalog({
      approved: rawApproved,
      users: rawUsers,
      wellConfig: rawWells,
      outgoing: rawOutgoing,
      caller: platform,
    });
    expect(out.scope).toBe('platform');
    expect(out.companyId).toBeNull();
    expect(out.canViewWellPool).toBe(true);
    expect(Object.keys(out.approved).sort()).toEqual(['gab', 'nested', 'otherco', 'unscoped']);
    expect(Object.keys(out.users).sort()).toEqual(['uidAcme', 'uidLg', 'uidPlat']);
    expect(Object.keys(out.wellConfig).sort()).toEqual(['Acme Well', 'AddedTest', 'Gabriel 1', 'Global Well']);
    expect(out.wellStatus.Python.currentLevel).toBe('5\'0"');
    expect(out.wellStatus.Python.rawCalculatedBottomInches).toBeUndefined();
    expect(out.wellStatus.Python.lastPullPacketId).toBeUndefined();
  });

  it('liquid-gold staff receive the full global well pool including unscoped records', () => {
    const out = projectDashboardCatalog({
      approved: rawApproved,
      users: rawUsers,
      wellConfig: rawWells,
      outgoing: rawOutgoing,
      caller: liquidGold,
    });
    expect(out.canViewWellPool).toBe(true);
    expect(out.companyId).toBe('liquid-gold');
    expect(Object.keys(out.approved).sort()).toEqual(['gab', 'nested']);
    expect(Object.keys(out.users)).toEqual(['uidLg']);
    expect(Object.keys(out.wellConfig).sort()).toEqual(['Acme Well', 'AddedTest', 'Gabriel 1', 'Global Well']);
    expect(out.wellConfig.AddedTest).toBeDefined();
    expect(out.wellConfig['Global Well']).toBeDefined();
    expect(out.wellStatus.Python).toBeDefined();
  });

  it('other tenant staff receive no global wellConfig or wellStatus', () => {
    const out = projectDashboardCatalog({
      approved: rawApproved,
      users: rawUsers,
      wellConfig: rawWells,
      outgoing: rawOutgoing,
      caller: otherTenant,
    });
    expect(out.canViewWellPool).toBe(false);
    expect(Object.keys(out.approved)).toEqual(['otherco']);
    expect(Object.keys(out.users)).toEqual(['uidAcme']);
    expect(out.wellConfig).toEqual({});
    expect(out.wellStatus).toEqual({});
    expect(out.counts.wellConfig).toBe(0);
  });

  it('missing-company non-platform callers receive the well pool but no unscoped employees', () => {
    const out = projectDashboardCatalog({
      approved: rawApproved,
      users: rawUsers,
      wellConfig: rawWells,
      outgoing: rawOutgoing,
      caller: missingCompany,
    });
    expect(out.canViewWellPool).toBe(true);
    expect(out.counts.approved).toBe(0);
    expect(out.counts.users).toBe(0);
    expect(Object.keys(out.wellConfig).sort()).toEqual(['Acme Well', 'AddedTest', 'Gabriel 1', 'Global Well']);
  });

  it('excludes cross-company and unscoped records from company staff employees', () => {
    const out = projectDashboardCatalog({
      approved: rawApproved,
      users: rawUsers,
      wellConfig: rawWells,
      caller: liquidGold,
    });
    expect(out.approved.unscoped).toBeUndefined();
    expect(out.approved.otherco).toBeUndefined();
  });

  it('strips passcodes, hashes, tokens, session material, and private fields', () => {
    const out = projectDashboardCatalog({
      approved: rawApproved,
      users: rawUsers,
      wellConfig: rawWells,
      caller: platform,
    });
    const gab = out.approved.gab;
    expect(gab.displayName).toBe('Gab1');
    expect(gab.passcode).toBeUndefined();
    expect(gab.passcodeHash).toBeUndefined();
    expect(gab.token).toBeUndefined();
    expect((gab.profile as Record<string, unknown>).passcode).toBeUndefined();
    expect(out.users.uidLg.passwordHash).toBeUndefined();
    expect((out.wellConfig['Gabriel 1'] as Record<string, unknown>).secret).toBeUndefined();
  });

  it('keeps production operational well_config fields including AddedTest shape', () => {
    expect(WELL_CONFIG_ALLOWLIST).toEqual(expect.arrayContaining([
      'activeTanks',
      'equalizedTanks',
      'requireActualBottom',
      'loadLine',
      'routeColor',
      'isDown',
      'numTanks',
      'allowedBottom',
    ]));
    const out = projectDashboardCatalog({
      approved: {},
      users: {},
      wellConfig: { AddedTest: addedTest },
      caller: liquidGold,
    });
    const well = out.wellConfig.AddedTest;
    expect(well.activeTanks).toBe(1);
    expect(well.equalizedTanks).toBe(false);
    expect(well.requireActualBottom).toBe(false);
    expect(well.route).toBe('Test Route');
    expect(well.pullBbls).toBe(140);
    expect(well.numTanks).toBe(1);
  });

  it('does not treat driverHash as a sensitive field', () => {
    expect(isSensitiveCatalogKey('driverHash')).toBe(false);
    expect(isSensitiveCatalogKey('passcodeHash')).toBe(true);
    expect(isSensitiveCatalogKey('sessionToken')).toBe(true);
  });
});
