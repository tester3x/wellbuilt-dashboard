import { selectAssignedWellConfig } from '../referenceData';

const catalog = {
  Gab1: { companyId: 'liquid-gold', route: 'lg-north', bblPerFoot: 24 },
  OtherCo: { companyId: 'acme-eog-test', route: 'lg-north' },
  Unscoped: { route: 'lg-north' },
};

describe('selectAssignedWellConfig', () => {
  it('returns only same-company assigned wells and omits unscoped/cross-company', () => {
    const wells = selectAssignedWellConfig({
      catalog,
      companyId: 'liquid-gold',
      assignedRoutes: ['lg-north'],
    });
    expect(Object.keys(wells)).toEqual(['Gab1']);
    expect(wells.Gab1.companyId).toBe('liquid-gold');
    expect(wells.OtherCo).toBeUndefined();
    expect(wells.Unscoped).toBeUndefined();
  });

  it('fails closed with no company', () => {
    expect(selectAssignedWellConfig({ catalog, companyId: '' })).toEqual({});
  });
});
