import * as httpsV2 from 'firebase-functions/v2/https';
import { HttpsError } from 'firebase-functions/v2/https';
import { requireAdminRole } from './requireAdminRole';
import { runTruthRagExport } from './truthRagExportCore';

interface RerunRequest {
  date?: string;
  companyId?: string;
  reason?: string;
}

function parseRequest(
  data: unknown
): { date: string; companyId?: string; reason?: string } {
  const req = (data ?? {}) as RerunRequest;
  if (typeof req.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(req.date)) {
    throw new HttpsError('invalid-argument', 'Missing/invalid date (YYYY-MM-DD).');
  }
  const out: { date: string; companyId?: string; reason?: string } = {
    date: req.date,
  };
  if (typeof req.companyId === 'string' && req.companyId.length > 0) {
    out.companyId = req.companyId;
  }
  if (typeof req.reason === 'string' && req.reason.length > 0) {
    out.reason = req.reason;
  }
  return out;
}

/**
 * Rerun the derived RAG export for a (date, companyId) pair.
 *
 * - mode='rerun'
 * - ALWAYS creates a new runId (any `runId` in the request is ignored).
 * - Older runs are never touched; history is append-only.
 * - Optional `reason` is stored in the new manifest.
 */
export const rerunTruthRagExportForDay = httpsV2.onCall(
  { timeoutSeconds: 300, memory: '1GiB' },
  async (request) => {
    const identity = await requireAdminRole(request);
    const parsed = parseRequest(request.data);
    const companyScope = parsed.companyId ?? identity.companyId;
    const coreParams: Parameters<typeof runTruthRagExport>[0] = {
      identity,
      date: parsed.date,
      mode: 'rerun',
    };
    if (companyScope) coreParams.companyId = companyScope;
    if (parsed.reason) coreParams.reason = parsed.reason;
    // Intentionally do NOT forward any caller-supplied runId — rerun always
    // creates a new run.
    return runTruthRagExport(coreParams);
  }
);
