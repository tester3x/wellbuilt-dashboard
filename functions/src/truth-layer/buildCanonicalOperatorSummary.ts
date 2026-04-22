import type { TruthProjection } from './types';
import type { CanonicalProjection } from './types.canonical';
import type { CanonicalOperatorSummary } from './types.dashboard';
import type { ValidationWarning } from './validateProjection';
import { resolveActivityRef } from './normalizeActivity';

function pickDisplayName(
  op: CanonicalProjection['canonicalOperators'][number]
): string {
  if (op.displayName && op.displayName.trim()) return op.displayName;
  if (op.legalName && op.legalName.trim()) return op.legalName;
  return op.canonicalOperatorKey;
}

function warningTouchesOperator(
  w: ValidationWarning,
  linkedKeys: Set<string>
): boolean {
  const subject = w.subject ?? {};
  const candidates = [
    subject.operatorKey,
    subject.strongKey,
    subject.weakKey,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && linkedKeys.has(c)) return true;
  }
  return false;
}

export function buildCanonicalOperatorSummary(
  projection: TruthProjection,
  canonical: CanonicalProjection,
  warnings: ValidationWarning[]
): CanonicalOperatorSummary[] {
  const rawOpToCanonical = new Map<string, string>();
  for (const op of canonical.canonicalOperators) {
    for (const linked of op.linkedKeys) {
      rawOpToCanonical.set(linked, op.canonicalOperatorKey);
    }
  }

  const rawLocToCanonical = new Map<string, string>();
  for (const loc of canonical.canonicalLocations) {
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

  const summaries: CanonicalOperatorSummary[] = [];

  for (const op of canonical.canonicalOperators) {
    const linkedKeys = [...op.linkedKeys].sort();
    const linkedSet = new Set(linkedKeys);

    const mySessions = projection.sessions.filter(
      (s) => s.operatorKey !== undefined && linkedSet.has(s.operatorKey)
    );
    const myEvents = projection.events.filter(
      (e) => e.operatorKey !== undefined && linkedSet.has(e.operatorKey)
    );
    const myJsas = projection.jsaViews.filter(
      (j) => j.operatorKey !== undefined && linkedSet.has(j.operatorKey)
    );

    let openSessionCount = 0;
    let totalActiveMs = 0;
    for (const s of mySessions) {
      if (s.isOpen === true) openSessionCount += 1;
      if (s.startedAt && s.endedAt) {
        const start = Date.parse(s.startedAt);
        const end = Date.parse(s.endedAt);
        if (!isNaN(start) && !isNaN(end) && end >= start) {
          totalActiveMs += end - start;
        }
      }
    }

    const locationsSet = new Set<string>();
    for (const e of myEvents) {
      if (e.locationKey) {
        const canonicalLoc =
          rawLocToCanonical.get(e.locationKey) ?? e.locationKey;
        locationsSet.add(canonicalLoc);
      }
    }
    for (const j of myJsas) {
      for (const entry of j.entries) {
        const rawKey = `loc:${entry.normalizedName}`;
        const canonicalLoc = rawLocToCanonical.get(rawKey) ?? rawKey;
        locationsSet.add(canonicalLoc);
      }
    }

    const activitiesSet = new Set<string>();
    const addResolved = (hint: Parameters<typeof resolveActivityRef>[0]) => {
      const ref = resolveActivityRef(hint);
      if (!ref) return;
      const canonicalAct =
        rawActToCanonical.get(ref.activityKey) ?? ref.activityKey;
      activitiesSet.add(canonicalAct);
    };
    for (const e of myEvents) {
      if (e.activityKey) {
        const canonicalAct =
          rawActToCanonical.get(e.activityKey) ?? e.activityKey;
        activitiesSet.add(canonicalAct);
      }
      if (e.payload) {
        const jobType =
          typeof e.payload.jobType === 'string' ? e.payload.jobType : undefined;
        const commodityType =
          typeof e.payload.commodityType === 'string'
            ? e.payload.commodityType
            : undefined;
        if (jobType) addResolved({ jobActivityName: jobType });
        if (commodityType) addResolved({ commodityType });
      }
    }
    for (const j of myJsas) {
      for (const entry of j.entries) {
        if (!entry.activityLabel) continue;
        addResolved({ jobActivityName: entry.activityLabel });
      }
    }

    const jsaCompletedCount = myJsas.filter((j) => j.completed === true).length;

    const myWarnings = warnings.filter((w) =>
      warningTouchesOperator(w, linkedSet)
    );

    summaries.push({
      canonicalOperatorKey: op.canonicalOperatorKey,
      preferredDisplayName: pickDisplayName(op),
      linkedKeys,
      confidence: op.confidence,
      sessionCount: mySessions.length,
      openSessionCount,
      locationsVisited: Array.from(locationsSet).sort(),
      activitiesPerformed: Array.from(activitiesSet).sort(),
      jsaCompletedCount,
      totalEventCount: myEvents.length,
      totalActiveMinutes: Math.round(totalActiveMs / 60000),
      warnings: myWarnings,
    });
  }

  return summaries.sort((a, b) =>
    a.canonicalOperatorKey.localeCompare(b.canonicalOperatorKey)
  );
}
