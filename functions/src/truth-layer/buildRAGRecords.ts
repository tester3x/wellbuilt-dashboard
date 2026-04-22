import type { TruthProjection } from './types';
import type { CanonicalOperatorIndex } from './canonicalIdentity';
import { lookupCanonicalOperator } from './canonicalIdentity';
import type { CanonicalLocationIndex } from './canonicalLocationIdentity';
import { lookupCanonicalLocation } from './canonicalLocationIdentity';

export interface RAGRecordMetadata {
  operatorKey?: string;
  sessionKey?: string;
  locationKey?: string;
  activityKey?: string;
  timestamp?: string;
  type: 'event' | 'jsa_entry' | 'session';
  // Phase 9 — canonical operator identity surfaced in raw RAG metadata.
  // All four are OPTIONAL and only present when resolvable; never inferred.
  canonicalOperatorKey?: string;
  rawOperatorKey?: string;
  operatorDisplayName?: string;
  operatorConfidence?: 'strong' | 'weak';
  // Phase 11 — canonical location identity surfaced in raw RAG metadata.
  // Custom/fallback locations surface as weak with kind preserved — not errors.
  canonicalLocationKey?: string;
  rawLocationKey?: string;
  locationDisplayName?: string;
  locationConfidence?: 'strong' | 'medium' | 'weak';
  locationKind?: 'well' | 'disposal' | 'yard' | 'pad' | 'custom' | 'unknown';
}

export interface RAGRecord {
  text: string;
  metadata: RAGRecordMetadata;
}

function fact(label: string, value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  return `${label}=${String(value)}`;
}

function join(parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => !!p && p.length > 0).join(' | ');
}

export interface BuildRAGRecordsOptions {
  canonicalOperatorIndex?: CanonicalOperatorIndex;
  canonicalLocationIndex?: CanonicalLocationIndex;
}

function enrichWithCanonical(
  metadata: RAGRecordMetadata,
  rawOperatorKey: string | undefined,
  index: CanonicalOperatorIndex | undefined
): void {
  if (!index || !rawOperatorKey) return;
  const resolved = lookupCanonicalOperator(rawOperatorKey, index);
  if (!resolved) return;
  metadata.rawOperatorKey = rawOperatorKey;
  metadata.canonicalOperatorKey = resolved.canonicalOperatorKey;
  if (resolved.entry.displayName !== undefined) {
    metadata.operatorDisplayName = resolved.entry.displayName;
  } else if (resolved.entry.legalName !== undefined) {
    metadata.operatorDisplayName = resolved.entry.legalName;
  }
  metadata.operatorConfidence = resolved.entry.identityConfidence;
}

function enrichWithCanonicalLocation(
  metadata: RAGRecordMetadata,
  rawLocationKey: string | undefined,
  index: CanonicalLocationIndex | undefined
): void {
  if (!index || !rawLocationKey) return;
  const resolved = lookupCanonicalLocation(rawLocationKey, index);
  if (!resolved) return;
  metadata.rawLocationKey = rawLocationKey;
  metadata.canonicalLocationKey = resolved.canonicalLocationKey;
  metadata.locationDisplayName = resolved.entry.preferredName;
  metadata.locationConfidence = resolved.entry.confidence;
  if (resolved.entry.kind !== undefined) {
    metadata.locationKind = resolved.entry.kind;
  }
}

export function buildRAGRecords(
  projection: TruthProjection,
  options: BuildRAGRecordsOptions = {}
): RAGRecord[] {
  const records: RAGRecord[] = [];
  const idx = options.canonicalOperatorIndex;
  const locIdx = options.canonicalLocationIndex;

  for (const s of projection.sessions) {
    const text = join([
      'session',
      fact('operator', s.operatorKey),
      fact('sessionKey', s.sessionKey),
      fact('startedAt', s.startedAt),
      fact('endedAt', s.endedAt),
      fact('timezoneMode', s.timezoneMode),
      s.evidence.length ? `evidence=${s.evidence.join(',')}` : null,
    ]);
    const metadata: RAGRecordMetadata = { type: 'session', sessionKey: s.sessionKey };
    if (s.operatorKey !== undefined) metadata.operatorKey = s.operatorKey;
    if (s.startedAt !== undefined) metadata.timestamp = s.startedAt;
    enrichWithCanonical(metadata, s.operatorKey, idx);
    records.push({ text, metadata });
  }

  for (const e of projection.events) {
    const parts: Array<string | null> = [
      `event:${e.eventType}`,
      fact('at', e.occurredAt),
      fact('operator', e.operatorKey),
      fact('location', e.locationKey),
      fact('activity', e.activityKey),
      fact('recordId', e.relatedRecordId),
    ];
    if (e.payload) {
      for (const [k, v] of Object.entries(e.payload)) {
        parts.push(fact(k, v));
      }
    }
    const text = join(parts);
    const metadata: RAGRecordMetadata = { type: 'event' };
    if (e.operatorKey !== undefined) metadata.operatorKey = e.operatorKey;
    if (e.sessionKey !== undefined) metadata.sessionKey = e.sessionKey;
    if (e.locationKey !== undefined) metadata.locationKey = e.locationKey;
    if (e.activityKey !== undefined) metadata.activityKey = e.activityKey;
    if (e.occurredAt !== undefined) metadata.timestamp = e.occurredAt;
    enrichWithCanonical(metadata, e.operatorKey, idx);
    enrichWithCanonicalLocation(metadata, e.locationKey, locIdx);
    records.push({ text, metadata });
  }

  for (const j of projection.jsaViews) {
    for (const entry of j.entries) {
      const locationKey = `loc:${entry.normalizedName}`;
      const text = join([
        'jsa_entry',
        fact('jsa', j.jsaKey),
        fact('operator', j.operatorKey),
        fact('name', entry.name),
        fact('kind', entry.kind),
        fact('pickupDropoffType', entry.pickupDropoffType),
        fact('activity', entry.activityLabel),
        fact('operator_field', entry.operator),
        fact('county', entry.county),
        fact('dispatchId', entry.dispatchId),
        fact('stampedAt', entry.stampedAt),
      ]);
      const metadata: RAGRecordMetadata = {
        type: 'jsa_entry',
        locationKey,
      };
      if (j.operatorKey !== undefined) metadata.operatorKey = j.operatorKey;
      if (entry.stampedAt !== undefined) metadata.timestamp = entry.stampedAt;
      enrichWithCanonical(metadata, j.operatorKey, idx);
      enrichWithCanonicalLocation(metadata, locationKey, locIdx);
      records.push({ text, metadata });
    }
  }

  return records.sort((a, b) => {
    const ta = a.metadata.timestamp ?? '';
    const tb = b.metadata.timestamp ?? '';
    if (ta !== tb) return ta.localeCompare(tb);
    if (a.metadata.type !== b.metadata.type) {
      return a.metadata.type.localeCompare(b.metadata.type);
    }
    return a.text.localeCompare(b.text);
  });
}
