import { evaluateGovernedWellConfig, toGovernedWellRecord } from '../governedWellConfig';

const COMPANY = 'liquid-gold';
const wellConfig = {
  'Gabriel 5': {
    route: 'Gabriels',
    companyId: COMPANY,
    ndicName: 'GABRIEL 5',
    ndicApiNo: '33-053-01234-00-00',
    h2sStatus: 'low',
    waterWeight: 8.34,
    bblPerFoot: 40,
    tanks: 2,
    tankCapacity: 400,
    tankHeight: 20,
  },
  'Watford 1': {
    route: 'Watford',
    companyId: COMPANY,
    ndicApiNo: '33-053-09999-00-00',
    tanks: 1,
  },
  'Other Co 1': {
    route: 'Gabriels',
    companyId: 'other-co',
    tanks: 1,
  },
};

describe('evaluateGovernedWellConfig', () => {
  it('returns owner/route scoped wells with review fields', () => {
    const r = evaluateGovernedWellConfig({
      companyId: COMPANY,
      assignedRoutes: ['Gabriels'],
      assignedWells: [],
      wellConfig,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.wells)).toEqual(['Gabriel 5']);
    expect(r.wells['Gabriel 5']).toMatchObject({
      canonicalWellKey: 'Gabriel 5',
      displayName: 'GABRIEL 5',
      apiNumber: '33-053-01234-00-00',
      h2sStatus: 'low',
      waterWeight: 8.34,
      bblPerFoot: 40,
      tanks: 2,
      tankCapacity: 400,
      tankHeight: 20,
      route: 'Gabriels',
    });
  });

  it('allows an explicitly assigned well outside the route list', () => {
    const r = evaluateGovernedWellConfig({
      companyId: COMPANY,
      assignedRoutes: ['Gabriels'],
      assignedWells: ['Watford 1'],
      wellConfig,
      wellName: 'Watford 1',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.wells['Watford 1'].canonicalWellKey).toBe('Watford 1');
    expect(r.wells['Watford 1'].bblPerFoot).toBe(20);
  });

  it('denies cross-company wells without leaking the row', () => {
    const r = evaluateGovernedWellConfig({
      companyId: COMPANY,
      assignedRoutes: ['Gabriels'],
      assignedWells: [],
      wellConfig,
      wellName: 'Other Co 1',
    });
    expect(r).toMatchObject({ ok: false, reason: 'well_not_found' });
  });

  it('denies unassigned wells in the same company', () => {
    const r = evaluateGovernedWellConfig({
      companyId: COMPANY,
      assignedRoutes: ['Gabriels'],
      assignedWells: [],
      wellConfig,
      wellName: 'Watford 1',
    });
    expect(r).toMatchObject({ ok: false, reason: 'well_out_of_scope' });
  });

  it('does not project secret or unbounded fields', () => {
    const rec = toGovernedWellRecord('Gabriel 5', {
      ...wellConfig['Gabriel 5'],
      secretToken: 'nope',
    });
    expect(rec).not.toHaveProperty('secretToken');
  });
});
