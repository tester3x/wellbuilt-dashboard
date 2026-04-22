import type { TruthProjection } from './types';
import type { ValidationWarning } from './validateProjection';
import { validateProjection } from './validateProjection';
import {
  buildRawOperatorSummary,
  type RawOperatorSummary,
} from './buildRawOperatorSummary';
import {
  buildRawLocationSummary,
  type RawLocationSummary,
} from './buildRawLocationSummary';
import {
  buildRawActivitySummary,
  type RawActivitySummary,
} from './buildRawActivitySummary';

export interface RawDashboardCounts {
  operators: number;
  sessions: number;
  openSessions: number;
  locations: number;
  activities: number;
  jsaViews: number;
  events: number;
  reportingWindows: number;
}

export interface RawDashboardView {
  operators: RawOperatorSummary[];
  locations: RawLocationSummary[];
  activities: RawActivitySummary[];
  counts: RawDashboardCounts;
  sessionCount: number;
  warnings: ValidationWarning[];
  generatedAt: string;
}

export interface BuildRawDashboardViewOptions {
  warnings?: ValidationWarning[];
  generatedAt?: string;
}

export function buildRawDashboardView(
  projection: TruthProjection,
  options: BuildRawDashboardViewOptions = {}
): RawDashboardView {
  const warnings = options.warnings ?? validateProjection(projection);
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  const operators = buildRawOperatorSummary(projection, warnings);
  const locations = buildRawLocationSummary(projection, warnings);
  const activities = buildRawActivitySummary(projection, warnings);

  const counts: RawDashboardCounts = {
    operators: projection.operators.length,
    sessions: projection.sessions.length,
    openSessions: projection.sessions.filter((s) => s.isOpen === true).length,
    locations: projection.locations.length,
    activities: projection.activities.length,
    jsaViews: projection.jsaViews.length,
    events: projection.events.length,
    reportingWindows: projection.reportingWindows.length,
  };

  return {
    operators,
    locations,
    activities,
    counts,
    sessionCount: projection.sessions.length,
    warnings,
    generatedAt,
  };
}
