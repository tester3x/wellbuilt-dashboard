import type { TruthProjection } from './types';
import { normalizeName } from './normalizeOperator';

export type ValidationWarningKind =
  | 'operator_parallel_identities'
  | 'session_no_operator'
  | 'session_no_start'
  | 'session_no_end'
  | 'session_overlap_same_operator'
  | 'location_empty_name'
  | 'location_alias_collision'
  | 'activity_no_label'
  | 'jsa_entry_no_name'
  | 'jsa_entry_no_activity'
  | 'event_no_timestamp';

export interface ValidationWarning {
  kind: ValidationWarningKind;
  message: string;
  subject?: Record<string, unknown>;
}

export function validateProjection(
  projection: TruthProjection
): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];

  const hashByName = new Map<string, string>();
  const weakByName = new Map<string, string>();
  for (const op of projection.operators) {
    const name = op.displayName ?? op.legalName;
    if (!name) continue;
    const n = normalizeName(name);
    if (op.hash) hashByName.set(n, op.operatorKey);
    else weakByName.set(n, op.operatorKey);
  }
  for (const [n, weakKey] of weakByName.entries()) {
    const strongKey = hashByName.get(n);
    if (strongKey && strongKey !== weakKey) {
      warnings.push({
        kind: 'operator_parallel_identities',
        message: `Two operator keys likely refer to the same person: ${strongKey} (strong) and ${weakKey} (weak, name-only)`,
        subject: { normalizedName: n, strongKey, weakKey },
      });
    }
  }

  const byOp = new Map<string, typeof projection.sessions>();
  for (const s of projection.sessions) {
    if (!s.operatorKey) {
      warnings.push({
        kind: 'session_no_operator',
        message: `Session ${s.sessionKey} has no operatorKey`,
        subject: { sessionKey: s.sessionKey },
      });
      continue;
    }
    if (!s.startedAt) {
      warnings.push({
        kind: 'session_no_start',
        message: `Session ${s.sessionKey} has no startedAt`,
        subject: { sessionKey: s.sessionKey, operatorKey: s.operatorKey },
      });
    }
    if (!s.endedAt) {
      warnings.push({
        kind: 'session_no_end',
        message: `Session ${s.sessionKey} has no endedAt (open session)`,
        subject: { sessionKey: s.sessionKey, operatorKey: s.operatorKey },
      });
    }
    const arr = byOp.get(s.operatorKey) ?? [];
    arr.push(s);
    byOp.set(s.operatorKey, arr);
  }
  for (const [op, sessions] of byOp.entries()) {
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
          warnings.push({
            kind: 'session_overlap_same_operator',
            message: `Two sessions for operator ${op} overlap in time: ${a.sessionKey} vs ${b.sessionKey}`,
            subject: {
              operatorKey: op,
              sessionKeyA: a.sessionKey,
              sessionKeyB: b.sessionKey,
            },
          });
        }
      }
    }
  }

  const seenLocKeys = new Map<string, Set<string>>();
  for (const loc of projection.locations) {
    if (!loc.preferredName || !loc.preferredName.trim()) {
      warnings.push({
        kind: 'location_empty_name',
        message: `Location ${loc.locationKey} has empty preferredName`,
        subject: { locationKey: loc.locationKey },
      });
    }
    const set = seenLocKeys.get(loc.locationKey) ?? new Set<string>();
    set.add(loc.preferredName);
    seenLocKeys.set(loc.locationKey, set);
  }
  for (const [key, preferred] of seenLocKeys.entries()) {
    if (preferred.size > 1) {
      warnings.push({
        kind: 'location_alias_collision',
        message: `Location ${key} has multiple preferredName values: ${Array.from(preferred).join(', ')}`,
        subject: { locationKey: key, preferredNames: Array.from(preferred) },
      });
    }
  }

  for (const a of projection.activities) {
    if (!a.canonicalLabel || !a.canonicalLabel.trim()) {
      warnings.push({
        kind: 'activity_no_label',
        message: `Activity ${a.activityKey} has no canonicalLabel`,
        subject: { activityKey: a.activityKey },
      });
    }
  }

  for (const j of projection.jsaViews) {
    for (const entry of j.entries) {
      if (!entry.normalizedName) {
        warnings.push({
          kind: 'jsa_entry_no_name',
          message: `JSA ${j.jsaKey} has an entry with no normalizedName`,
          subject: { jsaKey: j.jsaKey, entryKey: entry.entryKey },
        });
      }
      if (!entry.activityLabel) {
        warnings.push({
          kind: 'jsa_entry_no_activity',
          message: `JSA ${j.jsaKey} entry ${entry.name} has no activity binding`,
          subject: {
            jsaKey: j.jsaKey,
            entryKey: entry.entryKey,
            name: entry.name,
          },
        });
      }
    }
  }

  for (const e of projection.events) {
    if (!e.occurredAt) {
      warnings.push({
        kind: 'event_no_timestamp',
        message: `Event ${e.eventKey} has no occurredAt`,
        subject: { eventKey: e.eventKey, eventType: e.eventType },
      });
    }
  }

  return warnings;
}

export function groupWarningsByKind(
  warnings: ValidationWarning[]
): Record<string, ValidationWarning[]> {
  const by: Record<string, ValidationWarning[]> = {};
  for (const w of warnings) {
    const arr = by[w.kind] ?? [];
    arr.push(w);
    by[w.kind] = arr;
  }
  return by;
}
