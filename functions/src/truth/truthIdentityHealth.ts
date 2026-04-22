import * as httpsV2 from 'firebase-functions/v2/https';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  buildCanonicalProjection,
  buildIdentityHealthDashboardSummary,
  buildIdentityHealthSnapshot,
  buildIdentityHealthView,
  buildTruthProjection,
  validateProjection,
} from '../truth-layer';
import { requireAdminRole } from './requireAdminRole';
import { loadTruthInputForDay } from './loadTruthInputForDay';

interface RawRequest {
  date?: string;
  companyId?: string;
  /** When true, include the full per-operator diagnostics[]. Defaults to false. */
  includeDiagnostics?: boolean;
}

function parseRequest(data: unknown): {
  date: string;
  companyId?: string;
  includeDiagnostics: boolean;
} {
  const req = (data ?? {}) as RawRequest;
  if (typeof req.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(req.date)) {
    throw new HttpsError('invalid-argument', 'Missing/invalid date (YYYY-MM-DD).');
  }
  const out: { date: string; companyId?: string; includeDiagnostics: boolean } = {
    date: req.date,
    includeDiagnostics: req.includeDiagnostics === true,
  };
  if (typeof req.companyId === 'string' && req.companyId.length > 0) {
    out.companyId = req.companyId;
  }
  return out;
}

/**
 * Admin-gated read-only identity-health surface.
 *
 * Returns the lean dashboard summary by default; includeDiagnostics=true also
 * returns the full per-operator diagnostics + issue groups. Also returns a
 * deterministic snapshot for future history/trending (NOT persisted).
 */
export const getIdentityHealthView = httpsV2.onCall(
  { timeoutSeconds: 120, memory: '512MiB' },
  async (request) => {
    const identity = await requireAdminRole(request);
    const parsed = parseRequest(request.data);
    const companyScope = parsed.companyId ?? identity.companyId;

    const loadParams: { date: string; companyId?: string } = { date: parsed.date };
    if (companyScope) loadParams.companyId = companyScope;
    const { input, sourceErrors, loaded } = await loadTruthInputForDay(loadParams);

    const projection = buildTruthProjection(input);
    const canonical = buildCanonicalProjection(projection);
    const warnings = validateProjection(projection);

    const view = buildIdentityHealthView(projection, canonical, { warnings });
    const dashboard = buildIdentityHealthDashboardSummary(view);
    const snapshot = buildIdentityHealthSnapshot(view, dashboard, {
      date: parsed.date,
    });

    const response: Record<string, unknown> = {
      dashboard,
      snapshot,
      generatedAt: view.generatedAt,
      loaded,
      sourceErrors,
    };
    if (parsed.includeDiagnostics) {
      response.view = view;
    }
    return response;
  }
);
