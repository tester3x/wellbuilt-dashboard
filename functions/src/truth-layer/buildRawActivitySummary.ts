import type { TruthProjection } from './types';
import type { ValidationWarning } from './validateProjection';
import { resolveActivityRef } from './normalizeActivity';

export interface RawActivitySummary {
  activityKey: string;
  canonicalLabel: string;
  family?: 'transport' | 'service' | 'safety' | 'compliance' | 'admin' | 'unknown';
  rawLabels: string[];
  confidence: 'strong' | 'medium' | 'weak';
  eventCount: number;
  jsaEntryCount: number;
  warnings: ValidationWarning[];
}

function warningTouchesActivity(
  w: ValidationWarning,
  activityKey: string
): boolean {
  const subject = w.subject ?? {};
  return typeof subject.activityKey === 'string' && subject.activityKey === activityKey;
}

export function buildRawActivitySummary(
  projection: TruthProjection,
  warnings: ValidationWarning[]
): RawActivitySummary[] {
  const summaries: RawActivitySummary[] = [];

  for (const act of projection.activities) {
    const rawLabels: string[] = [];
    const seen = new Set<string>();
    for (const l of act.rawLabels) {
      if (!seen.has(l.value)) {
        rawLabels.push(l.value);
        seen.add(l.value);
      }
    }

    let eventCount = 0;
    for (const e of projection.events) {
      if (e.activityKey === act.activityKey) {
        eventCount += 1;
        continue;
      }
      if (!e.payload) continue;
      const jobType =
        typeof e.payload.jobType === 'string' ? e.payload.jobType : undefined;
      const commodityType =
        typeof e.payload.commodityType === 'string'
          ? e.payload.commodityType
          : undefined;
      if (jobType) {
        const ref = resolveActivityRef({ jobActivityName: jobType });
        if (ref && ref.activityKey === act.activityKey) {
          eventCount += 1;
          continue;
        }
      }
      if (commodityType) {
        const ref = resolveActivityRef({ commodityType });
        if (ref && ref.activityKey === act.activityKey) {
          eventCount += 1;
        }
      }
    }

    let jsaEntryCount = 0;
    for (const j of projection.jsaViews) {
      for (const entry of j.entries) {
        if (!entry.activityLabel) continue;
        const ref = resolveActivityRef({ jobActivityName: entry.activityLabel });
        if (ref && ref.activityKey === act.activityKey) {
          jsaEntryCount += 1;
        }
      }
    }

    const summary: RawActivitySummary = {
      activityKey: act.activityKey,
      canonicalLabel: act.canonicalLabel,
      rawLabels: rawLabels.sort(),
      confidence: act.confidence ?? 'weak',
      eventCount,
      jsaEntryCount,
      warnings: warnings.filter((w) =>
        warningTouchesActivity(w, act.activityKey)
      ),
    };
    if (act.family !== undefined) summary.family = act.family;
    summaries.push(summary);
  }

  return summaries.sort((a, b) => a.activityKey.localeCompare(b.activityKey));
}
