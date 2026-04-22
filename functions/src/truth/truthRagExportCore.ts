import * as admin from 'firebase-admin';
import {
  buildIntegratedTruthBundle,
  buildRAGIngestBundle,
  buildShadowComparisonBundle,
} from '../truth-layer';
import type { AdminIdentity } from './requireAdminRole';
import { loadTruthInputForDay } from './loadTruthInputForDay';

/**
 * DERIVED export destination. No operational collection is ever written.
 *
 *   truth_rag_exports/{runId}              ← manifest root doc
 *     raw_records/{autoId}                 ← RAGRecord
 *     canonical_records/{autoId}           ← CanonicalRAGRecord
 */
export const EXPORT_COLLECTION = 'truth_rag_exports';
export const RAW_SUBCOLLECTION = 'raw_records';
export const CANONICAL_SUBCOLLECTION = 'canonical_records';
const BATCH_CHUNK_SIZE = 400;

export type ExportMode = 'manual' | 'rerun' | 'scheduled_prep';
export type ExportStatus = 'started' | 'completed' | 'failed';

export interface RunTruthRagExportParams {
  identity: AdminIdentity;
  date: string;
  companyId?: string;
  mode: ExportMode;
  reason?: string;
  /** Optional explicit runId. Manual mode may honor it; rerun NEVER does. */
  runId?: string;
}

export interface RunTruthRagExportResult {
  runId: string;
  status: ExportStatus;
  collection: string;
  rawSubcollection: string;
  canonicalSubcollection: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  stats?: {
    rawCount: number;
    canonicalCount: number;
    eventCount: number;
    jsaRecordCount: number;
    sessionRecordCount: number;
    summaryRecordCount: number;
  };
  warningCount: number;
  sourceErrors: string[];
  notableFindings: string[];
  errorMessage?: string;
}

function defaultRunId(
  date: string,
  companyId: string | undefined,
  epochMs: number
): string {
  return `${date}_${companyId ?? 'all'}_${epochMs}`;
}

async function writeRecordsInChunks<T>(
  parentRef: admin.firestore.DocumentReference,
  subPath: string,
  records: T[]
): Promise<void> {
  const firestore = admin.firestore();
  const sub = parentRef.collection(subPath);
  for (let i = 0; i < records.length; i += BATCH_CHUNK_SIZE) {
    const chunk = records.slice(i, i + BATCH_CHUNK_SIZE);
    const batch = firestore.batch();
    for (const rec of chunk) {
      batch.set(sub.doc(), rec as unknown as Record<string, unknown>);
    }
    await batch.commit();
  }
}

/**
 * Shared internal core for all export modes (manual / rerun / scheduled_prep).
 * Writes manifest transitions: started → completed | failed.
 * Never writes outside EXPORT_COLLECTION.
 */
export async function runTruthRagExport(
  params: RunTruthRagExportParams
): Promise<RunTruthRagExportResult> {
  const startedAtDate = new Date();
  const startedAtEpoch = startedAtDate.getTime();
  const startedAt = startedAtDate.toISOString();

  const firestore = admin.firestore();
  const effectiveRunId =
    params.runId ?? defaultRunId(params.date, params.companyId, startedAtEpoch);
  const runRef = firestore.collection(EXPORT_COLLECTION).doc(effectiveRunId);

  // ── 1. Write initial manifest (status='started') ─────────────────────────
  const initialManifest: Record<string, unknown> = {
    runId: effectiveRunId,
    date: params.date,
    companyId: params.companyId ?? null,
    mode: params.mode,
    status: 'started' as ExportStatus,
    triggeredBy: { uid: params.identity.uid, role: params.identity.role },
    startedAt,
    generatedAt: startedAt,
  };
  if (params.reason) initialManifest.reason = params.reason;
  await runRef.set(initialManifest);

  try {
    // ── 2. Load data ──────────────────────────────────────────────────────
    const loadParams: { date: string; companyId?: string } = {
      date: params.date,
    };
    if (params.companyId) loadParams.companyId = params.companyId;
    const { input, sourceErrors, loaded } = await loadTruthInputForDay(loadParams);

    // ── 3. Build truth + canonical + RAG + shadow ─────────────────────────
    const bundle = buildIntegratedTruthBundle(input);
    const rag = buildRAGIngestBundle(bundle);
    const shadow = buildShadowComparisonBundle(bundle);

    // ── 4. Write subcollections ───────────────────────────────────────────
    await writeRecordsInChunks(runRef, RAW_SUBCOLLECTION, rag.rawRagRecords);
    await writeRecordsInChunks(
      runRef,
      CANONICAL_SUBCOLLECTION,
      rag.canonicalRagRecords
    );

    // ── 5. Finalize manifest (status='completed') ─────────────────────────
    const completedAtDate = new Date();
    const completedAt = completedAtDate.toISOString();
    const durationMs = completedAtDate.getTime() - startedAtEpoch;

    // Rename loaded.jsas → loaded.jsaDayStatus for the manifest per Phase 8 spec.
    // Leave the source `loaded` shape unchanged for non-export consumers.
    const manifestLoaded: Record<string, unknown> = {
      drivers: loaded.drivers,
      shifts: loaded.shifts,
      invoices: loaded.invoices,
      dispatches: loaded.dispatches,
      jsaDayStatus: loaded.jsas,
    };

    const completedPatch: Record<string, unknown> = {
      status: 'completed' as ExportStatus,
      completedAt,
      durationMs,
      generatedAt: rag.generatedAt,
      loaded: manifestLoaded,
      stats: rag.stats,
      warningCount: rag.warnings.length,
      sourceErrors,
      notableFindings: shadow.notableFindings,
    };
    await runRef.update(completedPatch);

    return {
      runId: effectiveRunId,
      status: 'completed',
      collection: EXPORT_COLLECTION,
      rawSubcollection: RAW_SUBCOLLECTION,
      canonicalSubcollection: CANONICAL_SUBCOLLECTION,
      startedAt,
      completedAt,
      durationMs,
      stats: rag.stats,
      warningCount: rag.warnings.length,
      sourceErrors,
      notableFindings: shadow.notableFindings,
    };
  } catch (err) {
    // ── Failure path: preserve partial manifest, mark failed ──────────────
    const failedAtDate = new Date();
    const failedAt = failedAtDate.toISOString();
    const durationMs = failedAtDate.getTime() - startedAtEpoch;
    const message = err instanceof Error ? err.message : String(err);
    const failedPatch: Record<string, unknown> = {
      status: 'failed' as ExportStatus,
      completedAt: failedAt,
      durationMs,
      errorMessage: message,
    };
    // Best-effort: if this update itself fails, do NOT swallow the original
    // error — it's the more important one to surface.
    try {
      await runRef.update(failedPatch);
    } catch {
      // ignore — original error thrown below
    }
    throw err;
  }
}
