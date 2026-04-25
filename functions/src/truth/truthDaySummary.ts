import * as httpsV2 from 'firebase-functions/v2/https';
import { HttpsError } from 'firebase-functions/v2/https';
import type {
  CanonicalProjection,
  OperatorCanonicalView,
} from '../truth-layer/types.canonical';
import type { TruthProjection, ReportingWindow } from '../truth-layer/types';
import type { ValidationWarning } from '../truth-layer/validateProjection';
import {
  buildCanonicalLocationIndex,
  buildCanonicalProjection,
  buildDriverDaySummaryFromTruth,
  buildTruthProjection,
  getIdentityConfidence,
  getSourceIdentities,
  lookupCanonicalLocation,
  validateProjection,
} from '../truth-layer';
import type {
  IdentityConfidence,
  SourceIdentities,
} from '../truth-layer/canonicalIdentity';
import type {
  CanonicalLocationIndex,
  CanonicalLocationIndexEntry,
} from '../truth-layer/canonicalLocationIdentity';
import { requireAdminRole } from './requireAdminRole';
import { loadTruthInputForDay } from './loadTruthInputForDay';

// ── Request / response shapes ───────────────────────────────────────────────
interface RawRequest {
  date?: string;
  /** Preferred: a raw operator key (e.g. "op:abc123def456") */
  operatorKey?: string;
  /** Legacy-friendly: a driver hash (as used by src/lib/driverLogs.ts) */
  driverHash?: string;
  companyId?: string;
}

interface ParsedRequest {
  date: string;
  operatorKey?: string;
  driverHash?: string;
  companyId?: string;
}

function parseRequest(data: unknown): ParsedRequest {
  const req = (data ?? {}) as RawRequest;
  if (typeof req.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(req.date)) {
    throw new HttpsError('invalid-argument', 'Missing/invalid date (YYYY-MM-DD).');
  }
  if (
    (typeof req.operatorKey !== 'string' || req.operatorKey.length === 0) &&
    (typeof req.driverHash !== 'string' || req.driverHash.length === 0)
  ) {
    throw new HttpsError(
      'invalid-argument',
      'Provide operatorKey or driverHash.'
    );
  }
  const out: ParsedRequest = { date: req.date };
  if (typeof req.operatorKey === 'string' && req.operatorKey.length > 0) {
    out.operatorKey = req.operatorKey;
  }
  if (typeof req.driverHash === 'string' && req.driverHash.length > 0) {
    out.driverHash = req.driverHash;
  }
  if (typeof req.companyId === 'string' && req.companyId.length > 0) {
    out.companyId = req.companyId;
  }
  return out;
}

/**
 * Resolve the truth-layer operator key to query. Accepts either a pre-formed
 * operatorKey or a legacy driverHash, then falls back to the canonical
 * projection if the raw key has been merged.
 */
function resolveOperator(
  projection: TruthProjection,
  canonical: CanonicalProjection,
  req: ParsedRequest
): {
  rawOperatorKey?: string;
  canonicalOperatorKey?: string;
  displayName?: string;
  linkedKeys: string[];
  identityConfidence?: IdentityConfidence;
  sourceIdentities?: SourceIdentities;
} {
  // 1. Try the explicit operatorKey; if it's a canonical key, it may appear
  //    in a canonical linkedKeys list.
  // 2. Else build `op:${driverHash}` (the convention used by extractOperationalEvents).
  const candidates: string[] = [];
  if (req.operatorKey) candidates.push(req.operatorKey);
  if (req.driverHash) candidates.push(`op:${req.driverHash}`);

  // Prefer the first candidate that appears in the raw projection.
  let rawOperatorKey: string | undefined;
  for (const c of candidates) {
    if (projection.operators.some((o) => o.operatorKey === c)) {
      rawOperatorKey = c;
      break;
    }
  }
  if (!rawOperatorKey && candidates.length > 0) {
    rawOperatorKey = candidates[0];
  }

  let canonicalView: OperatorCanonicalView | undefined;
  if (rawOperatorKey) {
    canonicalView = canonical.canonicalOperators.find((op) =>
      op.linkedKeys.includes(rawOperatorKey as string)
    );
  }
  if (!canonicalView && req.operatorKey) {
    canonicalView = canonical.canonicalOperators.find(
      (op) => op.canonicalOperatorKey === req.operatorKey
    );
  }

  const linkedKeys = canonicalView?.linkedKeys ?? (
    rawOperatorKey ? [rawOperatorKey] : []
  );
  const displayName =
    canonicalView?.displayName ??
    canonicalView?.legalName ??
    projection.operators.find((o) => o.operatorKey === rawOperatorKey)?.displayName;

  const out: {
    rawOperatorKey?: string;
    canonicalOperatorKey?: string;
    displayName?: string;
    linkedKeys: string[];
    identityConfidence?: IdentityConfidence;
    sourceIdentities?: SourceIdentities;
  } = { linkedKeys };
  if (rawOperatorKey !== undefined) out.rawOperatorKey = rawOperatorKey;
  if (canonicalView) {
    out.canonicalOperatorKey = canonicalView.canonicalOperatorKey;
    // Phase 9 — first-class identity signals on the returned operator block.
    out.identityConfidence = getIdentityConfidence(canonicalView);
    out.sourceIdentities = getSourceIdentities(canonicalView);
  }
  if (displayName !== undefined) out.displayName = displayName;
  return out;
}

/** Find the reporting windows that cover this date, by kind. */
function datesContextFromWindows(
  date: string,
  windows: ReportingWindow[]
): {
  localWindow?: { startsAt: string; endsAt: string; timezone: string };
  utcWindow?: { startsAt: string; endsAt: string };
  productionWindow?: { startsAt: string; endsAt: string; timezone: string };
} {
  const out: ReturnType<typeof datesContextFromWindows> = {};
  const match = (kind: ReportingWindow['kind']) =>
    windows.find(
      (w) =>
        w.kind === kind &&
        w.startsAt.slice(0, 10) <= date &&
        date <= w.endsAt.slice(0, 10)
    );
  const localW = match('local_day');
  if (localW) {
    out.localWindow = {
      startsAt: localW.startsAt,
      endsAt: localW.endsAt,
      timezone: localW.timezone,
    };
  }
  const utcW = match('utc_day');
  if (utcW) {
    out.utcWindow = { startsAt: utcW.startsAt, endsAt: utcW.endsAt };
  }
  const prodW = match('production_day_6am');
  if (prodW) {
    out.productionWindow = {
      startsAt: prodW.startsAt,
      endsAt: prodW.endsAt,
      timezone: prodW.timezone,
    };
  }
  return out;
}

/**
 * Phase 11 — decorate each day-summary location entry with canonical-location
 * identity signals. Preserves every existing field (locationKey,
 * preferredName, kind, eventCount). Only adds fields when resolvable — never
 * invents official backing for custom/fallback locations.
 */
interface EnrichedLocationEntry {
  locationKey: string;
  preferredName: string;
  kind?: string;
  eventCount: number;
  canonicalLocationKey?: string;
  rawLocationKey?: string;
  locationDisplayName?: string;
  locationConfidence?: CanonicalLocationIndexEntry['confidence'];
  locationSourceKinds?: CanonicalLocationIndexEntry['sourceKinds'];
  aliases?: string[];
}

function enrichLocationsVisited(
  locationsVisited: Array<{
    locationKey: string;
    preferredName: string;
    kind?: string;
    eventCount: number;
  }>,
  index: CanonicalLocationIndex
): EnrichedLocationEntry[] {
  return locationsVisited.map((l) => {
    const base: EnrichedLocationEntry = {
      locationKey: l.locationKey,
      preferredName: l.preferredName,
      eventCount: l.eventCount,
    };
    if (l.kind !== undefined) base.kind = l.kind;
    const resolved = lookupCanonicalLocation(l.locationKey, index);
    if (!resolved) return base;
    base.rawLocationKey = l.locationKey;
    base.canonicalLocationKey = resolved.canonicalLocationKey;
    base.locationDisplayName = resolved.entry.preferredName;
    base.locationConfidence = resolved.entry.confidence;
    base.locationSourceKinds = resolved.entry.sourceKinds;
    if (resolved.entry.aliases.length > 0) {
      base.aliases = resolved.entry.aliases;
    }
    return base;
  });
}

/**
 * Filter validation warnings to those whose subject touches the given
 * operator (raw or linked canonical keys). Preserves warnings unchanged.
 */
function filterWarningsForOperator(
  warnings: ValidationWarning[],
  linkedKeys: string[]
): ValidationWarning[] {
  if (linkedKeys.length === 0) return warnings;
  const set = new Set(linkedKeys);
  return warnings.filter((w) => {
    const s = w.subject ?? {};
    const candidates = [s.operatorKey, s.strongKey, s.weakKey];
    for (const c of candidates) {
      if (typeof c === 'string' && set.has(c)) return true;
    }
    // Keep warnings that don't carry an operator subject at all — they're
    // visible across the whole day and shouldn't be hidden per-driver.
    if (!s.operatorKey && !s.strongKey && !s.weakKey) return true;
    return false;
  });
}

// ── Callable ────────────────────────────────────────────────────────────────

export const getTruthDriverDaySummary = httpsV2.onCall(
  { timeoutSeconds: 120, memory: '512MiB' },
  async (request) => {
    const identity = await requireAdminRole(request);
    const parsed = parseRequest(request.data);
    const companyScope = parsed.companyId ?? identity.companyId;

    const loadParams: { date: string; companyId?: string } = { date: parsed.date };
    if (companyScope) loadParams.companyId = companyScope;
    const { input, sourceErrors, loaded } = await loadTruthInputForDay(loadParams);

    const projection = buildTruthProjection(input);
    const canonical = buildCanonicalProjection(projection);
    const warnings = validateProjection(projection);

    const operator = resolveOperator(projection, canonical, parsed);
    const daySummaryKey = operator.rawOperatorKey ?? operator.canonicalOperatorKey;
    if (!daySummaryKey) {
      throw new HttpsError(
        'not-found',
        'Could not resolve an operator key from request.'
      );
    }
    // Phase 26 — pass the full set of linked raw keys (when available) so
    // events extracted under name-only raw keys (e.g. invoices with no
    // driverHash) attribute to the same canonical day summary as events
    // under the hash-backed raw key. Falls back to the single resolved key
    // if the operator has no linked-keys set.
    const daySummaryKeys: string | readonly string[] =
      operator.linkedKeys && operator.linkedKeys.length > 0
        ? operator.linkedKeys
        : daySummaryKey;
    const daySummary = buildDriverDaySummaryFromTruth(projection, daySummaryKeys);

    const dateContext: Record<string, unknown> = { requestedDate: parsed.date };
    const windows = datesContextFromWindows(parsed.date, projection.reportingWindows);
    if (windows.localWindow) dateContext.localWindow = windows.localWindow;
    if (windows.utcWindow) dateContext.utcWindow = windows.utcWindow;
    if (windows.productionWindow) dateContext.productionWindow = windows.productionWindow;

    const operatorWarnings = filterWarningsForOperator(
      warnings,
      operator.linkedKeys
    );
    const locationIndex = buildCanonicalLocationIndex(canonical);
    const enrichedLocations = enrichLocationsVisited(
      daySummary.locationsVisited,
      locationIndex
    );

    return {
      generatedAt: new Date().toISOString(),
      operator,
      dateContext,
      summary: {
        found: daySummary.found,
        sessions: daySummary.sessions,
        totalActiveMinutes: Math.round(daySummary.totalActiveMs / 60000),
        locationsVisited: enrichedLocations,
        activitiesPerformed: daySummary.activitiesPerformed,
        jsaCompleted: daySummary.jsa.completed,
        jsa: daySummary.jsa,
        eventCounts: daySummary.eventCountsByType,
      },
      warnings: operatorWarnings,
      loaded,
      sourceErrors,
    };
  }
);
