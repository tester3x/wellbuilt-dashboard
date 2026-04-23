/**
 * Phase 23 — pure demo classifier for the public /demo route.
 *
 * Self-contained. Deliberately does NOT import from @/lib/firebase,
 * @/contexts/AuthContext, or the shared truth-layer modules in any
 * form. The /demo page ships as a static HTML shell + minimal client
 * JS that never reaches into production storage, admin callables, or
 * auth-gated surfaces.
 *
 * The real system's classification runs through canonical projection +
 * NDIC / well_config / SWD catalog lookups built up over Phases 11-22.
 * This demo helper approximates the same outputs with lightweight
 * heuristics for illustration purposes only — it is NOT the source of
 * truth for operational classification. If the production SWD seed or
 * NDIC matching rules change, this demo helper may drift until updated;
 * that drift is acceptable because /demo is a marketing/illustration
 * surface, not an operational tool.
 */

export type DemoLocationType = 'well' | 'disposal' | 'custom';
export type DemoConfidence = 'strong' | 'weak';

export interface DemoClassification {
  type: DemoLocationType;
  confidence: DemoConfidence;
  /**
   * Short human-readable explanation suitable for a results card.
   * One of the documented short strings — consumers can assert
   * against these exact phrases in tests.
   */
  explanation: string;
}

/**
 * Frozen copy of the Phase 18/19/20 static SWD seed. If the real seed
 * list in `shared/truth-layer/data/swdReference.ts` grows, mirror the
 * changes here as a separate commit. This demo surface is not wired
 * into the live catalog — intentional isolation per Phase 23 safety
 * spec §6 ("demo uses no production writes / no admin callables").
 */
const DEMO_SWD_SEED: ReadonlyArray<string> = [
  'HYDRO CLEAR SWD 1',
  'CURL 23-14',
  'MAUSER FEDERAL 3-1 8-17H',
  'MAUSER FEDERAL 9-18-17TFH',
  'MORK 24-8',
  'WO WATFORD #1',
];

/**
 * Same normalization as Phase 18's `normalizeLocationNameForOfficialMatch`,
 * re-implemented locally so /demo has zero cross-package imports.
 * Lowercase + trim + strip `- _ . ,` + collapse whitespace + re-trim.
 */
function normalizeDemoName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[-_.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const DEMO_SWD_NORMALIZED_SET: ReadonlySet<string> = new Set(
  DEMO_SWD_SEED.map(normalizeDemoName)
);

/**
 * NDIC-style well name heuristic. Matches the trailing number block
 * NDIC uses for well designations — `1-36-25H`, `9-18-17TFH`,
 * `#1-16-21H`, `3-1 8-17H` (demo note: the final form with an internal
 * space like "3-1 8-17H" won't match; it's rare, and the real system
 * handles it via catalog lookup, not regex).
 *
 * Word-boundary anchored so it doesn't match on unrelated numeric
 * content elsewhere in the string.
 */
const NDIC_STYLE_PATTERN = /\b#?\d+-\d+-\d+[A-Z]{0,4}\b/i;

/**
 * Classify a single demo location. Pure — no I/O, no side effects.
 * Order of checks matches the production read pipeline's priority:
 *   1. SWD reference match → disposal / strong
 *   2. NDIC-style name pattern → well / strong
 *   3. else → custom / weak
 */
export function classifyDemoLocation(
  rawName: string | undefined | null
): DemoClassification {
  if (typeof rawName !== 'string') {
    return {
      type: 'custom',
      confidence: 'weak',
      explanation: 'Custom operational name',
    };
  }
  const name = rawName.trim();
  if (name.length === 0) {
    return {
      type: 'custom',
      confidence: 'weak',
      explanation: 'Custom operational name',
    };
  }
  const normalized = normalizeDemoName(name);
  if (DEMO_SWD_NORMALIZED_SET.has(normalized)) {
    return {
      type: 'disposal',
      confidence: 'strong',
      explanation: 'Matched SWD reference',
    };
  }
  if (NDIC_STYLE_PATTERN.test(name)) {
    return {
      type: 'well',
      confidence: 'strong',
      explanation: 'Matched NDIC pattern',
    };
  }
  return {
    type: 'custom',
    confidence: 'weak',
    explanation: 'Custom operational name',
  };
}

/**
 * Seeded examples shown on the Phase 23 setup step. Each one resolves
 * to a different classification path so the results view immediately
 * demonstrates all three branches:
 *   GABRIEL 1-36-25H  → well (NDIC pattern)
 *   WO WATFORD #1     → disposal (SWD reference)
 *   PAD 354           → custom (no match)
 */
export const DEMO_LOCATION_SEEDS: ReadonlyArray<{
  name: string;
  userDeclaredType: DemoLocationType;
}> = [
  { name: 'GABRIEL 1-36-25H', userDeclaredType: 'well' },
  { name: 'WO WATFORD #1', userDeclaredType: 'disposal' },
  { name: 'PAD 354', userDeclaredType: 'custom' },
];
