import { resolvePaperCaller } from '../paperCaller';
import { DRIVER_OTHER, DRIVER_ZFOLD, COMPANY_LG } from './fixture20100';

describe('paper caller discriminator', () => {
  it('driver token with roles: [driver] is a driver, not Dashboard', () => {
    const r = resolvePaperCaller({
      uid: 'drv',
      token: { kind: 'driver', driverId: DRIVER_ZFOLD, roles: ['driver'], companyId: COMPANY_LG },
      driverProfile: { active: true, companyId: COMPANY_LG },
      driverProfileExists: true,
    });
    expect(r.ok && r.ok && r.caller.kind === 'driver' && r.caller.driverId === DRIVER_ZFOLD).toBe(true);
  });

  it('driver token without roles still reads as a driver', () => {
    const r = resolvePaperCaller({
      uid: 'drv',
      token: { kind: 'driver', driverId: DRIVER_ZFOLD, companyId: COMPANY_LG },
      driverProfile: { active: true, companyId: COMPANY_LG },
      driverProfileExists: true,
    });
    expect(r.ok && r.caller.kind === 'driver').toBe(true);
    if (r.ok) expect(r.caller.roles).toEqual([]);
  });

  it('deactivated driver is denied without Dashboard fallback', () => {
    const r = resolvePaperCaller({
      uid: 'drv',
      token: { kind: 'driver', driverId: DRIVER_ZFOLD, roles: ['driver'] },
      driverProfile: { active: false, companyId: COMPANY_LG },
      driverProfileExists: true,
      rtdbUser: { role: 'viewer', companyId: COMPANY_LG },
    });
    expect(r).toMatchObject({ ok: false, reason: 'driver_deactivated' });
  });

  it('arbitrary authenticated token is not a Dashboard viewer', () => {
    const r = resolvePaperCaller({
      uid: 'rand',
      token: { sub: 'rand', firebase: { sign_in_provider: 'password' } },
    });
    expect(r).toMatchObject({ ok: false, reason: 'not_dashboard_user' });
  });

  it('legitimate Dashboard dispatcher from RTDB can be a paper reader', () => {
    const r = resolvePaperCaller({
      uid: 'disp',
      token: { role: 'ignored' },
      rtdbUser: { role: 'dispatch', companyId: COMPANY_LG },
    });
    expect(r.ok && r.caller.kind === 'dashboard' && r.caller.roles?.includes('dispatch')).toBe(true);
  });

  it('same-company different driver id is still a driver caller (ownership enforced later)', () => {
    const r = resolvePaperCaller({
      uid: 'other',
      token: { kind: 'driver', driverId: DRIVER_OTHER, companyId: COMPANY_LG },
      driverProfile: { active: true, companyId: COMPANY_LG },
      driverProfileExists: true,
    });
    expect(r.ok && r.caller.driverId === DRIVER_OTHER).toBe(true);
  });
});
