import {
  projectDashboardCatalog,
  isSensitiveCatalogKey,
} from '../dashboardCatalogProjection';

const platform = { companyId: undefined, isPlatformAdmin: true };
const companyStaff = { companyId: 'liquid-gold', isPlatformAdmin: false };

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

const rawWells = {
  'Gabriel 1': { route: 'North', tanks: 3, pullBbls: 140, companyId: 'liquid-gold', secret: 'x' },
  'Acme Well': { route: 'South', companyId: 'acme-hauling' },
  'Global Well': { route: 'Unrouted', ndicName: 'GLOBAL 1-1H' },
};

describe('projectDashboardCatalog', () => {
  it('platform administrator receives the authorized all-company view', () => {
    const out = projectDashboardCatalog({
      approved: rawApproved,
      users: rawUsers,
      wellConfig: rawWells,
      caller: platform,
    });
    expect(out.scope).toBe('platform');
    expect(out.companyId).toBeNull();
    expect(Object.keys(out.approved).sort()).toEqual(['gab', 'nested', 'otherco', 'unscoped']);
    expect(Object.keys(out.users).sort()).toEqual(['uidAcme', 'uidLg', 'uidPlat']);
    expect(Object.keys(out.wellConfig).sort()).toEqual(['Acme Well', 'Gabriel 1', 'Global Well']);
    expect(out.counts.approved).toBe(4);
  });

  it('company staff receive only records belonging to caller.companyId', () => {
    const out = projectDashboardCatalog({
      approved: rawApproved,
      users: rawUsers,
      wellConfig: rawWells,
      caller: companyStaff,
    });
    expect(out.scope).toBe('company');
    expect(out.companyId).toBe('liquid-gold');
    expect(Object.keys(out.approved).sort()).toEqual(['gab', 'nested']);
    expect(Object.keys(out.users)).toEqual(['uidLg']);
    expect(Object.keys(out.wellConfig)).toEqual(['Gabriel 1']);
    expect(out.approved.otherco).toBeUndefined();
    expect(out.users.uidAcme).toBeUndefined();
    expect(out.users.uidPlat).toBeUndefined();
    expect(out.wellConfig['Acme Well']).toBeUndefined();
    expect(out.wellConfig['Global Well']).toBeUndefined();
  });

  it('excludes cross-company and unscoped records from company staff', () => {
    const out = projectDashboardCatalog({
      approved: rawApproved,
      users: rawUsers,
      wellConfig: rawWells,
      caller: companyStaff,
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
    expect(gab.legalName).toBe('Gabriel');
    expect(gab.passcode).toBeUndefined();
    expect(gab.passcodeHash).toBeUndefined();
    expect(gab.passwordHash).toBeUndefined();
    expect(gab.token).toBeUndefined();
    expect(gab.sessionToken).toBeUndefined();
    expect((gab.profile as Record<string, unknown>).legalName).toBe('Gabriel Legal');
    expect((gab.profile as Record<string, unknown>).phone).toBe('555-0100');
    expect((gab.profile as Record<string, unknown>).passcode).toBeUndefined();
    expect(out.approved.nested.passcodeHash).toBeUndefined();
    expect(out.approved.nested.displayName).toBe('Nested Driver');
    expect(out.users.uidLg.passwordHash).toBeUndefined();
    expect(out.users.uidLg.session).toBeUndefined();
    expect(out.users.uidLg.driverHash).toBe('gab');
    expect((out.wellConfig['Gabriel 1'] as Record<string, unknown>).secret).toBeUndefined();
    expect((out.wellConfig['Gabriel 1'] as Record<string, unknown>).route).toBe('North');
  });

  it('company staff with no companyId receive an empty catalog', () => {
    const out = projectDashboardCatalog({
      approved: rawApproved,
      users: rawUsers,
      wellConfig: rawWells,
      caller: { companyId: undefined, isPlatformAdmin: false },
    });
    expect(out.scope).toBe('company');
    expect(out.counts).toEqual({ approved: 0, users: 0, wellConfig: 0 });
  });

  it('does not treat driverHash as a sensitive field', () => {
    expect(isSensitiveCatalogKey('driverHash')).toBe(false);
    expect(isSensitiveCatalogKey('passcodeHash')).toBe(true);
    expect(isSensitiveCatalogKey('sessionToken')).toBe(true);
  });
});
