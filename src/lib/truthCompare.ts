// Phase 7 — client-side legacy-vs-truth day summary comparison.
//
// KEEP IN SYNC WITH:
//   C:/dev/claude-home/shared/truth-layer/compareLegacyVsTruthDaySummary.ts
//
// This file deliberately does NOT import from the truth-layer package — the
// dashboard has no dep on it. The logic here mirrors the canonical helper
// (tested in vitest) applied to the callable's response shape.

import type { DriverDayLog } from './driverLogs';

export type OperatorIdentityConfidence = 'strong' | 'weak';

export interface OperatorSourceIdentities {
  hasHash?: boolean;
  hasUid?: boolean;
  hasNameOnly?: boolean;
}

/** Shape returned by getTruthDriverDaySummary callable. */
export interface TruthDaySummaryResult {
  generatedAt: string;
  operator: {
    canonicalOperatorKey?: string;
    rawOperatorKey?: string;
    displayName?: string;
    linkedKeys: string[];
    // Phase 9 — first-class identity signals on the returned operator block.
    identityConfidence?: OperatorIdentityConfidence;
    sourceIdentities?: OperatorSourceIdentities;
  };
  dateContext: {
    requestedDate: string;
    localWindow?: { startsAt: string; endsAt: string; timezone: string };
    utcWindow?: { startsAt: string; endsAt: string };
    productionWindow?: { startsAt: string; endsAt: string; timezone: string };
  };
  summary: {
    found: boolean;
    sessions: Array<{
      sessionKey: string;
      startedAt?: string;
      endedAt?: string;
      durationMs?: number;
      timezoneMode: string;
    }>;
    totalActiveMinutes: number;
    locationsVisited: Array<{
      locationKey: string;
      preferredName: string;
      kind?: string;
      eventCount: number;
      // Phase 11 — canonical location identity (only when resolvable).
      canonicalLocationKey?: string;
      rawLocationKey?: string;
      locationDisplayName?: string;
      locationConfidence?: 'strong' | 'medium' | 'weak';
      locationSourceKinds?: {
        hasNdic?: boolean;
        hasSwd?: boolean;
        hasWellConfig?: boolean;
        hasFallbackOnly?: boolean;
      };
      aliases?: string[];
    }>;
    activitiesPerformed: Array<{
      activityKey: string;
      canonicalLabel: string;
      rawCount: number;
    }>;
    jsaCompleted: boolean;
    jsa: {
      completed: boolean;
      pdfUrl?: string;
      entryCount: number;
      jsaKeys: string[];
    };
    eventCounts: Record<string, number>;
  };
  warnings: Array<{ kind: string; message: string; subject?: Record<string, unknown> }>;
  loaded: Record<string, number>;
  sourceErrors: string[];
}

export interface LegacyVsTruthComparison {
  legacyAvailable: boolean;
  mismatchFlags: string[];
  notableDifferences: string[];
}

const DEFAULTS = {
  activeMinutesTolerance: 2,
  locationCountTolerance: 0,
  activityCountTolerance: 0,
};

function legacyActiveMinutes(log: DriverDayLog): number | null {
  if (!log.shiftStart || !log.shiftEnd) return null;
  const start = Date.parse(log.shiftStart);
  const end = Date.parse(log.shiftEnd);
  if (isNaN(start) || isNaN(end) || end < start) return null;
  return Math.round((end - start) / 60000);
}

function countLegacyLocations(log: DriverDayLog): number {
  const set = new Set<string>();
  for (const inv of log.invoices ?? []) {
    if (inv.wellName && inv.wellName.trim()) {
      set.add(inv.wellName.trim().toLowerCase());
    }
    if (inv.hauledTo && inv.hauledTo.trim()) {
      set.add(inv.hauledTo.trim().toLowerCase());
    }
  }
  return set.size;
}

function countLegacyActivityLabels(log: DriverDayLog): number {
  const set = new Set<string>();
  for (const inv of log.invoices ?? []) {
    if (inv.commodityType && inv.commodityType.trim()) {
      set.add(inv.commodityType.trim().toLowerCase());
    }
  }
  return set.size;
}

export function compareLegacyVsTruth(
  legacy: DriverDayLog | null | undefined,
  truth: TruthDaySummaryResult
): LegacyVsTruthComparison {
  if (!legacy) {
    return {
      legacyAvailable: false,
      mismatchFlags: [],
      notableDifferences: [],
    };
  }
  const flags: string[] = [];
  const notable: string[] = [];

  // Session count
  const legacySessionCount =
    legacy.shiftStart || legacy.shiftEnd || legacy.hasShiftData ? 1 : 0;
  const truthSessionCount = truth.summary.sessions.length;
  if (legacySessionCount !== truthSessionCount) {
    flags.push('sessionCount');
    notable.push(
      `session count: legacy=${legacySessionCount} truth=${truthSessionCount}`
    );
  }

  // Active minutes
  const legacyMin = legacyActiveMinutes(legacy);
  const truthMin = truth.summary.totalActiveMinutes;
  if (legacyMin !== null) {
    const delta = Math.abs(legacyMin - truthMin);
    if (delta > DEFAULTS.activeMinutesTolerance) {
      flags.push('activeMinutes');
      notable.push(
        `active minutes: legacy=${legacyMin} truth=${truthMin} (Δ${delta}m)`
      );
    }
  } else {
    notable.push(
      `active minutes: legacy=unknown (no shift bookends) truth=${truthMin}`
    );
  }

  // Location count
  const legacyLocCount = countLegacyLocations(legacy);
  const truthLocCount = truth.summary.locationsVisited.length;
  if (
    Math.abs(legacyLocCount - truthLocCount) > DEFAULTS.locationCountTolerance
  ) {
    flags.push('locationCount');
    notable.push(
      `location count: legacy=${legacyLocCount} truth=${truthLocCount}`
    );
  }

  // Activity label count
  const legacyActCount = countLegacyActivityLabels(legacy);
  const truthActCount = truth.summary.activitiesPerformed.length;
  if (
    Math.abs(legacyActCount - truthActCount) > DEFAULTS.activityCountTolerance
  ) {
    flags.push('activityLabelCount');
    notable.push(
      `activity label count: legacy=${legacyActCount} truth=${truthActCount}`
    );
  }

  // JSA signal (informational — legacy doesn't track)
  if (truth.summary.jsaCompleted) {
    notable.push(`jsa completed: truth=true (not tracked by legacy)`);
  } else if (truth.summary.jsa.entryCount > 0) {
    notable.push(
      `jsa entries: truth=${truth.summary.jsa.entryCount} completed=false (not tracked by legacy)`
    );
  }

  // Loads — informational only
  const legacyLoads = legacy.totalLoads ?? 0;
  const truthDropoffs = truth.summary.eventCounts.dropoff ?? 0;
  if (legacyLoads > 0 || truthDropoffs > 0) {
    notable.push(
      `loads: legacyClosedLoads=${legacyLoads} truthDropoffEvents=${truthDropoffs}`
    );
  }

  return {
    legacyAvailable: true,
    mismatchFlags: Array.from(new Set(flags)).sort(),
    notableDifferences: notable,
  };
}
