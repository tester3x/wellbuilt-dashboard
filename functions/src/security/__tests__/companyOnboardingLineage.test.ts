import {
  companyJoinCodeDigest,
  normalizeCompanyJoinCode,
  slugifyCompanyName,
} from '../companyOnboarding';

describe('company onboarding lineage — identifiers & hashing', () => {
  it('normalizes human join code presentations into canonical 8-char Crockford string', () => {
    expect(normalizeCompanyJoinCode(' abcd-2345 ')).toBe('ABCD2345');
    expect(normalizeCompanyJoinCode('ABCD 2345')).toBe('ABCD2345');
    expect(normalizeCompanyJoinCode('ab-cd-23-45')).toBe('ABCD2345');
    expect(normalizeCompanyJoinCode(null)).toBe('');
    expect(normalizeCompanyJoinCode(undefined)).toBe('');
  });

  it('hashes equivalent join-code presentations to the exact same lookup key', () => {
    const d1 = companyJoinCodeDigest('ABCD-2345');
    const d2 = companyJoinCodeDigest('abcd 2345');
    const d3 = companyJoinCodeDigest('  ABCD2345  ');
    expect(d1).toBe(d2);
    expect(d2).toBe(d3);
    expect(d1).toHaveLength(64);
  });

  it('creates bounded stable company slugs from raw display names', () => {
    expect(slugifyCompanyName(' Liquid Gold Trucking LLC ')).toBe('liquid-gold-trucking-llc');
    expect(slugifyCompanyName('A/B #1')).toBe('a-b-1');
    expect(slugifyCompanyName('---test---')).toBe('test');
  });
});

describe('company onboarding lineage — authorization & tenant scoping contract', () => {
  // Pure logic simulation of getCompanyJoinCode tenant scoping rule
  function resolveTargetCompanyId(caller: { uid: string; companyId?: string | null; isPlatformAdmin: boolean }, requestedCompanyId?: string): { ok: boolean; companyId?: string; error?: string } {
    const requested = String(requestedCompanyId || '').trim();
    const target = caller.isPlatformAdmin ? requested : caller.companyId || '';
    if (!target) {
      return { ok: false, error: 'companyId required' };
    }
    return { ok: true, companyId: target };
  }

  it('restricts company admin to their own companyId regardless of request body', () => {
    const caller = { uid: 'admin-1', companyId: 'company-a', isPlatformAdmin: false };
    
    // Caller requests company-b (cross-tenant attempt)
    const res = resolveTargetCompanyId(caller, 'company-b');
    expect(res.ok).toBe(true);
    // Overridden by caller's own companyId
    expect(res.companyId).toBe('company-a');
  });

  it('allows verified platform admin to target requested companyId', () => {
    const caller = { uid: 'pa-1', companyId: null, isPlatformAdmin: true };
    const res = resolveTargetCompanyId(caller, 'liquid-gold');
    expect(res.ok).toBe(true);
    expect(res.companyId).toBe('liquid-gold');
  });

  it('rejects tenant caller without companyId', () => {
    const caller = { uid: 'user-no-company', companyId: null, isPlatformAdmin: false };
    const res = resolveTargetCompanyId(caller, 'liquid-gold');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('companyId required');
  });
});

describe('driver registration lineage — tenant scoping contract', () => {
  // Pure logic simulation of adminApproveDriverRegistration tenant check
  function checkApprovalTenantScope(caller: { companyId?: string | null }, pending: { companyId?: string | null }): { allowed: boolean; error?: string } {
    if (caller.companyId && pending.companyId !== caller.companyId) {
      return { allowed: false, error: 'Employee request belongs to another company' };
    }
    return { allowed: true };
  }

  it('allows approval when caller company matches pending registration company', () => {
    const caller = { companyId: 'liquid-gold' };
    const pending = { companyId: 'liquid-gold' };
    expect(checkApprovalTenantScope(caller, pending).allowed).toBe(true);
  });

  it('strictly blocks cross-tenant approval', () => {
    const caller = { companyId: 'company-a' };
    const pending = { companyId: 'company-b' };
    const res = checkApprovalTenantScope(caller, pending);
    expect(res.allowed).toBe(false);
    expect(res.error).toBe('Employee request belongs to another company');
  });

  it('allows platform admin (no companyId) to approve any tenant registration', () => {
    const caller = { companyId: null };
    const pending = { companyId: 'company-b' };
    expect(checkApprovalTenantScope(caller, pending).allowed).toBe(true);
  });
});
