import {
  companyJoinCodeDigest,
  decideCompanyJoinCodeResolution,
  normalizeCompanyJoinCode,
  slugifyCompanyName,
} from '../companyOnboarding';

describe('company onboarding identifiers', () => {
  it('normalizes a human join code without exposing companyId semantics', () => {
    expect(normalizeCompanyJoinCode(' abcd-2345 ')).toBe('ABCD2345');
    expect(normalizeCompanyJoinCode('ABCD 2345')).toBe('ABCD2345');
  });

  it.each([
    [false, undefined, false, undefined, 'unknown'],
    [true, { active: false, companyId: 'a' }, true, { name: 'A' }, 'unknown'],
    [true, { active: true }, true, { name: 'A' }, 'unknown'],
    [true, { active: true, companyId: 'a' }, false, undefined, 'unavailable'],
    [true, { active: true, companyId: 'a' }, true, { name: 'A', status: 'archived' }, 'unavailable'],
  ])('fails closed for invalid mapping/company state', (matchExists, mapping, companyExists, company, reason) => {
    expect(decideCompanyJoinCodeResolution({ matchExists, mapping, companyExists, company })).toEqual({ ok: false, reason });
  });

  it('returns only the server-resolved canonical company', () => {
    expect(decideCompanyJoinCodeResolution({
      matchExists: true,
      mapping: { active: true, companyId: 'canonical-company' },
      companyExists: true,
      company: { name: 'Canonical Company' },
    })).toEqual({ ok: true, companyId: 'canonical-company', companyName: 'Canonical Company' });
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
