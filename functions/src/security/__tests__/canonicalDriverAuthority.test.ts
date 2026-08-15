/**
 * Neutral canonical driver authority — pure unit tests (no Admin SDK).
 */
import {
  loadCanonicalDriverAuthority,
  getAuthoritativeDriverForSso,
  resolveCanonicalLegalName,
  CANONICAL_LEGAL_NAME_MAX,
  type CanonicalDriverRecordReaders,
} from '../canonicalDriverAuthority';

function readers(partial: {
  credExists?: boolean;
  credActive?: boolean;
  profExists?: boolean;
  profActive?: boolean;
  companyId?: string | null;
  displayName?: unknown;
  legalName?: unknown;
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
      legalName:
        partial.legalName === undefined
          ? null
          : (partial.legalName as string | null),
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
      legalName: null,
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
      legalName: null,
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

describe('resolveCanonicalLegalName', () => {
  test('accepts a distinct trimmed legal name', () => {
    expect(resolveCanonicalLegalName('  Michael S Burger  ', 'Mike S')).toBe(
      'Michael S Burger',
    );
  });

  test('rejects a value identical to displayName, case-insensitively', () => {
    expect(resolveCanonicalLegalName('Mike S', 'Mike S')).toBeNull();
    expect(resolveCanonicalLegalName('mike s', 'Mike S')).toBeNull();
    expect(resolveCanonicalLegalName('  MIKE   S  ', 'Mike S')).toBeNull();
  });

  test.each([
    ['absent', null],
    ['blank', ''],
    ['whitespace only', '   '],
    ['not a string', 42],
    ['carrying a control character', `Michael${String.fromCharCode(0)}`],
    ['carrying a newline', 'Michael\nBurger'],
    ['over the 64-char bound', 'x'.repeat(CANONICAL_LEGAL_NAME_MAX + 1)],
  ])('an unusable legalName (%s) is null, never a placeholder', (_label, value) => {
    expect(resolveCanonicalLegalName(value, 'Mike S')).toBeNull();
  });

  test('never copies displayName when legalName is missing', () => {
    expect(resolveCanonicalLegalName(null, 'Mike S')).toBeNull();
    expect(resolveCanonicalLegalName(undefined, 'Mike S')).toBeNull();
  });

  test('a missing displayName does not invent or reject a valid legalName', () => {
    expect(resolveCanonicalLegalName('Michael S Burger', null)).toBe(
      'Michael S Burger',
    );
  });
});

describe('authoritative legal name', () => {
  test('a distinct top-level legalName is resolved onto authority', async () => {
    const a = await loadCanonicalDriverAuthority(
      'd1',
      readers({ legalName: '  Michael S Burger  ' }),
    );
    expect(a?.legalName).toBe('Michael S Burger');
    expect(a?.displayName).toBe('Mike S');
  });

  test('a displayName-identical legalName is omitted, never copied', async () => {
    const a = await loadCanonicalDriverAuthority(
      'd1',
      readers({ legalName: 'Mike S' }),
    );
    expect(a?.legalName).toBeNull();
    expect(a?.displayName).toBe('Mike S');
  });

  test('a missing legalName never affects liveness', async () => {
    const a = await loadCanonicalDriverAuthority(
      'd1',
      readers({ legalName: null }),
    );
    expect(a).not.toBeNull();
    expect(a?.active).toBe(true);
    expect(a?.legalName).toBeNull();
  });

  test('a present legalName never rescues a dead driver', async () => {
    const a = await loadCanonicalDriverAuthority(
      'd1',
      readers({ legalName: 'Michael S Burger', credActive: false }),
    );
    expect(a?.active).toBe(false);
    expect(a?.legalName).toBe('Michael S Burger');
  });

  test('the SSO adapter carries the resolved legalName', async () => {
    const d = await getAuthoritativeDriverForSso(
      'd1',
      readers({ legalName: 'Michael S Burger' }),
    );
    expect(d).toEqual({
      driverId: 'd1',
      companyId: 'liquid-gold',
      active: true,
      displayName: 'Mike S',
      legalName: 'Michael S Burger',
    });
  });
});
