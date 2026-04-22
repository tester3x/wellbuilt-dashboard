import type { TruthProjection } from './types';
import type {
  CanonicalProjection,
  LocationCanonicalView,
  OperatorCanonicalView,
} from './types.canonical';
import type {
  CanonicalRAGRecord,
  CanonicalRAGRecordMetadata,
} from './types.dashboard';
import { resolveActivityRef } from './normalizeActivity';
import { getIdentityConfidence } from './canonicalIdentity';
import { getLocationConfidence } from './canonicalLocationIdentity';

/**
 * Populate Phase 9 operator-identity metadata on a canonical RAG record.
 * Only fills fields that are resolvable — never injects defaults when
 * the operator is unknown.
 */
function enrichOperatorIdentity(
  metadata: CanonicalRAGRecordMetadata,
  canonicalOp: OperatorCanonicalView | undefined
): void {
  if (!canonicalOp) return;
  if (canonicalOp.displayName !== undefined) {
    metadata.operatorDisplayName = canonicalOp.displayName;
  } else if (canonicalOp.legalName !== undefined) {
    metadata.operatorDisplayName = canonicalOp.legalName;
  }
  metadata.operatorConfidence = getIdentityConfidence(canonicalOp);
}

/**
 * Populate Phase 11 location-identity metadata on a canonical RAG record.
 * Only fills fields that are resolvable — never invents official backing
 * for custom/fallback locations.
 */
function enrichLocationIdentity(
  metadata: CanonicalRAGRecordMetadata,
  canonicalLoc: LocationCanonicalView | undefined
): void {
  if (!canonicalLoc) return;
  metadata.locationDisplayName = canonicalLoc.preferredName;
  metadata.locationConfidence = getLocationConfidence(canonicalLoc);
  if (canonicalLoc.kind !== undefined) {
    metadata.locationKind = canonicalLoc.kind;
  }
}

function fact(label: string, value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  return `${label}=${String(value)}`;
}

function join(parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => !!p && p.length > 0).join(' | ');
}

export function buildCanonicalRAGRecords(
  projection: TruthProjection,
  canonical: CanonicalProjection
): CanonicalRAGRecord[] {
  const rawOpToCanonical = new Map<string, string>();
  const canonicalOpByKey = new Map<
    string,
    CanonicalProjection['canonicalOperators'][number]
  >();
  for (const op of canonical.canonicalOperators) {
    canonicalOpByKey.set(op.canonicalOperatorKey, op);
    for (const linked of op.linkedKeys) {
      rawOpToCanonical.set(linked, op.canonicalOperatorKey);
    }
  }

  const rawLocToCanonical = new Map<string, string>();
  const canonicalLocByKey = new Map<
    string,
    CanonicalProjection['canonicalLocations'][number]
  >();
  for (const loc of canonical.canonicalLocations) {
    canonicalLocByKey.set(loc.canonicalLocationKey, loc);
    for (const linked of loc.linkedKeys) {
      rawLocToCanonical.set(linked, loc.canonicalLocationKey);
    }
  }

  const rawActToCanonical = new Map<string, string>();
  const canonicalActByKey = new Map<
    string,
    CanonicalProjection['canonicalActivities'][number]
  >();
  for (const act of canonical.canonicalActivities) {
    canonicalActByKey.set(act.canonicalActivityKey, act);
    for (const linked of act.linkedKeys) {
      rawActToCanonical.set(linked, act.canonicalActivityKey);
    }
  }

  const records: CanonicalRAGRecord[] = [];

  for (const s of projection.sessions) {
    const canonicalOp = s.operatorKey
      ? rawOpToCanonical.get(s.operatorKey)
      : undefined;
    const text = join([
      'session',
      fact('sessionKey', s.sessionKey),
      fact('rawOperator', s.operatorKey),
      fact('canonicalOperator', canonicalOp),
      fact('startedAt', s.startedAt),
      fact('endedAt', s.endedAt),
      fact('isOpen', s.isOpen),
      fact('durationConfidence', s.durationConfidence),
      fact('timezoneMode', s.timezoneMode),
      s.evidence.length ? `evidence=${s.evidence.join(',')}` : null,
    ]);
    const metadata: CanonicalRAGRecordMetadata = {
      type: 'session',
      sessionKey: s.sessionKey,
    };
    if (s.operatorKey !== undefined) metadata.rawOperatorKey = s.operatorKey;
    if (canonicalOp !== undefined) metadata.canonicalOperatorKey = canonicalOp;
    if (s.startedAt !== undefined) metadata.timestamp = s.startedAt;
    enrichOperatorIdentity(
      metadata,
      canonicalOp ? canonicalOpByKey.get(canonicalOp) : undefined
    );
    records.push({ text, metadata });
  }

  for (const e of projection.events) {
    const canonicalOp = e.operatorKey
      ? rawOpToCanonical.get(e.operatorKey)
      : undefined;
    const canonicalLoc = e.locationKey
      ? rawLocToCanonical.get(e.locationKey)
      : undefined;
    let rawActForEvent: string | undefined = e.activityKey;
    if (!rawActForEvent && e.payload) {
      const jobType =
        typeof e.payload.jobType === 'string' ? e.payload.jobType : undefined;
      const commodityType =
        typeof e.payload.commodityType === 'string'
          ? e.payload.commodityType
          : undefined;
      const ref =
        (jobType && resolveActivityRef({ jobActivityName: jobType })) ||
        (commodityType && resolveActivityRef({ commodityType })) ||
        null;
      if (ref) rawActForEvent = ref.activityKey;
    }
    const canonicalAct = rawActForEvent
      ? rawActToCanonical.get(rawActForEvent) ?? rawActForEvent
      : undefined;
    const parts: Array<string | null> = [
      `event:${e.eventType}`,
      fact('at', e.occurredAt),
      fact('rawOperator', e.operatorKey),
      fact('canonicalOperator', canonicalOp),
      fact('rawLocation', e.locationKey),
      fact('canonicalLocation', canonicalLoc),
      fact('rawActivity', rawActForEvent),
      fact('canonicalActivity', canonicalAct),
      fact('recordId', e.relatedRecordId),
    ];
    if (e.payload) {
      for (const [k, v] of Object.entries(e.payload)) {
        parts.push(fact(k, v));
      }
    }
    const text = join(parts);
    const metadata: CanonicalRAGRecordMetadata = { type: 'event' };
    if (e.operatorKey !== undefined) metadata.rawOperatorKey = e.operatorKey;
    if (canonicalOp !== undefined) metadata.canonicalOperatorKey = canonicalOp;
    if (e.locationKey !== undefined) metadata.rawLocationKey = e.locationKey;
    if (canonicalLoc !== undefined) metadata.canonicalLocationKey = canonicalLoc;
    if (rawActForEvent !== undefined) metadata.rawActivityKey = rawActForEvent;
    if (canonicalAct !== undefined) metadata.canonicalActivityKey = canonicalAct;
    if (e.sessionKey !== undefined) metadata.sessionKey = e.sessionKey;
    if (e.occurredAt !== undefined) metadata.timestamp = e.occurredAt;
    enrichOperatorIdentity(
      metadata,
      canonicalOp ? canonicalOpByKey.get(canonicalOp) : undefined
    );
    enrichLocationIdentity(
      metadata,
      canonicalLoc ? canonicalLocByKey.get(canonicalLoc) : undefined
    );
    records.push({ text, metadata });
  }

  for (const j of projection.jsaViews) {
    const canonicalOp = j.operatorKey
      ? rawOpToCanonical.get(j.operatorKey)
      : undefined;
    for (const entry of j.entries) {
      const rawLocKey = `loc:${entry.normalizedName}`;
      const canonicalLoc = rawLocToCanonical.get(rawLocKey);
      let rawAct: string | undefined;
      let canonicalAct: string | undefined;
      if (entry.activityLabel) {
        const ref = resolveActivityRef({ jobActivityName: entry.activityLabel });
        if (ref) {
          rawAct = ref.activityKey;
          canonicalAct = rawActToCanonical.get(ref.activityKey);
        }
      }
      const text = join([
        'jsa_entry',
        fact('jsa', j.jsaKey),
        fact('rawOperator', j.operatorKey),
        fact('canonicalOperator', canonicalOp),
        fact('rawLocation', rawLocKey),
        fact('canonicalLocation', canonicalLoc),
        fact('rawActivity', rawAct),
        fact('canonicalActivity', canonicalAct),
        fact('name', entry.name),
        fact('kind', entry.kind),
        fact('pickupDropoffType', entry.pickupDropoffType),
        fact('activity', entry.activityLabel),
        fact('hasActivityBinding', entry.hasActivityBinding),
        fact('operator_field', entry.operator),
        fact('county', entry.county),
        fact('dispatchId', entry.dispatchId),
        fact('stampedAt', entry.stampedAt),
      ]);
      const metadata: CanonicalRAGRecordMetadata = {
        type: 'jsa_entry',
        rawLocationKey: rawLocKey,
      };
      if (canonicalLoc !== undefined) metadata.canonicalLocationKey = canonicalLoc;
      if (j.operatorKey !== undefined) metadata.rawOperatorKey = j.operatorKey;
      if (canonicalOp !== undefined) metadata.canonicalOperatorKey = canonicalOp;
      if (rawAct !== undefined) metadata.rawActivityKey = rawAct;
      if (canonicalAct !== undefined) metadata.canonicalActivityKey = canonicalAct;
      if (entry.stampedAt !== undefined) metadata.timestamp = entry.stampedAt;
      enrichOperatorIdentity(
        metadata,
        canonicalOp ? canonicalOpByKey.get(canonicalOp) : undefined
      );
      enrichLocationIdentity(
        metadata,
        canonicalLoc ? canonicalLocByKey.get(canonicalLoc) : undefined
      );
      records.push({ text, metadata });
    }
  }

  for (const op of canonical.canonicalOperators) {
    const text = join([
      'canonical_operator_summary',
      fact('canonicalOperator', op.canonicalOperatorKey),
      fact('displayName', op.displayName),
      fact('legalName', op.legalName),
      fact('companyName', op.companyName),
      fact('confidence', op.confidence),
      op.linkedKeys.length ? `linkedKeys=${op.linkedKeys.join(',')}` : null,
      op.mergedFrom.length ? `mergedFrom=${op.mergedFrom.join(',')}` : null,
    ]);
    const metadata: CanonicalRAGRecordMetadata = {
      type: 'canonical_operator_summary',
      canonicalOperatorKey: op.canonicalOperatorKey,
      confidence: op.confidence,
    };
    enrichOperatorIdentity(metadata, op);
    records.push({ text, metadata });
  }

  for (const loc of canonical.canonicalLocations) {
    const text = join([
      'canonical_location_summary',
      fact('canonicalLocation', loc.canonicalLocationKey),
      fact('preferredName', loc.preferredName),
      fact('kind', loc.kind),
      fact('operator', loc.operator),
      fact('county', loc.county),
      fact('confidence', loc.confidence),
      loc.aliases.length ? `aliases=${loc.aliases.join(',')}` : null,
    ]);
    const metadata: CanonicalRAGRecordMetadata = {
      type: 'canonical_location_summary',
      canonicalLocationKey: loc.canonicalLocationKey,
      confidence: loc.confidence,
    };
    enrichLocationIdentity(metadata, loc);
    records.push({ text, metadata });
  }

  for (const act of canonical.canonicalActivities) {
    const rawValues = act.rawLabels.map((l) => l.value);
    const text = join([
      'canonical_activity_summary',
      fact('canonicalActivity', act.canonicalActivityKey),
      fact('canonicalLabel', act.canonicalLabel),
      fact('family', act.family),
      fact('confidence', act.confidence),
      rawValues.length ? `rawLabels=${rawValues.join(',')}` : null,
    ]);
    const metadata: CanonicalRAGRecordMetadata = {
      type: 'canonical_activity_summary',
      canonicalActivityKey: act.canonicalActivityKey,
      confidence: act.confidence,
    };
    records.push({ text, metadata });
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
