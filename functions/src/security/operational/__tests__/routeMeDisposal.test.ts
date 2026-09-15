import {
  recommendDisposal,
  NO_VERIFIED_DROPOFF,
  DisposalRecord,
  WellDisposalContext,
} from '../routeMeDisposal';

describe('Route Me 5-Rule Disposal Recommendation Engine', () => {
  const well: WellDisposalContext = {
    wellName: 'State 12-1H',
    companyId: 'company-a',
    wellId: 'well-state-12-1h',
  };

  const sampleDisposals: DisposalRecord[] = [
    { well_name: 'SWD Alpha', companyId: 'company-a', isBlacklisted: false, unavailable: false },
    { well_name: 'SWD Beta', companyId: 'company-a', isBlacklisted: false, unavailable: false },
    { well_name: 'SWD Blacklisted', companyId: 'company-a', isBlacklisted: true },
    { well_name: 'SWD Unavailable', companyId: 'company-a', unavailable: true },
    { well_name: 'SWD Foreign Company', companyId: 'company-b', isBlacklisted: false },
  ];

  it('Rule 1 & 2: Filters out blacklisted, unavailable, and cross-company disposals', () => {
    const res = recommendDisposal(sampleDisposals, well);
    expect(res).not.toBe('SWD Blacklisted');
    expect(res).not.toBe('SWD Unavailable');
    expect(res).not.toBe('SWD Foreign Company');
    expect(['SWD Alpha', 'SWD Beta']).toContain(res);
  });

  it('Rule 3: Prefers driver most common disposal when eligible', () => {
    const res = recommendDisposal(sampleDisposals, well, {
      mostCommonDisposalName: 'SWD Beta',
    });
    expect(res).toBe('SWD Beta');
  });

  it('Rule 3: Ignores driver preferred disposal if it is blacklisted', () => {
    const res = recommendDisposal(sampleDisposals, well, {
      mostCommonDisposalName: 'SWD Blacklisted',
    });
    // Falls back to next eligible, does NOT return the blacklisted disposal
    expect(res).not.toBe('SWD Blacklisted');
    expect(['SWD Alpha', 'SWD Beta']).toContain(res);
  });

  it('Rule 3: Uses driver frequency map to pick top eligible disposal', () => {
    const res = recommendDisposal(sampleDisposals, well, {
      disposalFrequencies: {
        'SWD Alpha': 5,
        'SWD Beta': 12,
        'SWD Blacklisted': 100, // higher count, but blacklisted!
      },
    });
    expect(res).toBe('SWD Beta');
  });

  it('Rule 5: Fails safe to "No verified drop-off" when no disposals are eligible', () => {
    const onlyInvalid: DisposalRecord[] = [
      { well_name: 'SWD Bad', companyId: 'company-a', isBlacklisted: true },
      { well_name: 'SWD Foreign', companyId: 'foreign-co' },
    ];
    const res = recommendDisposal(onlyInvalid, well);
    expect(res).toBe(NO_VERIFIED_DROPOFF);
  });

  it('Rule 5: Fails safe to "No verified drop-off" when disposals array is empty', () => {
    expect(recommendDisposal([], well)).toBe(NO_VERIFIED_DROPOFF);
  });
});
