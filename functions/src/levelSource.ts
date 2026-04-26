// levelSource.ts — SCADA foundation, Phase 1 (metadata only).
//
// Tracks how a tank-level number was acquired so the system can
// differentiate driver-gauged readings, SCADA-screen reads, and (future)
// direct SCADA API ingestion. Phase 1 only adds optional metadata; no
// math, no UI, no behavior change.
//
// Identical copy lives in wellbuilt-tickets/utils/, wellbuilt-mobile/src/services/,
// and wellbuilt-dashboard/src/lib/. If you change this file, sync all 4 —
// divergence breaks the SCADA pipeline silently.
//
// Default for missing/legacy/unknown = 'manual_gauge'. Never throws.

export type LevelSource = 'manual_gauge' | 'scada_screen' | 'scada_api_future';

const VALID: LevelSource[] = ['manual_gauge', 'scada_screen', 'scada_api_future'];

/**
 * Coerce any value into a valid LevelSource. Old records without the
 * field, nulls, undefineds, mistyped strings, and non-string types all
 * return 'manual_gauge'. Never throws.
 */
export function normalizeLevelSource(value: unknown): LevelSource {
  if (typeof value !== 'string') return 'manual_gauge';
  if ((VALID as string[]).includes(value)) return value as LevelSource;
  return 'manual_gauge';
}
