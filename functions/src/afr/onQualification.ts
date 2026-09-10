/**
 * ON qualification — a SEPARATE consumer built AROUND the preserved
 * `calculateOvernightBblsPerDay` output (which is untouched). It decides whether
 * an Overnight value is trustworthy enough to be consumed by an effective
 * forecast: valid chronological coverage, not dominated by duplicate, short-gap,
 * late, or invalid pull pairs, and the ON-defining overnight pair itself valid.
 *
 * This does NOT modify or replace the ON value. It is not currently wired to any
 * washout window (no explicit event source exists); it is provided and tested so
 * an event-anchored effective forecast can consume it once event capture lands.
 */
import type { AfrInterval } from './afrTypes';
import type { AfrV2Policy } from './afrV2Policy';
import { decideValidity } from './validity';

export interface OnQualification {
  qualified: boolean;
  validFraction: number;
  reasons: string[];
}

/**
 * @param overnightPairInterval the interval representing the overnight pair the
 *        ON was derived from (prev-day pull → first-today pull), or null.
 * @param coverage the surrounding intervals in the ON's coverage window.
 */
export function qualifyOvernight(
  overnightPairInterval: AfrInterval | null,
  coverage: AfrInterval[],
  policy: AfrV2Policy,
  minValidFraction = 0.5,
): OnQualification {
  const reasons: string[] = [];

  if (!overnightPairInterval) {
    return { qualified: false, validFraction: 0, reasons: ['no_overnight_pair'] };
  }
  const pairVerdict = decideValidity(overnightPairInterval, policy);
  if (!pairVerdict.valid) {
    reasons.push(`overnight_pair_${pairVerdict.reason}`);
  }

  const total = coverage.length;
  const validCount = coverage.filter((iv) => decideValidity(iv, policy).valid).length;
  const validFraction = total > 0 ? validCount / total : 0;
  if (total > 0 && validFraction < minValidFraction) {
    reasons.push('dominated_by_invalid_or_degenerate_pairs');
  }

  // Chronological coverage: timestamps strictly increasing (no out-of-order /
  // duplicate-key coverage that would make the overnight boundary ambiguous).
  let chronological = true;
  for (let i = 1; i < coverage.length; i++) {
    if (!(coverage[i].timestamp > coverage[i - 1].timestamp)) { chronological = false; break; }
  }
  if (!chronological) reasons.push('non_chronological_coverage');

  const qualified = pairVerdict.valid && (total === 0 || validFraction >= minValidFraction) && chronological;
  return { qualified, validFraction, reasons };
}
