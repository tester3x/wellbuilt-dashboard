import { buildPerformanceRow } from '../performanceBuilders';

describe('buildPerformanceRow — golden pins', () => {
  test('packet predictedLevelInches used directly', () => {
    expect(buildPerformanceRow({ wellName: 'Gabriel 5', dateTimeUTC: '2026-08-27T00:39:00.000Z', tankLevelFeet: 7, predictedLevelInches: 52 }))
      .toEqual({ wellKey: 'Gabriel_5', perfTimestamp: '20260826_193900', perfDateStr: '2026-08-26', row: { d: '2026-08-26', a: 84, p: 52 } });
  });
  test('fallback reconstructs prediction from prev response', () => {
    expect(buildPerformanceRow({ wellName: 'Gabriel 5', dateTimeUTC: '2026-08-27T00:39:00.000Z', tankLevelFeet: 7, prevResponse: { currentLevel: "5'11\"", flowRate: '3:27:47', timestampUTC: '2026-08-26T18:01:07.025Z' } }).row.p)
      .toBe(93);
  });
  test('no packet value + no usable prev → predicted = actual', () => {
    expect(buildPerformanceRow({ wellName: 'W X', dateTimeUTC: '2026-08-27T00:39:00.000Z', tankLevelFeet: 7 }))
      .toEqual({ wellKey: 'W_X', perfTimestamp: '20260826_193900', perfDateStr: '2026-08-26', row: { d: '2026-08-26', a: 84, p: 84 } });
  });
});
