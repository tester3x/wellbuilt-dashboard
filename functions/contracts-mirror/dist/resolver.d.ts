/**
 * Canonical work-period resolver (vc51.9A) — pure, deterministic, shared.
 *
 * Every consumer calls THIS function so WB-S, WB-T and WB-JSA can never
 * disagree about which period a driver is in (the 8/6 field failure was
 * exactly that disagreement: WB-JSA held a closed shift while WB-T fell
 * back to a UTC date).
 *
 * Hard rules encoded here:
 *   - local cache and deep links are HINTS; only fetched authoritative
 *     day documents establish an explicit shift;
 *   - a closed or superseded explicit shift never becomes current again;
 *   - "last known shift" is never returned after resolution fails —
 *     failure surfaces as UNVERIFIED_OFFLINE;
 *   - derived periods come from the company's IANA timezone and schedule,
 *     never from a UTC-date fallback;
 *   - missing/invalid configuration fails honestly.
 *
 * Timezone math uses ECMA-402 Intl with a real IANA zone. DST is handled
 * by resolving the local wall time twice against the zone's offset; the
 * documented edge behavior is: a spring-forward nonexistent local time
 * resolves forward past the gap, and a fall-back ambiguous local time
 * resolves to its FIRST (pre-transition) occurrence.
 */
import { type ResolveInput, type WorkPeriodResolution } from './types.js';
/** Zone offset in minutes at a given UTC instant (positive = east of UTC). */
export declare function zoneOffsetMinutes(timezone: string, utcMs: number): number;
export declare function isValidTimezone(timezone: string | undefined): boolean;
/** Local calendar date 'YYYY-MM-DD' in `timezone` at `utcMs`. */
export declare function localDateInZone(timezone: string, utcMs: number): string;
/** UTC instant for a local wall time in `timezone` (two-pass, DST-aware). */
export declare function zonedWallTimeToUtcMs(timezone: string, localDate: string, localTime: string): number;
export declare function resolveWorkPeriod(input: ResolveInput): WorkPeriodResolution;
//# sourceMappingURL=resolver.d.ts.map