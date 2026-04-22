import type { TruthProjection } from './types';
import type { CanonicalProjection } from './types.canonical';
import type { CanonicalLocationSummary } from './types.dashboard';
import type { ValidationWarning } from './validateProjection';
import { resolveActivityRef } from './normalizeActivity';

function warningTouchesLocation(
  w: ValidationWarning,
  linkedKeys: Set<string>
): boolean {
  const subject = w.subject ?? {};
  const candidates = [subject.locationKey];
  for (const c of candidates) {
    if (typeof c === 'string' && linkedKeys.has(c)) return true;
  }
  return false;
}

export function buildCanonicalLocationSummary(
  projection: TruthProjection,
  canonical: CanonicalProjection,
  warnings: ValidationWarning[]
): CanonicalLocationSummary[] {
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

  const rawActToCanonical = new Map<string, string>();
  const canonicalActToLabel = new Map<string, string>();
  for (const act of canonical.canonicalActivities) {
    canonicalActToLabel.set(act.canonicalActivityKey, act.canonicalLabel);
    for (const linked of act.linkedKeys) {
      rawActToCanonical.set(linked, act.canonicalActivityKey);
    }
  }

  const rawLocToCanonical = new Map<string, string>();
  for (const loc of canonical.canonicalLocations) {
    for (const linked of loc.linkedKeys) {
      rawLocToCanonical.set(linked, loc.canonicalLocationKey);
    }
  }

  const summaries: CanonicalLocationSummary[] = [];

  for (const loc of canonical.canonicalLocations) {
    const linkedKeys = new Set(loc.linkedKeys);

    const locEvents = projection.events.filter(
      (e) =>
        e.locationKey !== undefined &&
        (linkedKeys.has(e.locationKey) ||
          rawLocToCanonical.get(e.locationKey) === loc.canonicalLocationKey)
    );

    const operatorNameSet = new Set<string>();
    const sessionKeySet = new Set<string>();
    const activityLabelSet = new Set<string>();

    const recordActivity = (ref: ReturnType<typeof resolveActivityRef>) => {
      if (!ref) return;
      const canonicalAct =
        rawActToCanonical.get(ref.activityKey) ?? ref.activityKey;
      const label = canonicalActToLabel.get(canonicalAct) ?? canonicalAct;
      activityLabelSet.add(label);
    };
    for (const e of locEvents) {
      if (e.operatorKey) {
        const canonicalOp =
          rawOpToCanonical.get(e.operatorKey) ?? e.operatorKey;
        const name = canonicalOpToName.get(canonicalOp);
        if (name) operatorNameSet.add(name);
      }
      if (e.sessionKey) sessionKeySet.add(e.sessionKey);
      else sessionKeySet.add(`__no_session__:${e.eventKey}`);
      if (e.activityKey) {
        const canonicalAct =
          rawActToCanonical.get(e.activityKey) ?? e.activityKey;
        const label = canonicalActToLabel.get(canonicalAct) ?? canonicalAct;
        activityLabelSet.add(label);
      }
      if (e.payload) {
        const jobType =
          typeof e.payload.jobType === 'string' ? e.payload.jobType : undefined;
        const commodityType =
          typeof e.payload.commodityType === 'string'
            ? e.payload.commodityType
            : undefined;
        if (jobType) recordActivity(resolveActivityRef({ jobActivityName: jobType }));
        if (commodityType) recordActivity(resolveActivityRef({ commodityType }));
      }
    }

    let jsaEntryCount = 0;
    for (const j of projection.jsaViews) {
      for (const entry of j.entries) {
        const rawKey = `loc:${entry.normalizedName}`;
        if (
          linkedKeys.has(rawKey) ||
          rawLocToCanonical.get(rawKey) === loc.canonicalLocationKey
        ) {
          jsaEntryCount += 1;
        }
      }
    }

    const myWarnings = warnings.filter((w) =>
      warningTouchesLocation(w, linkedKeys)
    );

    const summary: CanonicalLocationSummary = {
      canonicalLocationKey: loc.canonicalLocationKey,
      preferredName: loc.preferredName,
      aliases: [...loc.aliases].sort((a, b) => a.localeCompare(b)),
      confidence: loc.confidence,
      operatorNames: Array.from(operatorNameSet).sort(),
      activityLabels: Array.from(activityLabelSet).sort(),
      visitCount: sessionKeySet.size,
      eventCount: locEvents.length,
      jsaEntryCount,
      warnings: myWarnings,
    };
    if (loc.kind !== undefined) summary.kind = loc.kind;
    summaries.push(summary);
  }

  return summaries.sort((a, b) =>
    a.canonicalLocationKey.localeCompare(b.canonicalLocationKey)
  );
}
