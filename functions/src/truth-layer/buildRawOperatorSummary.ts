import type { TruthProjection } from './types';
import type { ValidationWarning } from './validateProjection';

export interface RawOperatorSummary {
  operatorKey: string;
  displayName?: string;
  legalName?: string;
  hash?: string;
  uid?: string;
  companyId?: string;
  companyName?: string;
  confidence: 'strong' | 'medium' | 'weak';
  sessionCount: number;
  openSessionCount: number;
  eventCount: number;
  jsaViewCount: number;
  jsaCompletedCount: number;
  locationKeys: string[];
  warnings: ValidationWarning[];
}

function warningTouchesOperator(
  w: ValidationWarning,
  operatorKey: string
): boolean {
  const subject = w.subject ?? {};
  const candidates = [subject.operatorKey, subject.strongKey, subject.weakKey];
  for (const c of candidates) {
    if (typeof c === 'string' && c === operatorKey) return true;
  }
  return false;
}

export function buildRawOperatorSummary(
  projection: TruthProjection,
  warnings: ValidationWarning[]
): RawOperatorSummary[] {
  const summaries: RawOperatorSummary[] = [];

  for (const op of projection.operators) {
    const mySessions = projection.sessions.filter(
      (s) => s.operatorKey === op.operatorKey
    );
    const myEvents = projection.events.filter(
      (e) => e.operatorKey === op.operatorKey
    );
    const myJsas = projection.jsaViews.filter(
      (j) => j.operatorKey === op.operatorKey
    );

    const locationSet = new Set<string>();
    for (const e of myEvents) {
      if (e.locationKey) locationSet.add(e.locationKey);
    }
    for (const j of myJsas) {
      for (const entry of j.entries) {
        locationSet.add(`loc:${entry.normalizedName}`);
      }
    }

    const openSessionCount = mySessions.filter((s) => s.isOpen === true).length;
    const jsaCompletedCount = myJsas.filter((j) => j.completed === true).length;

    const summary: RawOperatorSummary = {
      operatorKey: op.operatorKey,
      confidence: op.confidence ?? 'weak',
      sessionCount: mySessions.length,
      openSessionCount,
      eventCount: myEvents.length,
      jsaViewCount: myJsas.length,
      jsaCompletedCount,
      locationKeys: Array.from(locationSet).sort(),
      warnings: warnings.filter((w) =>
        warningTouchesOperator(w, op.operatorKey)
      ),
    };
    if (op.displayName !== undefined) summary.displayName = op.displayName;
    if (op.legalName !== undefined) summary.legalName = op.legalName;
    if (op.hash !== undefined) summary.hash = op.hash;
    if (op.uid !== undefined) summary.uid = op.uid;
    if (op.companyId !== undefined) summary.companyId = op.companyId;
    if (op.companyName !== undefined) summary.companyName = op.companyName;
    summaries.push(summary);
  }

  return summaries.sort((a, b) => a.operatorKey.localeCompare(b.operatorKey));
}
