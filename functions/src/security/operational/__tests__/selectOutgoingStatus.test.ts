import {
  collectLatestOutgoingByWell,
  partitionAuthorizedOutgoing,
  companyIdForOutgoingWell,
} from '../selectOutgoingStatus';

describe('selectOutgoingStatus', () => {
  const gabrielOld = {
    wellName: 'Gabriel 1',
    currentLevel: "2'7\"",
    timestampUTC: '2026-08-20T17:42:00.000Z',
  };
  const gabrielNew = {
    wellName: 'Gabriel 1',
    currentLevel: "2'7\"",
    lastPullBbls: '140',
    isEdit: true,
    timestampUTC: '2026-08-22T19:00:00.000Z',
  };
  const otherCo = {
    wellName: 'Other Co 1',
    currentLevel: "10'0\"",
    companyId: 'acme',
    timestampUTC: '2026-08-22T20:00:00.000Z',
  };
  const gab2 = {
    wellName: 'Gabriel 2',
    currentLevel: "8'0\"",
    timestampUTC: '2026-08-21T12:00:00.000Z',
  };

  it('keeps the latest packet per well even when companyId is missing', () => {
    const latest = collectLatestOutgoingByWell({
      response_old_Gabriel1: gabrielOld,
      response_new_Gabriel1: gabrielNew,
      not_a_response: gab2,
      response_gab2: gab2,
    });
    expect(latest.get('Gabriel 1')?.timestampUTC).toBe(gabrielNew.timestampUTC);
    expect(latest.get('Gabriel 1')).not.toHaveProperty('companyId');
    expect(latest.get('Gabriel 2')?.wellName).toBe('Gabriel 2');
  });

  it('returns only authorized wells and lists the rest as unavailable', () => {
    const latest = collectLatestOutgoingByWell({
      response_g1: gabrielNew,
      response_other: otherCo,
      response_g2: gab2,
    });
    const part = partitionAuthorizedOutgoing({
      latestByWell: latest,
      authorizedWells: ['Gabriel 1', 'Gabriel 2', 'Gabriel 3', 'Gabriel 6'],
    });
    const names = part.responses.map((r) => r.wellName).sort();
    expect(names).toEqual(['Gabriel 1', 'Gabriel 2']);
    expect(part.unavailableWells.sort()).toEqual(['Gabriel 3', 'Gabriel 6']);
    expect(part.responses.some((r) => r.wellName === 'Other Co 1')).toBe(false);
  });

  it('stamps liquid-gold when a well_config row has no companyId', () => {
    expect(companyIdForOutgoingWell({ tanks: 2 })).toBe('liquid-gold');
    expect(companyIdForOutgoingWell({ companyId: 'acme' })).toBe('acme');
    expect(companyIdForOutgoingWell(null)).toBe('liquid-gold');
  });
});
