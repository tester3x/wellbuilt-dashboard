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
  displayName?: unknown;
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
      displayName:
        partial.displayName === undefined
          ? 'Mike S'
          : (partial.displayName as string | null),
    }),
  };
}

describe('loadCanonicalDriverAuthority', () => {
  test('valid secure driver', async () => {
    const a = await loadCanonicalDriverAuthority('d1', readers({}));
    expect(a).toEqual({
      driverId: 'd1',
      companyId: 'liquid-gold',
      displayName: 'Mike S',
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
      displayName: 'Mike S',
    });
  });

  test('null authority maps to null', async () => {
    expect(
      await getAuthoritativeDriverForSso('d1', readers({ credExists: false })),
    ).toBeNull();
  });
});

describe('authoritative display name', () => {
  test('is normalized through the canonical protocol helper', async () => {
    const a = await loadCanonicalDriverAuthority(
      'd1',
      readers({ displayName: '  Mike   S  ' }),
    );
    expect(a?.displayName).toBe('Mike S');
  });

  test.each([
    ['absent', null],
    ['blank', ''],
    ['whitespace only', '   '],
    ['not a string', 42],
    ['carrying a control character', `Mike${String.fromCharCode(0)}`],
    ['carrying a newline', 'Mike\nS'],
    ['over the length bound', 'x'.repeat(121)],
  ])('an unusable name (%s) becomes null, never a placeholder', async (_label, value) => {
    const a = await loadCanonicalDriverAuthority('d1', readers({ displayName: value }));
    expect(a?.displayName).toBeNull();
  });

  test('a missing name never affects liveness — a live driver stays live', async () => {
    // The whole point of the field being nullable: a profile-data gap must
    // not look like a disabled driver and must not deny a valid bridge.
    const a = await loadCanonicalDriverAuthority('d1', readers({ displayName: null }));
    expect(a).not.toBeNull();
    expect(a?.active).toBe(true);
    expect(a?.companyId).toBe('liquid-gold');
  });

  test('a present name never rescues a dead driver', async () => {
    const a = await loadCanonicalDriverAuthority(
      'd1',
      readers({ displayName: 'Mike S', credActive: false }),
    );
    expect(a?.active).toBe(false);
  });

  test('a name is not read as identity — resolution still keys on driverId', async () => {
    // Reading a resolved driver's name is safe; resolving a driver FROM a
    // name is the direction this module must never take.
    const a = await loadCanonicalDriverAuthority('d-other', readers({}));
    expect(a?.driverId).toBe('d-other');
  });
});
