import * as admin from 'firebase-admin';
import * as httpsV2 from 'firebase-functions/v2/https';
import { HttpsError } from 'firebase-functions/v2/https';
import { requireAdminRole } from './requireAdminRole';
import {
  EXPORT_COLLECTION,
  RAW_SUBCOLLECTION,
  CANONICAL_SUBCOLLECTION,
} from './truthRagExportCore';

const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;
const DEFAULT_SAMPLE_SIZE = 10;
const MAX_SAMPLE_SIZE = 50;

type DocSnap = FirebaseFirestore.QueryDocumentSnapshot;

interface ListRequest {
  dateFrom?: string;
  dateTo?: string;
  companyId?: string;
  limit?: number;
}

interface DetailRequest {
  runId?: string;
  sampleSize?: number;
}

function parseListRequest(data: unknown): {
  dateFrom?: string;
  dateTo?: string;
  companyId?: string;
  limit: number;
} {
  const req = (data ?? {}) as ListRequest;
  const out: { dateFrom?: string; dateTo?: string; companyId?: string; limit: number } = {
    limit: DEFAULT_LIST_LIMIT,
  };
  if (typeof req.dateFrom === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.dateFrom)) {
    out.dateFrom = req.dateFrom;
  }
  if (typeof req.dateTo === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.dateTo)) {
    out.dateTo = req.dateTo;
  }
  if (typeof req.companyId === 'string' && req.companyId.length > 0) {
    out.companyId = req.companyId;
  }
  if (typeof req.limit === 'number' && req.limit > 0) {
    out.limit = Math.min(req.limit, MAX_LIST_LIMIT);
  }
  return out;
}

function parseDetailRequest(
  data: unknown
): { runId: string; sampleSize: number } {
  const req = (data ?? {}) as DetailRequest;
  if (typeof req.runId !== 'string' || req.runId.length === 0) {
    throw new HttpsError('invalid-argument', 'Missing runId.');
  }
  let sampleSize = DEFAULT_SAMPLE_SIZE;
  if (typeof req.sampleSize === 'number' && req.sampleSize >= 0) {
    sampleSize = Math.min(req.sampleSize, MAX_SAMPLE_SIZE);
  }
  return { runId: req.runId, sampleSize };
}

/** Lightweight manifest projection for the history list. */
function projectManifestSummary(doc: DocSnap): Record<string, unknown> {
  const d = doc.data();
  return {
    runId: doc.id,
    date: d.date,
    companyId: d.companyId ?? null,
    mode: d.mode,
    status: d.status,
    generatedAt: d.generatedAt,
    startedAt: d.startedAt,
    completedAt: d.completedAt ?? null,
    durationMs: d.durationMs ?? null,
    warningCount: d.warningCount ?? 0,
    stats: d.stats ?? null,
    notableFindings: d.notableFindings ?? [],
    triggeredBy: d.triggeredBy ?? null,
    sourceErrorCount: Array.isArray(d.sourceErrors) ? d.sourceErrors.length : 0,
    reason: d.reason ?? null,
    errorMessage: d.errorMessage ?? null,
  };
}

/**
 * Admin-gated read-only list of prior export runs. Never loads the raw or
 * canonical subcollections — list rows carry manifest fields only.
 * Newest-first by `startedAt`.
 */
export const listTruthRagExports = httpsV2.onCall(
  { timeoutSeconds: 60, memory: '256MiB' },
  async (request) => {
    const identity = await requireAdminRole(request);
    const parsed = parseListRequest(request.data);

    const firestore = admin.firestore();
    let query: FirebaseFirestore.Query = firestore.collection(EXPORT_COLLECTION);
    if (parsed.dateFrom) {
      query = query.where('date', '>=', parsed.dateFrom);
    }
    if (parsed.dateTo) {
      query = query.where('date', '<=', parsed.dateTo);
    }
    // Hauler-scoped admins may only list their own company's runs.
    const companyScope = parsed.companyId ?? identity.companyId;
    if (companyScope) {
      query = query.where('companyId', '==', companyScope);
    }
    query = query.orderBy('date', 'desc').orderBy('startedAt', 'desc').limit(parsed.limit);

    const snap = await query.get();
    const runs = snap.docs.map(projectManifestSummary);
    return {
      count: runs.length,
      limit: parsed.limit,
      runs,
    };
  }
);

/**
 * Admin-gated read-only detail for a single run. Returns the full manifest
 * plus counted + sampled raw/canonical records. Never returns the full
 * record dump unless the run is already tiny (<= sampleSize).
 * Sample ordering is deterministic by document-id.
 */
export const getTruthRagExportRun = httpsV2.onCall(
  { timeoutSeconds: 60, memory: '256MiB' },
  async (request) => {
    await requireAdminRole(request);
    const parsed = parseDetailRequest(request.data);

    const firestore = admin.firestore();
    const runRef = firestore.collection(EXPORT_COLLECTION).doc(parsed.runId);
    const runSnap = await runRef.get();
    if (!runSnap.exists) {
      throw new HttpsError('not-found', `Run ${parsed.runId} not found.`);
    }
    const manifest = { runId: runSnap.id, ...runSnap.data() };

    const rawCol = runRef.collection(RAW_SUBCOLLECTION);
    const canonicalCol = runRef.collection(CANONICAL_SUBCOLLECTION);

    // Counts: use .count() aggregation to avoid pulling documents.
    const [rawCountSnap, canonicalCountSnap] = await Promise.all([
      rawCol.count().get(),
      canonicalCol.count().get(),
    ]);
    const rawRecordCount = rawCountSnap.data().count;
    const canonicalRecordCount = canonicalCountSnap.data().count;

    // Samples — deterministic by document-id order, limited.
    const fetchSample = async (col: FirebaseFirestore.CollectionReference) => {
      if (parsed.sampleSize === 0) return [];
      const s = await col
        .orderBy(admin.firestore.FieldPath.documentId())
        .limit(parsed.sampleSize)
        .get();
      return s.docs.map((d) => ({ _id: d.id, ...d.data() }));
    };
    const [sampleRawRecords, sampleCanonicalRecords] = await Promise.all([
      fetchSample(rawCol),
      fetchSample(canonicalCol),
    ]);

    return {
      manifest,
      rawRecordCount,
      canonicalRecordCount,
      sampleRawRecords,
      sampleCanonicalRecords,
      sampleSize: parsed.sampleSize,
    };
  }
);
