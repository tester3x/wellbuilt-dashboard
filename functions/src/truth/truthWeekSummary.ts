/**
 * Phase 27 — Operator Weekly Summary callable.
 *
 * Read-only, admin-gated. Produces a 7-day summary for a single operator,
 * using the Phase 26 canonical operator identity so invoice-derived events
 * (tagged under the name-only raw key) unify with hash-backed events.
 *
 * Week definition (Phase 27 v1):
 *   - Input `weekStart` optional, YYYY-MM-DD. If omitted, we anchor to the
 *     current date in the requested `timezone` and roll back to the most
 *     recent Monday (Monday-Sunday ISO week).
 *   - The 7 day-keys are simple calendar dates in the requested timezone.
 *     Daily loaders are UTC-windowed (matching the existing day callable);
 *     consumers should treat week boundaries as calendar-local. Cross-
 *     timezone edge cases (shifts that span midnight local) are the same
 *     as in the day callable — out of scope for Phase 27.
 *
 * Does NOT write. Does NOT deploy (registered via index.ts so the
 * functions build; deployment is a separate explicit action).
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  buildCanonicalProjection,
  buildDriverWeekSummary,
  buildTruthProjection,
  validateProjection,
} from '../truth-layer';
import type { OperatorCanonicalView } from '../truth-layer/types.canonical';
import type { TruthProjection } from '../truth-layer/types';
import type { WeekDayInput } from '../truth-layer/buildDriverWeekSummary';
import type { InvoiceInput } from '../truth-layer/extractOperationalEvents';
import type { BuildTruthProjectionInput } from '../truth-layer/buildTruthProjection';
import { requireAdminRole } from './requireAdminRole';
import { loadTruthInputForDay } from './loadTruthInputForDay';

// ── Request parsing ─────────────────────────────────────────────────────
interface RawRequest {
  /** Canonical or raw operator key, e.g. "op:abc…" or "op-name:mike". */
  operatorKey?: string;
  /** Legacy-friendly — resolves to `op:${driverHash}`. */
  driverHash?: string;
  /** Free-text name search. Matched against drivers/approved displayName
   *  and legalName, case-insensitive substring. Ambiguous results return
   *  a safe candidate list instead of a summary. */
  operatorSearch?: string;
  /** YYYY-MM-DD — first day of the week window. Optional; if absent we
   *  derive Monday of the current ISO week in `timezone`. */
  weekStart?: string;
  /** IANA timezone identifier. Default 'America/Denver' (Mountain — the
   *  WellBuilt operational timezone). */
  timezone?: string;
  companyId?: string;
}

interface ParsedRequest {
  operatorKey?: string;
  driverHash?: string;
  operatorSearch?: string;
  weekStart?: string;
  timezone: string;
  companyId?: string;
}

function parseRequest(data: unknown): ParsedRequest {
  const req = (data ?? {}) as RawRequest;
  const timezone =
    typeof req.timezone === 'string' && req.timezone.trim().length > 0
      ? req.timezone.trim()
      : 'America/Denver';
  if (
    req.weekStart !== undefined &&
    (typeof req.weekStart !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(req.weekStart))
  ) {
    throw new HttpsError(
      'invalid-argument',
      'weekStart must be YYYY-MM-DD if provided.'
    );
  }
  if (
    (typeof req.operatorKey !== 'string' || req.operatorKey.length === 0) &&
    (typeof req.driverHash !== 'string' || req.driverHash.length === 0) &&
    (typeof req.operatorSearch !== 'string' || req.operatorSearch.length === 0)
  ) {
    throw new HttpsError(
      'invalid-argument',
      'Provide operatorKey, driverHash, or operatorSearch.'
    );
  }
  const out: ParsedRequest = { timezone };
  if (typeof req.operatorKey === 'string' && req.operatorKey.length > 0)
    out.operatorKey = req.operatorKey;
  if (typeof req.driverHash === 'string' && req.driverHash.length > 0)
    out.driverHash = req.driverHash;
  if (typeof req.operatorSearch === 'string' && req.operatorSearch.length > 0)
    out.operatorSearch = req.operatorSearch;
  if (typeof req.weekStart === 'string') out.weekStart = req.weekStart;
  if (typeof req.companyId === 'string' && req.companyId.length > 0)
    out.companyId = req.companyId;
  return out;
}

// ── Week boundary helper ────────────────────────────────────────────────

/**
 * Returns YYYY-MM-DD for "now" in the given IANA timezone. Uses
 * Intl.DateTimeFormat since Node 16+ supports it with full tz db.
 */
function todayInTimezone(timezone: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date());
}

/** Given a YYYY-MM-DD, return the Monday of that ISO week in YYYY-MM-DD. */
function mondayOfWeek(dateStr: string): string {
  // Parse as UTC midnight so weekday math is deterministic.
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  const dow = d.getUTCDay(); // 0 = Sunday, 1 = Monday, …
  const shift = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + shift);
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── Operator resolution ─────────────────────────────────────────────────

interface ResolvedOperator {
  linkedKeys: string[];
  canonicalView?: OperatorCanonicalView;
  rawOperatorKey?: string;
}

function resolveOperatorFromProjection(
  projection: TruthProjection,
  canonicalOps: OperatorCanonicalView[],
  req: ParsedRequest
): ResolvedOperator | { ambiguous: true; candidates: Array<{
  canonicalOperatorKey: string;
  displayName?: string;
  legalName?: string;
  hasHash: boolean;
}> } {
  const explicitKeys: string[] = [];
  if (req.operatorKey) explicitKeys.push(req.operatorKey);
  if (req.driverHash) explicitKeys.push(`op:${req.driverHash}`);

  // Direct key match
  for (const k of explicitKeys) {
    const view = canonicalOps.find(
      (v) => v.canonicalOperatorKey === k || v.linkedKeys.includes(k)
    );
    if (view) {
      return { linkedKeys: view.linkedKeys, canonicalView: view, rawOperatorKey: k };
    }
  }
  if (explicitKeys.length > 0) {
    // Explicit key was given but not found in this week's projection. Fall
    // through to a minimal linked-keys group so the caller still gets an
    // empty-but-structured summary — distinguishable by canonicalView=undef.
    return { linkedKeys: explicitKeys };
  }

  // operatorSearch: case-insensitive substring match on displayName/legalName
  const needle = (req.operatorSearch ?? '').toLowerCase().trim();
  if (!needle) {
    throw new HttpsError(
      'invalid-argument',
      'Internal parseRequest bug: reached search branch with empty needle.'
    );
  }
  const matches = canonicalOps.filter((v) => {
    const dn = (v.displayName ?? '').toLowerCase();
    const ln = (v.legalName ?? '').toLowerCase();
    return dn.includes(needle) || ln.includes(needle);
  });
  if (matches.length === 0) {
    throw new HttpsError(
      'not-found',
      `No operator matched search "${req.operatorSearch}".`
    );
  }
  if (matches.length > 1) {
    return {
      ambiguous: true,
      candidates: matches.slice(0, 20).map((v) => {
        const out: {
          canonicalOperatorKey: string;
          displayName?: string;
          legalName?: string;
          hasHash: boolean;
        } = {
          canonicalOperatorKey: v.canonicalOperatorKey,
          hasHash: v.canonicalOperatorKey.startsWith('op:'),
        };
        if (v.displayName) out.displayName = v.displayName;
        if (v.legalName) out.legalName = v.legalName;
        return out;
      }),
    };
  }
  const only = matches[0]!;
  return { linkedKeys: only.linkedKeys, canonicalView: only };
}

// ── Callable ────────────────────────────────────────────────────────────

export const getTruthDriverWeekSummary = httpsV2.onCall(
  { timeoutSeconds: 240, memory: '1GiB' },
  async (request) => {
    const identity = await requireAdminRole(request);
    const parsed = parseRequest(request.data);
    const companyScope = parsed.companyId ?? identity.companyId;

    // Derive week boundaries.
    const effectiveWeekStart =
      parsed.weekStart ?? mondayOfWeek(todayInTimezone(parsed.timezone));
    const weekStart = mondayOfWeek(effectiveWeekStart);
    const dayKeys: string[] = [];
    for (let i = 0; i < 7; i++) dayKeys.push(addDays(weekStart, i));
    const weekEnd = dayKeys[6]!;

    // Load all 7 days. Parallelize — loaders are independent.
    const sourceErrorsByDay: Record<string, string[]> = {};
    const loadedByDay: Record<string, Record<string, unknown>> = {};
    const loaded = await Promise.all(
      dayKeys.map(async (date) => {
        const loadParams: { date: string; companyId?: string } = { date };
        if (companyScope) loadParams.companyId = companyScope;
        const res = await loadTruthInputForDay(loadParams);
        sourceErrorsByDay[date] = res.sourceErrors;
        loadedByDay[date] = res.loaded as unknown as Record<string, unknown>;
        return { date, input: res.input };
      })
    );

    // Build a union projection solely for operator resolution (so name-only
    // refs from any day's invoices union with hash-backed refs from any other
    // day's shifts/JSAs via the Phase 26 bridge).
    const unionInput: BuildTruthProjectionInput = {};
    const mergedDrivers: unknown[] = [];
    const mergedShifts: unknown[] = [];
    const mergedInvoices: unknown[] = [];
    const mergedDispatches: unknown[] = [];
    const mergedJsas: unknown[] = [];
    for (const { input } of loaded) {
      if (input.drivers) mergedDrivers.push(...input.drivers);
      if (input.shifts) mergedShifts.push(...input.shifts);
      if (input.invoices) mergedInvoices.push(...input.invoices);
      if (input.dispatches) mergedDispatches.push(...input.dispatches);
      if (input.jsas) mergedJsas.push(...input.jsas);
    }
    if (mergedDrivers.length) unionInput.drivers = mergedDrivers;
    if (mergedShifts.length)
      unionInput.shifts = mergedShifts as BuildTruthProjectionInput['shifts'];
    if (mergedInvoices.length)
      unionInput.invoices =
        mergedInvoices as BuildTruthProjectionInput['invoices'];
    if (mergedDispatches.length)
      unionInput.dispatches =
        mergedDispatches as BuildTruthProjectionInput['dispatches'];
    if (mergedJsas.length)
      unionInput.jsas = mergedJsas as BuildTruthProjectionInput['jsas'];
    const unionProjection = buildTruthProjection(unionInput);
    const unionCanonical = buildCanonicalProjection(unionProjection);

    const resolved = resolveOperatorFromProjection(
      unionProjection,
      unionCanonical.canonicalOperators,
      parsed
    );
    if ('ambiguous' in resolved) {
      return {
        status: 'ambiguous',
        query: { operatorSearch: parsed.operatorSearch ?? null },
        candidates: resolved.candidates,
      };
    }

    // Build per-day view using the resolved linkedKeys.
    const days: WeekDayInput[] = loaded.map(({ date, input }) => {
      const projection = buildTruthProjection(input);
      const canonical = buildCanonicalProjection(projection);
      const warnings = validateProjection(projection);
      const linkedSet = new Set(resolved.linkedKeys);
      const relevantWarnings = warnings.filter((w) => {
        const s = w.subject ?? {};
        const candidates = [s.operatorKey, s.strongKey, s.weakKey];
        for (const c of candidates)
          if (typeof c === 'string' && linkedSet.has(c)) return true;
        return false;
      });
      const invoices = (input.invoices ?? []) as InvoiceInput[];
      const row: WeekDayInput = { date, projection, canonical, invoices };
      if (relevantWarnings.length > 0) row.warnings = relevantWarnings;
      return row;
    });

    const weekSummaryInput: Parameters<typeof buildDriverWeekSummary>[0] = {
      operatorLinkedKeys: resolved.linkedKeys,
      week: {
        startDate: weekStart,
        endDate: weekEnd,
        timezone: parsed.timezone,
        dayKeys,
      },
      days,
    };
    if (resolved.canonicalView) weekSummaryInput.canonicalView = resolved.canonicalView;
    const summary = buildDriverWeekSummary(weekSummaryInput);

    return {
      status: 'ok',
      ...summary,
      loadedByDay,
      sourceErrorsByDay,
    };
  }
);
