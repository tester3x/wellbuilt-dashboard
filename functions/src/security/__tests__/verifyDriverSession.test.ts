/**
 * verifyDriverSession security matrix — pure decision core.
 *
 * Cases 1–20 (callable decision), 25 concurrent determinism.
 * Cases 21–24 are SSO bridge preservation (separate tools/test-ssoBridge).
 */
import { driverAuthUid } from '../tokenMint';
import { evaluateVerifyDriverSession } from '../verifyDriverSession';
import type { CanonicalDriverRecordReaders } from '../canonicalDriverAuthority';

const DRIVER = '99ff4b35-51ab-4d45-8d54-18b3b8515c9b';
const COMPANY = 'liquid-gold';
const UID = driverAuthUid(DRIVER);

function goodReaders(over: Partial<{
  credExists: boolean;
  credActive: boolean;
  profExists: boolean;
  profActive: boolean;
  companyId: string | null;
}> = {}): CanonicalDriverRecordReaders {
  return {
    getCredentials: async () => ({
      exists: over.credExists !== false,
      active: over.credActive !== false,
    }),
    getProfile: async () => ({
      exists: over.profExists !== false,
      active: over.profActive !== false,
      companyId: over.companyId === undefined ? COMPANY : over.companyId,
    }),
  };
}

function goodClaims(over: Record<string, unknown> = {}) {
  return {
    kind: 'driver',
    driverId: DRIVER,
    companyId: COMPANY,
    ...over,
  };
}

async function evalCase(partial: {
  uid?: string | null;
  claims?: Record<string, unknown> | null;
  data?: unknown;
  readers?: CanonicalDriverRecordReaders;
}) {
  return evaluateVerifyDriverSession({
    uid: partial.uid === undefined ? UID : partial.uid,
    claims: partial.claims === undefined ? goodClaims() : partial.claims,
    data: partial.data === undefined ? {} : partial.data,
    readers: partial.readers || goodReaders(),
  });
}

function expectDenied(
  r: Awaited<ReturnType<typeof evaluateVerifyDriverSession>>,
  code: string,
) {
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.error.code).toBe(code);
    // Coarse messages only
    expect(['unauthenticated', 'not_authorized', 'invalid_request']).toContain(
      r.error.message,
    );
  }
}

describe('verifyDriverSession security matrix', () => {
  test('1. unauthenticated request rejected', async () => {
    expectDenied(await evalCase({ uid: null }), 'unauthenticated');
    expectDenied(await evalCase({ uid: '' }), 'unauthenticated');
  });

  test('2. unknown request key rejected', async () => {
    expectDenied(
      await evalCase({ data: { driverId: DRIVER } }),
      'invalid-argument',
    );
    expectDenied(await evalCase({ data: { foo: 1 } }), 'invalid-argument');
    expectDenied(await evalCase({ data: [] }), 'invalid-argument');
  });

  test('3. wrong token kind rejected', async () => {
    expectDenied(
      await evalCase({ claims: goodClaims({ kind: 'admin' }) }),
      'permission-denied',
    );
  });

  test('4. missing driverId claim rejected', async () => {
    expectDenied(
      await evalCase({ claims: goodClaims({ driverId: '' }) }),
      'permission-denied',
    );
    const c = goodClaims();
    delete (c as any).driverId;
    expectDenied(await evalCase({ claims: c }), 'permission-denied');
  });

  test('5. missing companyId claim rejected', async () => {
    expectDenied(
      await evalCase({ claims: goodClaims({ companyId: '' }) }),
      'permission-denied',
    );
  });

  test('6. request.auth.uid not canonical for driverId rejected', async () => {
    expectDenied(
      await evalCase({ uid: 'driver_notthecanonicaluid00001' }),
      'permission-denied',
    );
  });

  test('7. missing credentials rejected', async () => {
    expectDenied(
      await evalCase({ readers: goodReaders({ credExists: false }) }),
      'permission-denied',
    );
  });

  test('8. inactive credentials rejected', async () => {
    expectDenied(
      await evalCase({ readers: goodReaders({ credActive: false }) }),
      'permission-denied',
    );
  });

  test('9. missing profile rejected', async () => {
    expectDenied(
      await evalCase({ readers: goodReaders({ profExists: false }) }),
      'permission-denied',
    );
  });

  test('10. inactive profile rejected', async () => {
    expectDenied(
      await evalCase({ readers: goodReaders({ profActive: false }) }),
      'permission-denied',
    );
  });

  test('11. missing profile company rejected', async () => {
    expectDenied(
      await evalCase({ readers: goodReaders({ companyId: null }) }),
      'permission-denied',
    );
  });

  test('12. profile/claim company mismatch rejected', async () => {
    expectDenied(
      await evalCase({
        claims: goodClaims({ companyId: 'other-co' }),
        readers: goodReaders({ companyId: COMPANY }),
      }),
      'permission-denied',
    );
  });

  test('13. valid secure driver returns exact three-key response', async () => {
    const r = await evalCase({});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.value).sort()).toEqual([
        'active',
        'companyId',
        'driverId',
      ]);
      expect(r.value).toEqual({
        driverId: DRIVER,
        companyId: COMPANY,
        active: true,
      });
      expect(r.value.active).toBe(true);
    }
  });

  test('14. client cannot select another driver', async () => {
    // Body driverId is rejected as excess key; claims still win identity
    expectDenied(
      await evalCase({ data: { driverId: 'other-driver-uuid' } }),
      'invalid-argument',
    );
  });

  test('15. client cannot supply company', async () => {
    expectDenied(
      await evalCase({ data: { companyId: 'hijack' } }),
      'invalid-argument',
    );
  });

  test('16. client cannot supply hash/name/passcode', async () => {
    for (const data of [
      { passcode: '123456' },
      { hash: 'deadbeef' },
      { displayName: 'MikeS24' },
      { name: 'MikeS24' },
    ]) {
      expectDenied(await evalCase({ data }), 'invalid-argument');
    }
  });

  test('17. no shift read/write (readers only cred+profile)', async () => {
    const calls: string[] = [];
    const readers: CanonicalDriverRecordReaders = {
      getCredentials: async () => {
        calls.push('cred');
        return { exists: true, active: true };
      },
      getProfile: async () => {
        calls.push('profile');
        return { exists: true, active: true, companyId: COMPANY };
      },
    };
    const r = await evalCase({ readers });
    expect(r.ok).toBe(true);
    expect(calls.sort()).toEqual(['cred', 'profile']);
  });

  test('18. no token or claim mint/mutation (pure function)', async () => {
    // evaluateVerifyDriverSession has no mint/setCustomUserClaims seams —
    // success path only returns the three-key object.
    const r = await evalCase({});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).not.toHaveProperty('customToken');
      expect(r.value).not.toHaveProperty('idToken');
      expect(r.value).not.toHaveProperty('refreshToken');
      expect(r.value).not.toHaveProperty('roles');
      expect(r.value).not.toHaveProperty('displayName');
      expect(r.value).not.toHaveProperty('profile');
    }
  });

  test('19. coarse error behavior', async () => {
    const cases = await Promise.all([
      evalCase({ uid: null }),
      evalCase({ readers: goodReaders({ credExists: false }) }),
      evalCase({ data: { x: 1 } }),
    ]);
    for (const r of cases) {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.message).not.toMatch(/credential|profile|companyId|passcode|hash/i);
      }
    }
  });

  test('20. empty body {} and null data both accepted for valid session', async () => {
    const a = await evalCase({ data: {} });
    const b = await evalCase({ data: null });
    const c = await evalCase({ data: undefined });
    expect(a.ok && b.ok && c.ok).toBe(true);
  });

  test('25. concurrent calls are read-only and deterministic', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => evalCase({})),
    );
    for (const r of results) {
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value).toEqual({
          driverId: DRIVER,
          companyId: COMPANY,
          active: true,
        });
      }
    }
  });
});
