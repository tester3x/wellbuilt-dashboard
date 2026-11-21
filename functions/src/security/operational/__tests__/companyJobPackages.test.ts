import { nextCompanyJobPackages } from '../companyJobPackages';

describe('transactional company job package changes', () => {
  const water = ['water-hauling'];
  it('installs only the selected package and retains existing packages', () => {
    expect(nextCompanyJobPackages(water, 'independent-dispatch', 'install'))
      .toEqual(['water-hauling', 'independent-dispatch']);
    expect(water).toEqual(['water-hauling']);
  });
  it('makes retries idempotent and removes only the selected package', () => {
    const both = ['water-hauling', 'independent-dispatch'];
    expect(nextCompanyJobPackages(both, 'independent-dispatch', 'install')).toBe(both);
    expect(nextCompanyJobPackages(both, 'independent-dispatch', 'remove')).toEqual(water);
    expect(nextCompanyJobPackages(water, 'independent-dispatch', 'remove')).toBe(water);
  });
  it('rejects malformed state and removing the final package', () => {
    expect(nextCompanyJobPackages(undefined, 'water-hauling', 'install')).toEqual(water);
    expect(() => nextCompanyJobPackages(water, 'water-hauling', 'remove')).toThrow('last_package');
    expect(() => nextCompanyJobPackages('water-hauling', 'independent-dispatch', 'install')).toThrow('invalid_company_packages');
    expect(() => nextCompanyJobPackages(['water-hauling', 'water-hauling'], 'independent-dispatch', 'install')).toThrow('invalid_company_packages');
  });
});
