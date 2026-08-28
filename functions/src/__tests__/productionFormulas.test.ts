// Golden-fixture parity pins for the production/date-bucketing formulas
// extracted verbatim from index.ts. Combined with the full functions suite
// staying green (behavior-preserving extraction), these prove parity.
import {
  getCSTOffset, getProductionDate, calculateWindowBblsPerDay,
  calculateOvernightBblsPerDay, computeBbls24hrs, type HistoricalPull,
} from '../productionFormulas';

const pulls: HistoricalPull[] = [
  { key: 'a', timestamp: Date.parse('2026-07-14T20:00:00Z'), tankLevelFeet: 12, bblsTaken: 100, wellDown: false },
  { key: 'b', timestamp: Date.parse('2026-07-15T12:00:00Z'), tankLevelFeet: 13, bblsTaken: 120, wellDown: false },
  { key: 'c', timestamp: Date.parse('2026-07-15T18:00:00Z'), tankLevelFeet: 14, bblsTaken: 110, wellDown: false },
];

describe('production formulas — golden pins', () => {
  test('CST/CDT DST rule', () => {
    expect(getCSTOffset(Date.parse('2026-07-15T18:00:00Z')) / 3_600_000).toBe(-5); // CDT
    expect(getCSTOffset(Date.parse('2026-01-15T18:00:00Z')) / 3_600_000).toBe(-6); // CST
  });

  test('production date bucketing at the 6am boundary', () => {
    expect(getProductionDate(Date.parse('2026-07-15T18:00:00Z'))).toBe('2026-07-15'); // evening → same day
    expect(getProductionDate(Date.parse('2026-07-15T05:00:00Z'))).toBe('2026-07-14'); // pre-6am local → prior day
  });

  test('window-averaged bbls/day', () => {
    expect(calculateWindowBblsPerDay(pulls, 20, Date.parse('2026-07-15T18:00:00Z'))).toBe(272);
    expect(calculateWindowBblsPerDay([], 20, Date.now())).toBe(0);
  });

  test('overnight bbls/day (prev-day → first-today)', () => {
    expect(calculateOvernightBblsPerDay(pulls, 20, Date.parse('2026-07-15T12:00:00Z'))).toBe(180);
  });

  test('outgoing 24hr bbls', () => {
    expect(computeBbls24hrs(0.1443, 1)).toBe('139');
    expect(computeBbls24hrs(0, 1)).toBe('0');
  });
});
