import { readFileSync } from 'fs';
import { join } from 'path';
import {
  calcTankAtInches,
  calcTimeTillPull,
  estimateInchesFromPostPull,
  inchesToFeetInches,
  parseFeetInches,
  postPullInchesFromTop,
} from '../../../../src/lib/wellLevelEstimate';

const root = join(__dirname, '../../../..');

/** Sanitized Gabriel 1–7 packet/config shapes from live outgoing 2026-08-20 (no PII). */
const GABRIELS = [
  { well: 'Gabriel 1', top: '9\'7"', bottom: '2\'7"', bbls: 140, afr: 360.56, utc: '2026-08-20T17:42:02.991Z', displayed: '2\'7"' },
  { well: 'Gabriel 2', top: '9\'9"', bottom: '2\'9"', bbls: 140, afr: 582.48, utc: '2026-08-20T16:18:12.094Z', displayed: '2\'9"' },
  { well: 'Gabriel 3', top: '4\'8"', bottom: '4\'8"', bbls: 0, afr: 1019.44, utc: '2026-08-20T14:53:27.213Z', displayed: '4\'8"' },
  { well: 'Gabriel 4', top: '10\'4"', bottom: '3\'4"', bbls: 140, afr: 213.82, utc: '2026-08-20T20:13:11.604Z', displayed: '3\'4"' },
  { well: 'Gabriel 5', top: '11\'4"', bottom: '4\'4"', bbls: 140, afr: 194.01, utc: '2026-08-20T20:14:45.563Z', displayed: '4\'4"' },
  { well: 'Gabriel 6', top: '9\'11"', bottom: '2\'11"', bbls: 140, afr: 307.39, utc: '2026-08-20T13:15:59.020Z', displayed: '2\'11"' },
  { well: 'Gabriel 7', top: '9\'5"', bottom: '2\'5"', bbls: 140, afr: 194.41, utc: '2026-08-20T14:51:04.201Z', displayed: '2\'5"' },
] as const;

const OBSERVED_AT = Date.parse('2026-08-21T17:00:00.000Z');

describe('Gabriel tank-math regression (catalog estimate, not packet rewrite)', () => {
  it('packet post-pull bottoms match top − (BBL / 20 bbl/ft) and are not double-subtracted', () => {
    for (const g of GABRIELS) {
      const packetBottom = postPullInchesFromTop({
        topLevel: g.top,
        bblsPulled: g.bbls,
        tanks: 1,
        bblPerFootPerTank: 20,
      });
      expect(Math.round(packetBottom)).toBe(parseFeetInches(g.bottom));
      expect(g.displayed).toBe(g.bottom);
    }
  });

  it('zero-BBL Gabriel 3 does not treat the reading as a pre-pull top', () => {
    const g3 = GABRIELS[2];
    expect(g3.top).toBe(g3.bottom);
    expect(postPullInchesFromTop({
      topLevel: g3.top, bblsPulled: 0, tanks: 1, bblPerFootPerTank: 20,
    })).toBe(parseFeetInches(g3.bottom));
  });

  it('displayed frozen currentLevel equals lastPullBottom; estimate adds AFR rise once', () => {
    const g1 = GABRIELS[0];
    const frozen = parseFeetInches(g1.displayed);
    const est = estimateInchesFromPostPull({
      postPullLevel: g1.bottom,
      lastPullUtc: g1.utc,
      avgFlowRateMinutes: g1.afr,
      nowMs: OBSERVED_AT,
    });
    expect(est).not.toBeNull();
    expect(frozen).toBe(31);
    expect(est!).toBeGreaterThan(frozen);
    // Before: Dashboard showed 2'7". After: post-pull + elapsed/AFR.
    const minutesElapsed = (OBSERVED_AT - Date.parse(g1.utc)) / 60000;
    const expected = 31 + minutesElapsed / (g1.afr / 12);
    expect(est).toBeCloseTo(expected, 6);
    expect(inchesToFeetInches(est!)).not.toBe(g1.displayed);
  });

  it('does not subtract pulled volume a second time from the post-pull bottom', () => {
    const g1 = GABRIELS[0];
    const wrongDoubleSub = parseFeetInches(g1.bottom) - (140 / 20) * 12;
    const est = estimateInchesFromPostPull({
      postPullLevel: g1.bottom,
      lastPullUtc: g1.utc,
      avgFlowRateMinutes: g1.afr,
      nowMs: OBSERVED_AT,
    })!;
    expect(est).toBeGreaterThan(parseFeetInches(g1.bottom));
    expect(est).not.toBeCloseTo(wrongDoubleSub, 0);
  });

  it('time-till-pull uses estimated current inches, not frozen outgoing.timeTillPull', () => {
    const target = calcTankAtInches(1, 140, 3 * 12, 20);
    const g1 = GABRIELS[0];
    const est = estimateInchesFromPostPull({
      postPullLevel: g1.bottom,
      lastPullUtc: g1.utc,
      avgFlowRateMinutes: g1.afr,
      nowMs: OBSERVED_AT,
    })!;
    const till = calcTimeTillPull(est, target, g1.afr);
    expect(till).not.toBe('44:34');
    expect(till === 'Ready' || /\d/.test(till)).toBe(true);
  });

  it('mergeWellPool catalog path consumes the estimator (Dashboard-only fix)', () => {
    const wells = readFileSync(join(root, 'src/lib/wells.ts'), 'utf8');
    expect(wells).toContain('estimateInchesFromPostPull');
    expect(wells).toContain('lastPullBottomLevel');
    expect(wells).toContain('avgFlowRateMinutes');
    expect(wells).toMatch(/frozen post-pull bottom/);
  });
});
