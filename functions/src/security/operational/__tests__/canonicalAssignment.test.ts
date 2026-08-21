import {
  evaluateCanonicalAssignment,
  selectAssignedWellConfig,
} from '../canonicalAssignment';

const catalog = {
  Gab1: { companyId: 'liquid-gold', route: 'Gabriels', bblPerFoot: 24 },
  Watford1: { companyId: 'liquid-gold', route: 'Watford' },
  OtherCo: { companyId: 'acme-eog-test', route: 'Gabriels' },
  Unscoped: { route: 'Gabriels' },
};

describe('evaluateCanonicalAssignment', () => {
  it('missing both fields is unknown, never eligible or ineligible', () => {
    const v = evaluateCanonicalAssignment({});
    expect(v.status).toBe('unknown');
    expect(v.reason).toBe('assignment_unavailable');
  });

  it('null/non-array fields are missing', () => {
    expect(evaluateCanonicalAssignment({ assignedRoutes: null, assignedWells: undefined }).status).toBe('unknown');
    expect(evaluateCanonicalAssignment({ assignedRoutes: 'Gabriels' }).status).toBe('unknown');
  });

  it('explicit [] is ineligible', () => {
    const v = evaluateCanonicalAssignment({ assignedRoutes: [] });
    expect(v.status).toBe('ineligible');
    expect(v.reason).toBe('explicit_empty');
  });

  it('Unrouted-only is ineligible unless assignedWells grant access', () => {
    expect(evaluateCanonicalAssignment({ assignedRoutes: ['Unrouted'] }).status).toBe('ineligible');
    expect(evaluateCanonicalAssignment({ assignedRoutes: ['Unrouted 2'] }).reason).toBe('unrouted_only');
    const withWells = evaluateCanonicalAssignment({
      assignedRoutes: ['Unrouted'],
      assignedWells: ['Gab1'],
    });
    expect(withWells.status).toBe('eligible');
    expect(withWells.reason).toBe('assigned_wells');
  });

  it('real routes are eligible', () => {
    const v = evaluateCanonicalAssignment({ assignedRoutes: ['Gabriels', 'Watford'] });
    expect(v.status).toBe('eligible');
    expect(v.reason).toBe('real_route');
  });

  it('assigned wells only are eligible', () => {
    const v = evaluateCanonicalAssignment({ assignedWells: ['Gab1'] });
    expect(v.status).toBe('eligible');
    expect(v.reason).toBe('assigned_wells');
  });
});

describe('selectAssignedWellConfig never unscopes a company driver', () => {
  it('real routes return only matching same-company wells', () => {
    const selected = selectAssignedWellConfig({
      catalog,
      companyId: 'liquid-gold',
      assignedRoutes: ['Gabriels'],
    });
    expect(selected.status).toBe('scoped');
    expect(Object.keys(selected.wells)).toEqual(['Gab1']);
    expect(selected.wells.OtherCo).toBeUndefined();
    expect(selected.wells.Unscoped).toBeUndefined();
  });

  it('wells-only scopes to those well names', () => {
    const selected = selectAssignedWellConfig({
      catalog,
      companyId: 'liquid-gold',
      assignedWells: ['Watford1'],
    });
    expect(selected.status).toBe('scoped');
    expect(Object.keys(selected.wells)).toEqual(['Watford1']);
  });

  it('explicit empty returns no wells', () => {
    const selected = selectAssignedWellConfig({
      catalog,
      companyId: 'liquid-gold',
      assignedRoutes: [],
    });
    expect(selected.status).toBe('ineligible');
    expect(selected.wells).toEqual({});
  });

  it('missing assignment returns no wells as assignment_unavailable', () => {
    const selected = selectAssignedWellConfig({
      catalog,
      companyId: 'liquid-gold',
    });
    expect(selected.status).toBe('assignment_unavailable');
    expect(selected.wells).toEqual({});
  });

  it('fails closed with no company', () => {
    const selected = selectAssignedWellConfig({ catalog, companyId: '' });
    expect(selected.status).toBe('no_company');
    expect(selected.wells).toEqual({});
  });
});
