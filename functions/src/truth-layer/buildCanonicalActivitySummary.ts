import type { TruthProjection } from './types';
import type { CanonicalProjection } from './types.canonical';
import type { CanonicalActivitySummary } from './types.dashboard';
import type { ValidationWarning } from './validateProjection';
import { resolveActivityRef } from './normalizeActivity';

function warningTouchesActivity(
  w: ValidationWarning,
  linkedKeys: Set<string>
): boolean {
  const subject = w.subject ?? {};
  const candidates = [subject.activityKey];
  for (const c of candidates) {
    if (typeof c === 'string' && linkedKeys.has(c)) return true;
  }
  return false;
}

export function buildCanonicalActivitySummary(
  projection: TruthProjection,
  canonical: CanonicalProjection,
  warnings: ValidationWarning[]
): CanonicalActivitySummary[] {
  const rawOpToCanonical = new Map<string, string>();
  const canonicalOpToName = new Map<string, string>();
  for (const op of canonical.canonicalOperators) {
    const display =
      op.displayName ?? op.legalName ?? op.canonicalOperatorKey;
    canonicalOpToName.set(op.canonicalOperatorKey, display);
    for (const linked of op.linkedKeys) {
      rawOpToCanonical.set(linked, op.canonicalOperatorKey);
    }
  }

  const rawLocToCanonical = new Map<string, string>();
  const canonicalLocToName = new Map<string, string>();
  for (const loc of canonical.canonicalLocations) {
    canonicalLocToName.set(loc.canonicalLocationKey, loc.preferredName);
    for (const linked of loc.linkedKeys) {
      rawLocToCanonical.set(linked, loc.canonicalLocationKey);
    }
  }

  const rawActToCanonical = new Map<string, string>();
  for (const act of canonical.canonicalActivities) {
    for (const linked of act.linkedKeys) {
      rawActToCanonical.set(linked, act.canonicalActivityKey);
    }
  }

  const summaries: CanonicalActivitySummary[] = [];

  for (const act of canonical.canonicalActivities) {
    const linkedKeys = new Set(act.linkedKeys);

    const matchesEvent = (e: TruthProjection['events'][number]): boolean => {
      if (e.activityKey) {
        if (
          linkedKeys.has(e.activityKey) ||
          rawActToCanonical.get(e.activityKey) === act.canonicalActivityKey
        ) {
          return true;
        }
      }
      if (!e.payload) return false;
      const jobType =
        typeof e.payload.jobType === 'string' ? e.payload.jobType : undefined;
      const commodityType =
        typeof e.payload.commodityType === 'string'
          ? e.payload.commodityType
          : undefined;
      if (jobType) {
        const ref = resolveActivityRef({ jobActivityName: jobType });
        if (ref) {
          const canonicalAct =
            rawActToCanonical.get(ref.activityKey) ?? ref.activityKey;
          if (canonicalAct === act.canonicalActivityKey) return true;
        }
      }
      if (commodityType) {
        const ref = resolveActivityRef({ commodityType });
        if (ref) {
          const canonicalAct =
            rawActToCanonical.get(ref.activityKey) ?? ref.activityKey;
          if (canonicalAct === act.canonicalActivityKey) return true;
        }
      }
      return false;
    };

    const actEvents = projection.events.filter(matchesEvent);

    const operatorNameSet = new Set<string>();
    const locationNameSet = new Set<string>();

    for (const e of actEvents) {
      if (e.operatorKey) {
        const canonicalOp =
          rawOpToCanonical.get(e.operatorKey) ?? e.operatorKey;
        const name = canonicalOpToName.get(canonicalOp);
        if (name) operatorNameSet.add(name);
      }
      if (e.locationKey) {
        const canonicalLoc =
          rawLocToCanonical.get(e.locationKey) ?? e.locationKey;
        const name = canonicalLocToName.get(canonicalLoc);
        if (name) locationNameSet.add(name);
      }
    }

    let jsaEntryCount = 0;
    for (const j of projection.jsaViews) {
      for (const entry of j.entries) {
        if (!entry.activityLabel) continue;
        const ref = resolveActivityRef({ jobActivityName: entry.activityLabel });
        if (!ref) continue;
        const canonicalAct =
          rawActToCanonical.get(ref.activityKey) ?? ref.activityKey;
        if (canonicalAct === act.canonicalActivityKey) {
          jsaEntryCount += 1;
        }
      }
    }

    const rawLabelValues: string[] = [];
    const seenLabels = new Set<string>();
    for (const l of act.rawLabels) {
      if (!seenLabels.has(l.value)) {
        rawLabelValues.push(l.value);
        seenLabels.add(l.value);
      }
    }

    const myWarnings = warnings.filter((w) =>
      warningTouchesActivity(w, linkedKeys)
    );

    const summary: CanonicalActivitySummary = {
      canonicalActivityKey: act.canonicalActivityKey,
      canonicalLabel: act.canonicalLabel,
      rawLabels: rawLabelValues.sort(),
      operatorNames: Array.from(operatorNameSet).sort(),
      locationNames: Array.from(locationNameSet).sort(),
      eventCount: actEvents.length,
      jsaEntryCount,
      warnings: myWarnings,
    };
    if (act.family !== undefined) summary.family = act.family;
    summaries.push(summary);
  }

  return summaries.sort((a, b) =>
    a.canonicalActivityKey.localeCompare(b.canonicalActivityKey)
  );
}
