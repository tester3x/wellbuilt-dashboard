import { computeTankLevels, estimatePull, resolveBblPerFoot } from '../tankDomain';

describe('tank domain golden fixtures', () => {
  it('uses configured bblPerFoot rather than 20 * tanks', () => {
    expect(resolveBblPerFoot({ bblPerFoot: 24, tanks: 2 })).toBe(24);
    const levels = computeTankLevels({ tankLevelFeet: 10, bblsTaken: 48, bblPerFoot: 24 });
    expect(levels.tankTopInches).toBe(120);
    expect(levels.tankAfterInches).toBe(96);
  });

  it('well-down returns Down / Unknown / 0 and omits next pull', () => {
    const est = estimatePull({
      tankAfterInches: 96,
      bottomInches: 36,
      pullBbls: 140,
      tanks: 1,
      afrDays: 1,
      dateTimeUTC: '2026-08-16T17:00:00.000Z',
      wellDown: true,
      bblPerFoot: 24,
    });
    expect(est.timeTillPull).toBe('Down');
    expect(est.flowRate).toBe('Unknown');
    expect(est.bbls24hrs).toBe('0');
  });

  it('uses bblPerFoot for 24hr production, not 20*tanks', () => {
    const est = estimatePull({
      tankAfterInches: 96,
      bottomInches: 36,
      pullBbls: 140,
      tanks: 2,
      afrDays: 1,
      dateTimeUTC: '2026-08-16T17:00:00.000Z',
      wellDown: false,
      bblPerFoot: 30,
    });
    expect(est.bbls24hrs).toBe('30');
  });
});
