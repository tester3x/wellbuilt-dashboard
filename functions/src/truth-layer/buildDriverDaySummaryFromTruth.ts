import type { TruthProjection } from './types';
import { resolveActivityRef } from './normalizeActivity';

export interface DaySummarySession {
  sessionKey: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  timezoneMode: string;
}

export interface DaySummaryLocation {
  locationKey: string;
  preferredName: string;
  kind?: string;
  eventCount: number;
}

export interface DaySummaryActivity {
  activityKey: string;
  canonicalLabel: string;
  rawCount: number;
}

export interface DaySummaryJsa {
  completed: boolean;
  pdfUrl?: string;
  entryCount: number;
  jsaKeys: string[];
}

export interface DriverDaySummary {
  operatorKey: string;
  found: boolean;
  sessions: DaySummarySession[];
  totalActiveMs: number;
  locationsVisited: DaySummaryLocation[];
  activitiesPerformed: DaySummaryActivity[];
  jsa: DaySummaryJsa;
  eventCountsByType: Record<string, number>;
}

export function buildDriverDaySummaryFromTruth(
  projection: TruthProjection,
  operatorKey: string | readonly string[]
): DriverDaySummary {
  // Accept a single raw operator key or an array of linked keys (from a
  // canonical view's `linkedKeys`). Array form is how the legal-name bridge
  // surfaces downstream: events extracted under a name-only raw key join the
  // same day summary as events under the hash-backed raw key.
  const keyList: string[] = Array.isArray(operatorKey)
    ? Array.from(new Set(operatorKey as readonly string[]))
    : [operatorKey as string];
  const keySet = new Set(keyList);
  const primaryKey = keyList[0] ?? '';
  const operatorExists = projection.operators.some((o) => keySet.has(o.operatorKey));

  const locByKey = new Map(projection.locations.map((l) => [l.locationKey, l]));
  const actByKey = new Map(projection.activities.map((a) => [a.activityKey, a]));

  const matches = (k: string | undefined): boolean =>
    typeof k === 'string' && keySet.has(k);
  const mySessions = projection.sessions.filter((s) => matches(s.operatorKey));
  const myEvents = projection.events.filter((e) => matches(e.operatorKey));
  const myJsas = projection.jsaViews.filter((j) => matches(j.operatorKey));

  let totalActiveMs = 0;
  const sessions: DaySummarySession[] = mySessions.map((s) => {
    const out: DaySummarySession = {
      sessionKey: s.sessionKey,
      timezoneMode: s.timezoneMode,
    };
    if (s.startedAt !== undefined) out.startedAt = s.startedAt;
    if (s.endedAt !== undefined) out.endedAt = s.endedAt;
    if (s.startedAt && s.endedAt) {
      const start = Date.parse(s.startedAt);
      const end = Date.parse(s.endedAt);
      if (!isNaN(start) && !isNaN(end) && end >= start) {
        out.durationMs = end - start;
        totalActiveMs += out.durationMs;
      }
    }
    return out;
  });

  const locationCounts = new Map<string, number>();
  for (const e of myEvents) {
    if (e.locationKey) {
      locationCounts.set(
        e.locationKey,
        (locationCounts.get(e.locationKey) ?? 0) + 1
      );
    }
  }
  for (const j of myJsas) {
    for (const entry of j.entries) {
      const key = `loc:${entry.normalizedName}`;
      locationCounts.set(key, (locationCounts.get(key) ?? 0) + 1);
    }
  }
  const locationsVisited: DaySummaryLocation[] = Array.from(
    locationCounts.entries()
  )
    .map(([key, count]) => {
      const loc = locByKey.get(key);
      const out: DaySummaryLocation = {
        locationKey: key,
        preferredName: loc?.preferredName ?? key,
        eventCount: count,
      };
      if (loc?.kind !== undefined) out.kind = loc.kind;
      return out;
    })
    .sort((a, b) => a.locationKey.localeCompare(b.locationKey));

  const activityCounts = new Map<string, number>();
  const countActivity = (label?: unknown) => {
    if (typeof label !== 'string' || !label.trim()) return;
    const ref = resolveActivityRef({ jobActivityName: label });
    if (!ref) return;
    activityCounts.set(
      ref.activityKey,
      (activityCounts.get(ref.activityKey) ?? 0) + 1
    );
  };
  for (const e of myEvents) {
    if (e.payload) {
      countActivity(e.payload.jobType);
      countActivity(e.payload.commodityType);
    }
  }
  for (const j of myJsas) {
    for (const entry of j.entries) {
      countActivity(entry.activityLabel);
    }
  }
  const activitiesPerformed: DaySummaryActivity[] = Array.from(
    activityCounts.entries()
  )
    .map(([key, count]) => {
      const act = actByKey.get(key);
      return {
        activityKey: key,
        canonicalLabel: act?.canonicalLabel ?? key,
        rawCount: count,
      };
    })
    .sort((a, b) => a.activityKey.localeCompare(b.activityKey));

  const jsaCompleted =
    myJsas.some((j) => j.completed === true) ||
    myEvents.some((e) => e.eventType === 'jsa_completed');
  const jsaWithPdf = myJsas.find((j) => !!j.pdfUrl);
  const jsa: DaySummaryJsa = {
    completed: jsaCompleted,
    entryCount: myJsas.reduce((sum, j) => sum + j.entries.length, 0),
    jsaKeys: myJsas.map((j) => j.jsaKey).sort(),
  };
  if (jsaWithPdf?.pdfUrl) jsa.pdfUrl = jsaWithPdf.pdfUrl;

  const eventCountsByType: Record<string, number> = {};
  for (const e of myEvents) {
    eventCountsByType[e.eventType] = (eventCountsByType[e.eventType] ?? 0) + 1;
  }

  return {
    operatorKey: primaryKey,
    found: operatorExists,
    sessions,
    totalActiveMs,
    locationsVisited,
    activitiesPerformed,
    jsa,
    eventCountsByType,
  };
}
