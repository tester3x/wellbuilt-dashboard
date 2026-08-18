import { evaluateDriverAuthority } from '../requireDriverAuth';
import { driverAuthUid } from '../tokenMint';

const driverId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const uid = driverAuthUid(driverId);
const profile = {
  active: true,
  companyId: 'liquid-gold',
  displayName: 'iPhone16',
  isAdmin: true,
  assignedRoutes: ['r1', 'r2', 'r3'],
};

describe('evaluateDriverAuthority', () => {
  it('accepts a matching UID, live profile, and matching company', () => {
    const r = evaluateDriverAuthority({
      uid,
      claims: { kind: 'driver', driverId, companyId: 'liquid-gold', roles: ['admin'] },
      data: {},
      profile,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.companyId).toBe('liquid-gold');
  });

  it('rejects driverHash as authority', () => {
    const r = evaluateDriverAuthority({
      uid,
      claims: { kind: 'driver', driverId, companyId: 'liquid-gold' },
      data: { driverHash: 'abc' },
      profile,
    });
    expect(r).toMatchObject({ ok: false, message: 'legacy_hash_rejected' });
  });

  it('rejects stale company claims', () => {
    const r = evaluateDriverAuthority({
      uid,
      claims: { kind: 'driver', driverId, companyId: 'acme-eog-test' },
      data: {},
      profile,
    });
    expect(r).toMatchObject({ ok: false, message: 'company_mismatch' });
  });

  it('rejects disabled and missing profiles', () => {
    expect(
      evaluateDriverAuthority({
        uid,
        claims: { kind: 'driver', driverId, companyId: 'liquid-gold' },
        data: {},
        profile: { ...profile, active: false },
      }).ok,
    ).toBe(false);
    expect(
      evaluateDriverAuthority({
        uid,
        claims: { kind: 'driver', driverId, companyId: 'liquid-gold' },
        data: {},
        profile: null,
      }).ok,
    ).toBe(false);
  });

  it('rejects malformed UID binding', () => {
    const r = evaluateDriverAuthority({
      uid: 'driver_notthecorrectuid00000000',
      claims: { kind: 'driver', driverId, companyId: 'liquid-gold' },
      data: {},
      profile,
    });
    expect(r).toMatchObject({ ok: false, message: 'uid_binding_mismatch' });
  });

  it('rejects allowLegacyHash:true even for an otherwise valid session', () => {
    const r = evaluateDriverAuthority({
      uid,
      claims: { kind: 'driver', driverId, companyId: 'liquid-gold' },
      data: { allowLegacyHash: true },
      profile,
    });
    expect(r).toMatchObject({ ok: false, message: 'legacy_hash_rejected' });
  });
});
