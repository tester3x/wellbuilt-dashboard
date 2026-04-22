import * as httpsV2 from 'firebase-functions/v2/https';
import { HttpsError } from 'firebase-functions/v2/https';
import { requireAdminRole } from './requireAdminRole';
import { runTruthRagExport } from './truthRagExportCore';

interface ExportRequest {
  date?: string;
  companyId?: string;
  runId?: string;
}

function parseRequest(
  data: unknown
): { date: string; companyId?: string; runId?: string } {
  const req = (data ?? {}) as ExportRequest;
  if (typeof req.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(req.date)) {
    throw new HttpsError('invalid-argument', 'Missing/invalid date (YYYY-MM-DD).');
  }
  const out: { date: string; companyId?: string; runId?: string } = {
    date: req.date,
  };
  if (typeof req.companyId === 'string' && req.companyId.length > 0) {
    out.companyId = req.companyId;
  }
  if (typeof req.runId === 'string' && req.runId.length > 0) {
    out.runId = req.runId;
  }
  return out;
}

/**
 * Manual admin-triggered RAG export. Writes to the derived export
 * destination only. See truthRagExportCore.ts for manifest + status flow.
 */
export const exportTruthRagForDay = httpsV2.onCall(
  { timeoutSeconds: 300, memory: '1GiB' },
  async (request) => {
    const identity = await requireAdminRole(request);
    const parsed = parseRequest(request.data);
    const companyScope = parsed.companyId ?? identity.companyId;
    const coreParams: Parameters<typeof runTruthRagExport>[0] = {
      identity,
      date: parsed.date,
      mode: 'manual',
    };
    if (companyScope) coreParams.companyId = companyScope;
    if (parsed.runId) coreParams.runId = parsed.runId;
    return runTruthRagExport(coreParams);
  }
);
