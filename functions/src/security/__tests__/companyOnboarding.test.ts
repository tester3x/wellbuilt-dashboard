import {
  companyJoinCodeDigest,
  normalizeCompanyJoinCode,
  slugifyCompanyName,
} from '../companyOnboarding';

describe('company onboarding identifiers', () => {
  it('normalizes a human join code without exposing companyId semantics', () => {
    expect(normalizeCompanyJoinCode(' abcd-2345 ')).toBe('ABCD2345');
    expect(normalizeCompanyJoinCode('ABCD 2345')).toBe('ABCD2345');
  });

  it('hashes equivalent join-code presentations to one lookup key', () => {
    expect(companyJoinCodeDigest('ABCD-2345')).toBe(companyJoinCodeDigest('abcd 2345'));
    expect(companyJoinCodeDigest('ABCD-2345')).toHaveLength(64);
  });

  it('creates bounded stable company ids from names', () => {
    expect(slugifyCompanyName(' Liquid Gold Trucking LLC ')).toBe('liquid-gold-trucking-llc');
    expect(slugifyCompanyName('A/B #1')).toBe('a-b-1');
  });
});
