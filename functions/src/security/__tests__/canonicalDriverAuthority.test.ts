/**
 * Neutral canonical driver authority — pure unit tests (no Admin SDK).
 */
import {
  loadCanonicalDriverAuthority,
  getAuthoritativeDriverForSso,
  type CanonicalDriverRecordReaders,
} from '../canonicalDriverAuthority';

function readers(partial: {
  credExists?: boolean;
  credActive?: boolean;
  profExists?: boolean;
  profActive?: boolean;
  companyId?: string | null;
}): CanonicalDriverRecordReaders {
  return {
    getCredentials: async () => ({
      exists: partial.credExists !== false,
      active: partial.credActive !== false,
    }),
    getProfile: async () => ({
      exists: partial.profExists !== false,
      active: partial.profActive !== false,
      companyId:
        partial.companyId === undefined ? 'liquid-gold' : partial.companyId,
    }),
  };
}

describe('loadCanonicalDriverAuthority', () => {
  test('valid secure driver', async () => {
    const a = await loadCanonicalDriverAuthority('d1', readers({}));
    expect(a).toEqual({
      driverId: 'd1',
      companyId: 'liquid-gold',
      credentialsActive: true,
      profileActive: true,
      active: true,
    });
  });

  test('missing credentials → null', async () => {
    expect(
      await loadCanonicalDriverAuthority('d1', readers({ credExists: false })),
    ).toBeNull();
  });

  test('inactive credentials → active false', async () => {
    const a = await loadCanonicalDriverAuthority(
      'd1',
      readers({ credActive: false }),
    );
    expect(a?.active).toBe(false);
    expect(a?.credentialsActive).toBe(false);
  });

  test('missing profile → null', async () => {
    expect(
      await loadCanonicalDriverAuthority('d1', readers({ profExists: false })),
    ).toBeNull();
  });

  test('inactive profile → active false', async () => {
    const a = await loadCanonicalDriverAuthority(
      'd1',
      readers({ profActive: false }),
    );
    expect(a?.active).toBe(false);
    expect(a?.profileActive).toBe(false);
  });

  test('missing company → null', async () => {
    expect(
      await loadCanonicalDriverAuthority('d1', readers({ companyId: null })),
    ).toBeNull();
    expect(
      await loadCanonicalDriverAuthority('d1', readers({ companyId: '' })),
    ).toBeNull();
  });
});

describe('getAuthoritativeDriverForSso adapter', () => {
  test('maps valid authority to SSO shape', async () => {
    const d = await getAuthoritativeDriverForSso('d1', readers({}));
    expect(d).toEqual({
      driverId: 'd1',
      companyId: 'liquid-gold',
      active: true,
    });
  });

  test('null authority maps to null', async () => {
    expect(
      await getAuthoritativeDriverForSso('d1', readers({ credExists: false })),
    ).toBeNull();
  });
});
