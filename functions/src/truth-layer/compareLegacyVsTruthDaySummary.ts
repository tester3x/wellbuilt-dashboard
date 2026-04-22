// Phase 7 — compare a legacy per-driver day summary shape against the truth-
// derived day summary. Pure, deterministic, factual. No silent reconciliation.
// No mutation. If legacy is absent, legacyAvailable=false and comparison is
// a safe empty shape.
import type { DriverDaySummary } from './buildDriverDaySummaryFromTruth';

export interface LegacyDaySummaryLike {
  driverHash?: string;
  displayName?: string;
  shiftStart?: string | null;
  shiftEnd?: string | null;
  hasShiftData?: boolean;
  inferredTimes?: boolean;
  totalLoads?: number;
  totalBBL?: number;
  totalHours?: number;
  driveMinutes?: number;
  onSiteMinutes?: number;
  invoices?: Array<{
    wellName?: string;
    hauledTo?: string;
    commodityType?: string;
    status?: string;
  }>;
  timeline?: Array<{ type?: string }>;
}

export interface LegacyVsTruthComparison {
  legacyAvailable: boolean;
  mismatchFlags: string[];
  notableDifferences: string[];
  raw?: {
    legacy?: LegacyDaySummaryLike;
    truth?: DriverDaySummary;
  };
}

export interface CompareLegacyVsTruthOptions {
  includeRaw?: boolean;
  /** Minutes of slack allowed before flagging a totalActiveMinutes mismatch. */
  activeMinutesTolerance?: number;
  /** Count of locations allowed to differ before flagging. */
  locationCountTolerance?: number;
  /** Count of activities allowed to differ before flagging. */
  activityCountTolerance?: number;
}

const DEFAULTS: Required<Omit<CompareLegacyVsTruthOptions, 'includeRaw'>> = {
  activeMinutesTolerance: 2,
  locationCountTolerance: 0,
  activityCountTolerance: 0,
};

function countLegacyLocations(legacy: LegacyDaySummaryLike): number {
  const set = new Set<string>();
  for (const inv of legacy.invoices ?? []) {
    if (inv.wellName && inv.wellName.trim()) set.add(inv.wellName.trim().toLowerCase());
    if (inv.hauledTo && inv.hauledTo.trim()) set.add(inv.hauledTo.trim().toLowerCase());
  }
  return set.size;
}

function countLegacyActivityLabels(legacy: LegacyDaySummaryLike): number {
  const set = new Set<string>();
  for (const inv of legacy.invoices ?? []) {
    if (inv.commodityType && inv.commodityType.trim()) {
      set.add(inv.commodityType.trim().toLowerCase());
    }
  }
  return set.size;
}

function legacyHasClosedLoad(legacy: LegacyDaySummaryLike): boolean {
  return (legacy.totalLoads ?? 0) > 0;
}

function legacyActiveMinutes(legacy: LegacyDaySummaryLike): number | null {
  // Active minutes — most faithful mapping to the truth layer's sum-of-session-
  // durations is total shift minutes (shiftEnd - shiftStart). The legacy
  // driveMinutes + onSiteMinutes are a DIFFERENT quantity (per-invoice drive +
  // on-site time) and should not be compared as active minutes directly.
  if (!legacy.shiftStart || !legacy.shiftEnd) return null;
  const start = Date.parse(legacy.shiftStart);
  const end = Date.parse(legacy.shiftEnd);
  if (isNaN(start) || isNaN(end) || end < start) return null;
  return Math.round((end - start) / 60000);
}

export function compareLegacyVsTruthDaySummary(
  legacy: LegacyDaySummaryLike | null | undefined,
  truth: DriverDaySummary,
  options: CompareLegacyVsTruthOptions = {}
): LegacyVsTruthComparison {
  const tol = {
    activeMinutesTolerance:
      options.activeMinutesTolerance ?? DEFAULTS.activeMinutesTolerance,
    locationCountTolerance:
      options.locationCountTolerance ?? DEFAULTS.locationCountTolerance,
    activityCountTolerance:
      options.activityCountTolerance ?? DEFAULTS.activityCountTolerance,
  };

  if (!legacy) {
    const out: LegacyVsTruthComparison = {
      legacyAvailable: false,
      mismatchFlags: [],
      notableDifferences: [],
    };
    if (options.includeRaw) out.raw = { truth };
    return out;
  }

  const mismatchFlags: string[] = [];
  const notable: string[] = [];

  // ── session count ────────────────────────────────────────────────────────
  // Legacy surface models one "shift" per driver-day at most; truth layer
  // can model multiple sessions (split shifts). Flag when counts differ.
  const legacySessionCount =
    legacy.shiftStart || legacy.shiftEnd || legacy.hasShiftData ? 1 : 0;
  const truthSessionCount = truth.sessions.length;
  if (legacySessionCount !== truthSessionCount) {
    mismatchFlags.push('sessionCount');
    notable.push(
      `session count: legacy=${legacySessionCount} truth=${truthSessionCount}`
    );
  }

  // ── active minutes ───────────────────────────────────────────────────────
  const legacyMin = legacyActiveMinutes(legacy);
  const truthMin = Math.round(truth.totalActiveMs / 60000);
  if (legacyMin !== null) {
    const delta = Math.abs(legacyMin - truthMin);
    if (delta > tol.activeMinutesTolerance) {
      mismatchFlags.push('activeMinutes');
      notable.push(
        `active minutes: legacy=${legacyMin} truth=${truthMin} (Δ${delta}m)`
      );
    }
  } else {
    // Legacy couldn't compute active minutes — useful signal, not a mismatch.
    notable.push(
      `active minutes: legacy=unknown (no shift bookends) truth=${truthMin}`
    );
  }

  // ── location count ───────────────────────────────────────────────────────
  const legacyLocCount = countLegacyLocations(legacy);
  const truthLocCount = truth.locationsVisited.length;
  if (Math.abs(legacyLocCount - truthLocCount) > tol.locationCountTolerance) {
    mismatchFlags.push('locationCount');
    notable.push(
      `location count: legacy=${legacyLocCount} truth=${truthLocCount}`
    );
  }

  // ── activity labels ──────────────────────────────────────────────────────
  const legacyActCount = countLegacyActivityLabels(legacy);
  const truthActCount = truth.activitiesPerformed.length;
  if (Math.abs(legacyActCount - truthActCount) > tol.activityCountTolerance) {
    mismatchFlags.push('activityLabelCount');
    notable.push(
      `activity label count: legacy=${legacyActCount} truth=${truthActCount}`
    );
  }

  // ── JSA completion ───────────────────────────────────────────────────────
  // Legacy does not track JSA — surface the truth-side signal as a notable
  // difference but do not flag it as a mismatch (no legacy-side value to
  // compare against).
  if (truth.jsa.completed) {
    notable.push(`jsa completed: truth=true (not tracked by legacy)`);
  } else if (truth.jsa.entryCount > 0) {
    notable.push(
      `jsa entries: truth=${truth.jsa.entryCount} completed=false (not tracked by legacy)`
    );
  }

  // ── loads vs events ──────────────────────────────────────────────────────
  // Legacy totalLoads counts closed invoices; truth eventCountsByType includes
  // arrival/pickup/dropoff which are NOT the same quantity. We surface both
  // without flagging — informational only.
  if (legacyHasClosedLoad(legacy) || (truth.eventCountsByType.dropoff ?? 0) > 0) {
    notable.push(
      `loads: legacyClosedLoads=${legacy.totalLoads ?? 0} truthDropoffEvents=${
        truth.eventCountsByType.dropoff ?? 0
      }`
    );
  }

  const out: LegacyVsTruthComparison = {
    legacyAvailable: true,
    mismatchFlags: Array.from(new Set(mismatchFlags)).sort(),
    notableDifferences: notable,
  };
  if (options.includeRaw) {
    out.raw = { legacy, truth };
  }
  return out;
}
