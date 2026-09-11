import {
  decideProcessedPullReconcile,
  legacyIdemStorageKey,
  pullIdentitiesMatch,
  selectProcessedPullParent,
  stripLegacyIdemPrefix,
} from '../packetReconcileCore';

const PID = '20260909_192759_Gabriel1_9wxcta';
const DRIVER = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';
const COMPANY = 'liquid-gold';
const LOCAL = {
  wellName: 'Gabriel 1',
  dateTimeUTC: '2026-09-10T00:27:59.598Z',
  bblsTaken: 140,
  tankLevelFeet: 12,
};

describe('legacy idem_ identity', () => {
  it('does not rewrite a canonical id into idem_ for new storage', () => {
    expect(legacyIdemStorageKey(PID)).toBe(`idem_${PID}`);
    expect(stripLegacyIdemPrefix(`idem_${PID}`)).toBe(PID);
    expect(stripLegacyIdemPrefix(PID)).toBe(PID);
  });

  it('matches payload identity across well spacing', () => {
    expect(pullIdentitiesMatch(LOCAL, {
      wellName: 'Gabriel1',
      dateTimeUTC: LOCAL.dateTimeUTC,
      bblsTaken: 140,
      tankLevelFeet: 12,
    })).toBe(true);
    expect(pullIdentitiesMatch(LOCAL, { ...LOCAL, bblsTaken: 80 })).toBe(false);
  });

  it('retires only when tenant + payload match on exact or legacy idem_ record', () => {
    const exact = decideProcessedPullReconcile({
      canonicalPacketId: PID,
      driverId: DRIVER,
      companyId: COMPANY,
      localIdentity: LOCAL,
      exact: { ...LOCAL, driverId: DRIVER, companyId: COMPANY },
      legacyIdem: null,
    });
    expect(exact).toEqual({ match: true, location: 'exact', canonicalPacketId: PID });

    const legacy = decideProcessedPullReconcile({
      canonicalPacketId: PID,
      driverId: DRIVER,
      companyId: COMPANY,
      localIdentity: LOCAL,
      exact: null,
      legacyIdem: { ...LOCAL, driverId: DRIVER, companyId: COMPANY, packetId: `idem_${PID}` },
    });
    expect(legacy).toEqual({ match: true, location: 'legacy_idem', canonicalPacketId: PID });
  });

  it('never retires on payload mismatch or cross-tenant', () => {
    expect(decideProcessedPullReconcile({
      canonicalPacketId: PID,
      driverId: DRIVER,
      companyId: COMPANY,
      localIdentity: LOCAL,
      exact: null,
      legacyIdem: { ...LOCAL, bblsTaken: 1, driverId: DRIVER, companyId: COMPANY },
    }).match).toBe(false);
    expect(decideProcessedPullReconcile({
      canonicalPacketId: PID,
      driverId: DRIVER,
      companyId: COMPANY,
      localIdentity: LOCAL,
      exact: { ...LOCAL, driverId: 'other', companyId: COMPANY },
      legacyIdem: null,
    })).toEqual({ match: false, reason: 'cross_tenant' });
  });

  it('edit parent lookup prefers exact then legacy, collision-safe', () => {
    const found = selectProcessedPullParent({
      canonicalPacketId: PID,
      driverId: DRIVER,
      companyId: COMPANY,
      exact: null,
      legacyIdem: { wellName: 'Gabriel 1', driverId: DRIVER, companyId: COMPANY },
    });
    expect(found.record && 'location' in found && found.location).toBe('legacy_idem');
    const missing = selectProcessedPullParent({
      canonicalPacketId: PID,
      driverId: DRIVER,
      companyId: COMPANY,
      exact: null,
      legacyIdem: null,
    });
    expect(missing).toEqual({ record: null, reason: 'missing_original' });
    const cross = selectProcessedPullParent({
      canonicalPacketId: PID,
      driverId: DRIVER,
      companyId: COMPANY,
      exact: { driverId: 'other', companyId: COMPANY },
      legacyIdem: null,
    });
    expect(cross).toEqual({ record: null, reason: 'cross_tenant' });
  });
});
