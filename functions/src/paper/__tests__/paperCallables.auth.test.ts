import * as httpsV2 from 'firebase-functions/v2/https';
import { loadPaperReader } from '../../security/paperCallables';
import { COMPANY_LG, DRIVER_OTHER, DRIVER_ZFOLD } from './fixture20100';

const profiles = new Map<string, { active?: boolean; companyId?: string }>();
const users = new Map<string, Record<string, unknown>>();

jest.mock('firebase-admin', () => ({
  database: () => ({
    ref: (path: string) => ({
      once: async () => {
        if (path.startsWith('drivers/profiles/')) {
          const id = path.slice('drivers/profiles/'.length);
          const val = profiles.get(id);
          return { exists: () => val != null, val: () => val ?? null };
        }
        if (path.startsWith('users/')) {
          const id = path.slice('users/'.length);
          const val = users.get(id);
          return { exists: () => val != null, val: () => val ?? null };
        }
        return { exists: () => false, val: () => null };
      },
    }),
  }),
  firestore: () => ({ collection: () => ({ add: async () => ({}) }) }),
  apps: [],
}));

function request(uid: string, token: Record<string, unknown>): httpsV2.CallableRequest {
  return {
    auth: { uid, token: token as httpsV2.CallableRequest['auth'] extends { token: infer T } | undefined ? T : never },
    data: {},
    rawRequest: {} as httpsV2.CallableRequest['rawRequest'],
  } as httpsV2.CallableRequest;
}

describe('loadPaperReader uses requireSecureDriver for driver tokens', () => {
  beforeEach(() => {
    profiles.clear();
    users.clear();
  });

  it('owner driver from requireSecureDriver is kind=driver', async () => {
    profiles.set(DRIVER_ZFOLD, { active: true, companyId: COMPANY_LG });
    const caller = await loadPaperReader(request('drv-auth', {
      kind: 'driver',
      driverId: DRIVER_ZFOLD,
      companyId: COMPANY_LG,
      roles: ['driver'],
    }));
    expect(caller.kind).toBe('driver');
    expect(caller.driverId).toBe(DRIVER_ZFOLD);
    expect(caller.companyId).toBe(COMPANY_LG);
  });

  it('deactivated driver fails closed without Dashboard fallback', async () => {
    profiles.set(DRIVER_ZFOLD, { active: false, companyId: COMPANY_LG });
    users.set('drv-auth', { role: 'dispatch', companyId: COMPANY_LG });
    await expect(loadPaperReader(request('drv-auth', {
      kind: 'driver',
      driverId: DRIVER_ZFOLD,
      companyId: COMPANY_LG,
    }))).rejects.toMatchObject({
      code: 'permission-denied',
      message: expect.stringContaining('driver_deactivated'),
    });
  });

  it('driver token without driverId never becomes a Dashboard reader', async () => {
    users.set('drv-auth', { role: 'dispatch', companyId: COMPANY_LG, viewTickets: true });
    await expect(loadPaperReader(request('drv-auth', {
      kind: 'driver',
    }))).rejects.toMatchObject({
      message: expect.stringMatching(/driver_unauthenticated|unauthorized|unauthenticated/),
    });
  });

  it('other driver id is still a driver caller (ownership later)', async () => {
    profiles.set(DRIVER_OTHER, { active: true, companyId: COMPANY_LG });
    const caller = await loadPaperReader(request('other', {
      kind: 'driver',
      driverId: DRIVER_OTHER,
      companyId: COMPANY_LG,
    }));
    expect(caller.kind).toBe('driver');
    expect(caller.driverId).toBe(DRIVER_OTHER);
  });

  it('Dashboard dispatch user is not routed through requireSecureDriver', async () => {
    users.set('disp', { role: 'dispatch', companyId: COMPANY_LG });
    const caller = await loadPaperReader(request('disp', { role: 'ignored' }));
    expect(caller.kind).toBe('dashboard');
    expect(caller.roles).toEqual(expect.arrayContaining(['dispatch']));
  });
});
