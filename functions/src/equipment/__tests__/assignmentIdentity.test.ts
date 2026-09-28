import {
  canonicalAssignmentFromData,
  equipmentIdForCanonicalAssignment,
  resolveAssignmentSubject,
} from '../assignmentIdentity';

const DRIVER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TOKEN = { kind: 'driver', driverId: DRIVER, companyId: 'co-1' };

async function authority(driverId: string) {
  if (driverId === DRIVER) return { active: true, companyId: 'co-1' };
  if (driverId === OTHER) return { active: false, companyId: 'co-1' };
  if (driverId === '33333333-3333-4333-8333-333333333333') return { active: true, companyId: 'other-co' };
  return null;
}

describe('canonical equipment assignment identity', () => {
  it('lets an authenticated driver read as himself and rejects a client hash', async () => {
    const own = await resolveAssignmentSubject({
      mode: 'driver',
      companyId: 'co-1',
      token: TOKEN,
      payload: { companyId: 'co-1' },
      loadAuthority: authority,
    });
    expect(own).toEqual({ ok: true, driverId: DRIVER, companyId: 'co-1' });

    const injected = await resolveAssignmentSubject({
      mode: 'driver',
      companyId: 'co-1',
      token: TOKEN,
      payload: { driverHash: 'abc123hash' },
      loadAuthority: authority,
    });
    expect(injected).toEqual({ ok: false, reason: 'malformed' });
  });

  it('lets a dashboard manager assign only an active driver in that company', async () => {
    const ok = await resolveAssignmentSubject({
      mode: 'dashboard',
      companyId: 'co-1',
      payload: { driverId: DRIVER },
      loadAuthority: authority,
    });
    expect(ok).toEqual({ ok: true, driverId: DRIVER, companyId: 'co-1' });

    expect(await resolveAssignmentSubject({
      mode: 'dashboard',
      companyId: 'co-1',
      payload: { driverId: OTHER },
      loadAuthority: authority,
    })).toEqual({ ok: false, reason: 'inactive' });

    expect(await resolveAssignmentSubject({
      mode: 'dashboard',
      companyId: 'co-1',
      payload: { driverId: '33333333-3333-4333-8333-333333333333' },
      loadAuthority: authority,
    })).toEqual({ ok: false, reason: 'cross_company' });

    expect(await resolveAssignmentSubject({
      mode: 'dashboard',
      companyId: 'co-1',
      payload: { driverId: DRIVER, approvedKey: 'legacy' },
      loadAuthority: authority,
    })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('hides hash-only rows and keeps a canonical row', () => {
    expect(canonicalAssignmentFromData({
      assignmentId: 'a1', companyId: 'co-1', equipmentId: 'eq-1',
      driverHash: 'legacy-hash', active: true,
    })).toBeNull();
    expect(equipmentIdForCanonicalAssignment({
      assignmentId: 'a1', companyId: 'co-1', equipmentId: 'eq-1',
      driverHash: 'legacy-hash', driverId: DRIVER, active: true,
    }, DRIVER)).toBeNull();
    expect(equipmentIdForCanonicalAssignment({
      assignmentId: 'a2', companyId: 'co-1', equipmentId: 'eq-truck-1',
      driverId: DRIVER, active: true,
    }, DRIVER)).toBe('eq-truck-1');
  });
});
