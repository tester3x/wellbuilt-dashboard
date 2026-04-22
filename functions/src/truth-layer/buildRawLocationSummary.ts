import type { TruthProjection } from './types';
import type { ValidationWarning } from './validateProjection';

export interface RawLocationSummary {
  locationKey: string;
  preferredName: string;
  aliases: string[];
  kind?: 'well' | 'disposal' | 'yard' | 'pad' | 'custom' | 'unknown';
  operator?: string;
  county?: string;
  apiNo?: string;
  confidence: 'strong' | 'medium' | 'weak';
  operatorKeys: string[];
  eventCount: number;
  jsaEntryCount: number;
  warnings: ValidationWarning[];
}

function warningTouchesLocation(
  w: ValidationWarning,
  locationKey: string
): boolean {
  const subject = w.subject ?? {};
  if (typeof subject.locationKey === 'string' && subject.locationKey === locationKey) {
    return true;
  }
  return false;
}

export function buildRawLocationSummary(
  projection: TruthProjection,
  warnings: ValidationWarning[]
): RawLocationSummary[] {
  const byKey = new Map<string, TruthProjection['locations']>();
  for (const loc of projection.locations) {
    const arr = byKey.get(loc.locationKey) ?? [];
    arr.push(loc);
    byKey.set(loc.locationKey, arr);
  }

  const summaries: RawLocationSummary[] = [];

  for (const [locationKey, members] of byKey.entries()) {
    const aliasSet = new Set<string>();
    let preferredName = locationKey;
    let kind: RawLocationSummary['kind'];
    let operator: string | undefined;
    let county: string | undefined;
    let apiNo: string | undefined;
    let confidence: 'strong' | 'medium' | 'weak' = 'weak';
    const rank = { weak: 0, medium: 1, strong: 2 } as const;
    for (const m of members) {
      for (const a of m.aliases) aliasSet.add(a);
      aliasSet.add(m.preferredName);
      if (rank[m.confidence ?? 'weak'] >= rank[confidence]) {
        confidence = m.confidence ?? confidence;
        preferredName = m.preferredName;
      }
      if (!kind && m.kind) kind = m.kind;
      if (!operator && m.operator) operator = m.operator;
      if (!county && m.county) county = m.county;
      if (!apiNo && m.apiNo) apiNo = m.apiNo;
    }

    const locEvents = projection.events.filter(
      (e) => e.locationKey === locationKey
    );
    const operatorKeySet = new Set<string>();
    for (const e of locEvents) {
      if (e.operatorKey) operatorKeySet.add(e.operatorKey);
    }

    let jsaEntryCount = 0;
    for (const j of projection.jsaViews) {
      for (const entry of j.entries) {
        if (`loc:${entry.normalizedName}` === locationKey) jsaEntryCount += 1;
      }
    }

    const summary: RawLocationSummary = {
      locationKey,
      preferredName,
      aliases: Array.from(aliasSet).sort((a, b) => a.localeCompare(b)),
      confidence,
      operatorKeys: Array.from(operatorKeySet).sort(),
      eventCount: locEvents.length,
      jsaEntryCount,
      warnings: warnings.filter((w) => warningTouchesLocation(w, locationKey)),
    };
    if (kind !== undefined) summary.kind = kind;
    if (operator !== undefined) summary.operator = operator;
    if (county !== undefined) summary.county = county;
    if (apiNo !== undefined) summary.apiNo = apiNo;
    summaries.push(summary);
  }

  return summaries.sort((a, b) => a.locationKey.localeCompare(b.locationKey));
}
