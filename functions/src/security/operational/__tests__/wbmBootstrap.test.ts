import { buildWbmBootstrapSnapshot } from '../wbmBootstrap';

const wells = {
  'Gabriel 1': { route: 'Gabriels', maxLevel: 20, companyId: 'liquid-gold' },
  'Watford 1': { route: 'Watford', maxLevel: 18, companyId: 'liquid-gold' },
};

describe('buildWbmBootstrapSnapshot', () => {
  it('returns eligibility, digest, revision, and scoped wells together', () => {
    const snap = buildWbmBootstrapSnapshot({
      driverId: '2cad521c-13ac-4b6c-b1ab-07843c6bf06f',
      companyId: 'liquid-gold',
      profile: { assignedRoutes: ['Gabriels'], assignedWells: [], assignmentRevision: 3 },
      wellConfig: wells,
    });
    expect(snap.eligibilityStatus).toBe('eligible');
    expect(snap.assignmentRevision).toBe(3);
    expect(snap.assignmentDigest).toContain('Gabriels');
    expect(Object.keys(snap.wells)).toEqual(['Gabriel 1']);
    expect(snap.logoutAt).toBeNull();
  });

  it('normalizes canonical logoutAt', () => {
    const snap = buildWbmBootstrapSnapshot({
      driverId: '2cad521c-13ac-4b6c-b1ab-07843c6bf06f',
      companyId: 'liquid-gold',
      profile: { assignedRoutes: ['Gabriels'], assignedWells: [], logoutAt: '2026-08-21T18:00:00.000Z' },
      wellConfig: wells,
    });
    expect(snap.logoutAt).toBe(Date.parse('2026-08-21T18:00:00.000Z'));
  });

  it('missing scope is unknown with empty catalog', () => {
    const snap = buildWbmBootstrapSnapshot({
      driverId: '2cad521c-13ac-4b6c-b1ab-07843c6bf06f',
      companyId: 'liquid-gold',
      profile: {},
      wellConfig: wells,
    });
    expect(snap.eligibilityStatus).toBe('unknown');
    expect(snap.eligibilityReason).toBe('scope_missing');
    expect(snap.wells).toEqual({});
    expect(snap.logoutAt).toBeNull();
  });
});
