import { selectAssignedWellConfig } from '../canonicalAssignment';

const catalog = {
  Gab1: { companyId: 'liquid-gold', route: 'lg-north', bblPerFoot: 24 },
  OtherCo: { companyId: 'acme-eog-test', route: 'lg-north' },
  Unscoped: { route: 'lg-north' },
};

describe('selectAssignedWellConfig', () => {
  it('returns only same-company assigned wells and omits unscoped/cross-company', () => {
    const selected = selectAssignedWellConfig({
      catalog,
      companyId: 'liquid-gold',
      assignedRoutes: ['lg-north'],
    });
    expect(selected.status).toBe('scoped');
    expect(Object.keys(selected.wells)).toEqual(['Gab1']);
    expect(selected.wells.Gab1.companyId).toBe('liquid-gold');
    expect(selected.wells.OtherCo).toBeUndefined();
    expect(selected.wells.Unscoped).toBeUndefined();
  });

  it('fails closed with no company', () => {
    expect(selectAssignedWellConfig({ catalog, companyId: '' })).toEqual({
      status: 'no_company',
      reason: 'company_required',
      wells: {},
    });
  });

  it('never returns unscoped company wells when assignment is missing', () => {
    const selected = selectAssignedWellConfig({
      catalog,
      companyId: 'liquid-gold',
    });
    expect(selected.status).toBe('assignment_unavailable');
    expect(selected.wells).toEqual({});
  });
});
