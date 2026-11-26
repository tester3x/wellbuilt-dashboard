import { hasIndependentDispatchPackage, INDEPENDENT_DISPATCH_PACKAGE_ID } from '../independentDispatchPackage';

describe('company-bound independent dispatch package gate', () => {
  it('only accepts an exact active package in a company document', () => {
    expect(INDEPENDENT_DISPATCH_PACKAGE_ID).toBe('independent-dispatch');
    expect(hasIndependentDispatchPackage({ activePackages: ['water-hauling'] })).toBe(false);
    expect(hasIndependentDispatchPackage({ activePackages: ['water-hauling', INDEPENDENT_DISPATCH_PACKAGE_ID] })).toBe(true);
    expect(hasIndependentDispatchPackage({ activePackages: [] })).toBe(false);
    expect(hasIndependentDispatchPackage({ activePackages: 'independent-dispatch' })).toBe(false);
    expect(hasIndependentDispatchPackage({ activePackages: [{ id: INDEPENDENT_DISPATCH_PACKAGE_ID }] })).toBe(false);
    expect(hasIndependentDispatchPackage(null)).toBe(false);
  });
});
