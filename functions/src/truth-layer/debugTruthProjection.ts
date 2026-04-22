import type { TruthProjection } from './types';
import { normalizeName } from './normalizeOperator';

export interface DebugReport {
  operators: {
    total: number;
    byConfidence: Record<'strong' | 'medium' | 'weak' | 'unknown', number>;
    keys: string[];
    possibleDuplicateGroups: string[][];
  };
  sessions: {
    total: number;
    countPerOperator: Record<string, number>;
    openSessions: string[];
    missingStart: string[];
    overlappingPairs: Array<[string, string]>;
  };
  locations: {
    total: number;
    byConfidence: Record<'strong' | 'medium' | 'weak' | 'unknown', number>;
    byKind: Record<string, number>;
    aliasCollisionGroups: string[][];
  };
  activities: {
    total: number;
    canonicalLabels: string[];
    rawLabelsByActivity: Record<string, string[]>;
  };
  jsa: {
    total: number;
    completedCount: number;
    entryCounts: Record<string, number>;
    missingActivityBindings: Array<{ jsaKey: string; entryKey: string }>;
    duplicateMergeCounts: Record<string, number>;
  };
  events: {
    total: number;
    byType: Record<string, number>;
    missingTimestamps: string[];
  };
}

function emptyConfidenceBuckets() {
  return { strong: 0, medium: 0, weak: 0, unknown: 0 };
}

export function debugTruthProjection(projection: TruthProjection): DebugReport {
  const opByConf = emptyConfidenceBuckets();
  const opKeys: string[] = [];
  const opByName = new Map<string, string[]>();
  for (const op of projection.operators) {
    opByConf[op.confidence ?? 'unknown']++;
    opKeys.push(op.operatorKey);
    const nameSource = op.displayName ?? op.legalName;
    if (nameSource) {
      const n = normalizeName(nameSource);
      const arr = opByName.get(n) ?? [];
      arr.push(op.operatorKey);
      opByName.set(n, arr);
    }
  }
  const possibleDuplicateGroups = Array.from(opByName.values())
    .filter((group) => group.length > 1)
    .map((group) => [...group].sort());

  const countPerOperator: Record<string, number> = {};
  const openSessions: string[] = [];
  const missingStart: string[] = [];
  for (const s of projection.sessions) {
    const k = s.operatorKey ?? '(no operator)';
    countPerOperator[k] = (countPerOperator[k] ?? 0) + 1;
    if (!s.startedAt) missingStart.push(s.sessionKey);
    if (!s.endedAt) openSessions.push(s.sessionKey);
  }
  const overlappingPairs: Array<[string, string]> = [];
  const byOp = new Map<string, typeof projection.sessions>();
  for (const s of projection.sessions) {
    if (!s.operatorKey) continue;
    const arr = byOp.get(s.operatorKey) ?? [];
    arr.push(s);
    byOp.set(s.operatorKey, arr);
  }
  for (const sessions of byOp.values()) {
    for (let i = 0; i < sessions.length; i++) {
      for (let j = i + 1; j < sessions.length; j++) {
        const a = sessions[i];
        const b = sessions[j];
        if (!a.startedAt || !b.startedAt) continue;
        const aStart = Date.parse(a.startedAt);
        const bStart = Date.parse(b.startedAt);
        const aEnd = a.endedAt ? Date.parse(a.endedAt) : Number.POSITIVE_INFINITY;
        const bEnd = b.endedAt ? Date.parse(b.endedAt) : Number.POSITIVE_INFINITY;
        if (isNaN(aStart) || isNaN(bStart)) continue;
        if (aStart < bEnd && bStart < aEnd) {
          overlappingPairs.push(
            [a.sessionKey, b.sessionKey].sort() as [string, string]
          );
        }
      }
    }
  }

  const locByConf = emptyConfidenceBuckets();
  const locByKind: Record<string, number> = {};
  const locPreferredByKey = new Map<string, Set<string>>();
  for (const loc of projection.locations) {
    locByConf[loc.confidence ?? 'unknown']++;
    const kind = loc.kind ?? 'unknown';
    locByKind[kind] = (locByKind[kind] ?? 0) + 1;
    const set = locPreferredByKey.get(loc.locationKey) ?? new Set<string>();
    set.add(loc.preferredName);
    locPreferredByKey.set(loc.locationKey, set);
  }
  const aliasCollisionGroups: string[][] = [];
  for (const [key, set] of locPreferredByKey.entries()) {
    if (set.size > 1) {
      aliasCollisionGroups.push([key, ...Array.from(set).sort()]);
    }
  }

  const canonicalLabels = projection.activities
    .map((a) => a.canonicalLabel)
    .sort();
  const rawLabelsByActivity: Record<string, string[]> = {};
  for (const a of projection.activities) {
    const values = Array.from(new Set(a.rawLabels.map((l) => l.value))).sort();
    rawLabelsByActivity[a.activityKey] = values;
  }

  const entryCounts: Record<string, number> = {};
  const missingActivityBindings: Array<{ jsaKey: string; entryKey: string }> = [];
  let completedCount = 0;
  const duplicateMergeCounts: Record<string, number> = {};
  for (const j of projection.jsaViews) {
    entryCounts[j.jsaKey] = j.entries.length;
    if (j.completed) completedCount++;
    for (const entry of j.entries) {
      if (!entry.activityLabel) {
        missingActivityBindings.push({ jsaKey: j.jsaKey, entryKey: entry.entryKey });
      }
      if (entry.sourceRefs.length > 1) {
        duplicateMergeCounts[`${j.jsaKey}:${entry.entryKey}`] = entry.sourceRefs.length;
      }
    }
  }

  const eventsByType: Record<string, number> = {};
  const missingTimestamps: string[] = [];
  for (const e of projection.events) {
    eventsByType[e.eventType] = (eventsByType[e.eventType] ?? 0) + 1;
    if (!e.occurredAt) missingTimestamps.push(e.eventKey);
  }

  return {
    operators: {
      total: projection.operators.length,
      byConfidence: opByConf,
      keys: [...opKeys].sort(),
      possibleDuplicateGroups,
    },
    sessions: {
      total: projection.sessions.length,
      countPerOperator,
      openSessions: [...openSessions].sort(),
      missingStart: [...missingStart].sort(),
      overlappingPairs,
    },
    locations: {
      total: projection.locations.length,
      byConfidence: locByConf,
      byKind: locByKind,
      aliasCollisionGroups,
    },
    activities: {
      total: projection.activities.length,
      canonicalLabels,
      rawLabelsByActivity,
    },
    jsa: {
      total: projection.jsaViews.length,
      completedCount,
      entryCounts,
      missingActivityBindings,
      duplicateMergeCounts,
    },
    events: {
      total: projection.events.length,
      byType: eventsByType,
      missingTimestamps: [...missingTimestamps].sort(),
    },
  };
}

export function formatDebugReport(report: DebugReport): string {
  const lines: string[] = [];
  const push = (s: string) => lines.push(s);
  push('=== TRUTH LAYER DEBUG REPORT ===');

  push('');
  push('--- operators ---');
  push(`total: ${report.operators.total}`);
  push(`byConfidence: ${JSON.stringify(report.operators.byConfidence)}`);
  push(`keys: ${report.operators.keys.join(', ')}`);
  push(
    `possibleDuplicateGroups: ${
      report.operators.possibleDuplicateGroups.length
        ? JSON.stringify(report.operators.possibleDuplicateGroups)
        : '(none)'
    }`
  );

  push('');
  push('--- sessions ---');
  push(`total: ${report.sessions.total}`);
  push(`countPerOperator: ${JSON.stringify(report.sessions.countPerOperator)}`);
  push(`openSessions: ${report.sessions.openSessions.length}`);
  push(`missingStart: ${report.sessions.missingStart.length}`);
  push(`overlappingPairs: ${report.sessions.overlappingPairs.length}`);

  push('');
  push('--- locations ---');
  push(`total: ${report.locations.total}`);
  push(`byConfidence: ${JSON.stringify(report.locations.byConfidence)}`);
  push(`byKind: ${JSON.stringify(report.locations.byKind)}`);
  push(`aliasCollisionGroups: ${report.locations.aliasCollisionGroups.length}`);

  push('');
  push('--- activities ---');
  push(`total: ${report.activities.total}`);
  push(`canonicalLabels: ${report.activities.canonicalLabels.join(', ')}`);

  push('');
  push('--- jsa ---');
  push(`total: ${report.jsa.total}`);
  push(`completedCount: ${report.jsa.completedCount}`);
  push(`missingActivityBindings: ${report.jsa.missingActivityBindings.length}`);

  push('');
  push('--- events ---');
  push(`total: ${report.events.total}`);
  push(`byType: ${JSON.stringify(report.events.byType)}`);
  push(`missingTimestamps: ${report.events.missingTimestamps.length}`);

  return lines.join('\n');
}
