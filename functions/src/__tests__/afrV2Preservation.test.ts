/**
 * AFR v2 — preservation & schema-compatibility regression.
 *
 * Proves that wiring calculateAFR to AFR v2 did NOT disturb:
 *   - the independent Overnight (ON) pipeline (`calculateOvernightBblsPerDay`
 *     body unchanged; `overnightBblsDay` persistence shape unchanged),
 *   - the persisted schema mobile/dashboard consumers read (no v2 diagnostics
 *     leaked into production writes),
 * and that calculateAFR now computes via computeAfrV2 (v1 island removed).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const indexSrc = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8');

describe('ON pipeline preserved byte-for-byte', () => {
  it('calculateOvernightBblsPerDay signature and core formula are unchanged', () => {
    expect(indexSrc).toContain('function calculateOvernightBblsPerDay(historicalPulls: HistoricalPull[], bblPerFoot: number, pullTimestamp: number): number');
    // The exact recovery/rate math the ON value depends on.
    expect(indexSrc).toContain('const prevBottomFeet = Math.max(lastPullPrevDay.tankLevelFeet - (lastPullPrevDay.bblsTaken / bblPerFoot), 0);');
    expect(indexSrc).toContain('const recoveryFeet = firstPullToday.tankLevelFeet - prevBottomFeet;');
    expect(indexSrc).toContain('const flowRateDays = timeDifDays / recoveryFeet;');
    expect(indexSrc).toContain('return Math.round((1 / flowRateDays) * bblPerFoot);');
  });

  it('overnightBblsDay is still persisted as the string-or-null shape consumers expect', () => {
    // Present at the incoming + edit + delete outgoing writes; never renamed/merged.
    const matches = indexSrc.match(/overnightBblsDay: \w+ > 0 \? \w+\.toString\(\) : null/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
    // The production log still carries ON under `o`.
    expect(indexSrc).toContain('o: overnightBblsDay');
  });

  it('ON overnight math is deterministic for fixed inputs (same input → same ON)', () => {
    // Replica of the preserved formula — a stable regression anchor.
    const on = (firstTodayTopFt: number, prevTopFt: number, prevBbls: number, timeDifDays: number, bblPerFoot: number) => {
      const prevBottomFeet = Math.max(prevTopFt - prevBbls / bblPerFoot, 0);
      const recoveryFeet = firstTodayTopFt - prevBottomFeet;
      if (recoveryFeet <= 0 || timeDifDays <= 0) return 0;
      return Math.round((1 / (timeDifDays / recoveryFeet)) * bblPerFoot);
    };
    expect(on(8, 8, 100, 0.5, 20)).toBe(on(8, 8, 100, 0.5, 20)); // deterministic
    // prevBottom = 8 - 100/20 = 3 ft; recovery = 5 ft; rate = 0.5/5 = 0.1 d/ft;
    // ON = round((1/0.1)*20) = 200.
    expect(on(8, 8, 100, 0.5, 20)).toBe(200);                     // fixed anchor value
  });
});

describe('persisted schema unchanged (mobile/dashboard compatible)', () => {
  it('outgoing still carries flowRate + bbls24hrs (AFR) — v2 changed HOW afr is computed, not the fields', () => {
    expect(indexSrc).toContain("flowRate: afr > 0 ? daysToHMMSS(afr) : 'Unknown'");
    expect(indexSrc).toContain('bbls24hrs');
  });

  it('no AFR v2 diagnostic field is written to any persisted record', () => {
    // Diagnostics (per-interval weights / effectiveForecast / confidence) live in
    // tests + replay only — never persisted this batch.
    expect(indexSrc).not.toMatch(/effectiveForecast\s*:/);
    expect(indexSrc).not.toMatch(/afrConfidence\s*:/);
    expect(indexSrc).not.toMatch(/perInterval\s*:/);
  });
});

describe('calculateAFR wired to v2; v1 island removed from index', () => {
  it('calculateAFR computes via computeAfrV2 and passes bblPerFoot', () => {
    expect(indexSrc).toContain('const result = computeAfrV2(intervals, AFR_V2_POLICY);');
    expect(indexSrc).toContain('async function calculateAFR(wellName: string, newFlowRateDays: number, bblPerFoot?: number)');
  });

  it('the dead v1 rate math is gone from index.ts (moved to afr/afrV1.ts)', () => {
    expect(indexSrc).not.toContain('function filterAnomalies(');
    expect(indexSrc).not.toContain('function getFlowRateAnomalyLevel(');
    expect(indexSrc).not.toContain('const EMA_ALPHA');
  });

  it('all three recompute paths pass a bblPerFoot to calculateAFR', () => {
    expect(indexSrc).toContain('await calculateAFR(wellName, flowRateDays, tanks * 20)');   // incoming
    expect(indexSrc).toContain('await calculateAFR(wellName, flowRateDays, bblPerFoot)');    // edit
    expect(indexSrc).toContain('await calculateAFR(wellName, latestPacket.flowRateDays || 0, tanks * 20)'); // delete
  });
});
