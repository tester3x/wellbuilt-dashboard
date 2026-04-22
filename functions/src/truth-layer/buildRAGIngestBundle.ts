import { buildRAGRecords } from './buildRAGRecords';
import { buildCanonicalRAGRecords } from './buildCanonicalRAGRecords';
import type {
  IntegratedTruthBundle,
  RAGIngestBundle,
  RAGIngestBundleStats,
} from './types.integration';

export interface BuildRAGIngestBundleOptions {
  generatedAt?: string;
}

function countByType<T extends { metadata: { type: string } }>(
  records: T[]
): Record<string, number> {
  const by: Record<string, number> = {};
  for (const r of records) {
    by[r.metadata.type] = (by[r.metadata.type] ?? 0) + 1;
  }
  return by;
}

export function buildRAGIngestBundle(
  bundle: IntegratedTruthBundle,
  options: BuildRAGIngestBundleOptions = {}
): RAGIngestBundle {
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  // Phase 9/11 — thread the canonical operator + location indexes into the raw
  // RAG builder so every raw record can surface canonical identity alongside
  // the legacy keys. Never overwrites raw fields; only adds new ones.
  const rawRagRecords = buildRAGRecords(bundle.truthProjection, {
    canonicalOperatorIndex: bundle.canonicalOperatorIndex,
    canonicalLocationIndex: bundle.canonicalLocationIndex,
  });
  const canonicalRagRecords = buildCanonicalRAGRecords(
    bundle.truthProjection,
    bundle.canonicalProjection
  );

  const canonicalByType = countByType(canonicalRagRecords);
  const summaryRecordCount =
    (canonicalByType['canonical_operator_summary'] ?? 0) +
    (canonicalByType['canonical_location_summary'] ?? 0) +
    (canonicalByType['canonical_activity_summary'] ?? 0);

  const stats: RAGIngestBundleStats = {
    rawCount: rawRagRecords.length,
    canonicalCount: canonicalRagRecords.length,
    eventCount: canonicalByType['event'] ?? 0,
    jsaRecordCount: canonicalByType['jsa_entry'] ?? 0,
    sessionRecordCount: canonicalByType['session'] ?? 0,
    summaryRecordCount,
  };

  return {
    rawRagRecords,
    canonicalRagRecords,
    warnings: bundle.validationWarnings,
    generatedAt,
    stats,
  };
}
