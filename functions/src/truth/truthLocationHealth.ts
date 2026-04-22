import * as httpsV2 from 'firebase-functions/v2/https';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  buildCanonicalProjection,
  buildLocationHealthDashboardSummary,
  buildLocationHealthView,
  buildTruthProjection,
} from '../truth-layer';
import { requireAdminRole } from './requireAdminRole';
import { loadTruthInputForDay } from './loadTruthInputForDay';
import { loadLocationApprovals } from './loadLocationApprovals';

interface RawRequest {
  date?: string;
  companyId?: string;
  /** When true, include full per-location diagnostics[]. Defaults to false. */
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
 * Admin-gated read-only location-health surface.
 *
 * Returns the lean dashboard summary by default; includeDiagnostics=true also
 * returns the full per-location diagnostics. Visibility only — no severity
 * scoring, no headline status, no risk flags. Custom/fallback locations are
 * surfaced as informational, not as errors.
 */
export const getLocationHealthView = httpsV2.onCall(
  { timeoutSeconds: 120, memory: '512MiB' },
  async (request) => {
    await requireAdminRole(request);
    const parsed = parseRequest(request.data);

    const loadParams: { date: string; companyId?: string } = { date: parsed.date };
    if (parsed.companyId) loadParams.companyId = parsed.companyId;
    const { input, sourceErrors, loaded } = await loadTruthInputForDay(loadParams);

    const projection = buildTruthProjection(input);
    const canonical = buildCanonicalProjection(projection);

    // Phase 17 — fold persisted admin location approvals into the view.
    // Loader is best-effort; if it errors, the view still renders with the
    // original derived-only classification. sourceError string is appended
    // to the existing sourceErrors array so admins can see loader issues.
    const approvalResult = await loadLocationApprovals(parsed.companyId);
    if (approvalResult.sourceError) {
      sourceErrors.push(approvalResult.sourceError);
    }

    const view = buildLocationHealthView(canonical, {
      manualApprovalsByKey: approvalResult.approvalsByKey,
    });
    const dashboard = buildLocationHealthDashboardSummary(view);

    const response: Record<string, unknown> = {
      dashboard,
      generatedAt: view.generatedAt,
      loaded,
      sourceErrors,
      approvalsApplied: approvalResult.count,
    };
    if (parsed.includeDiagnostics) {
      response.view = view;
    }
    return response;
  }
);
