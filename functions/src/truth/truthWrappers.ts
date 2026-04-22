import * as httpsV2 from 'firebase-functions/v2/https';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  buildIntegratedTruthBundle,
  buildDashboardReadModel,
  buildRAGIngestBundle,
  buildShadowComparisonBundle,
} from '../truth-layer';
import { requireAdminRole } from './requireAdminRole';
import { loadTruthInputForDay } from './loadTruthInputForDay';

interface DayRequest {
  date?: string;
  companyId?: string;
}

function parseRequest(
  data: unknown
): { date: string; companyId?: string } {
  const req = (data ?? {}) as DayRequest;
  if (typeof req.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(req.date)) {
    throw new HttpsError('invalid-argument', 'Missing/invalid date (YYYY-MM-DD).');
  }
  const out: { date: string; companyId?: string } = { date: req.date };
  if (typeof req.companyId === 'string' && req.companyId.length > 0) {
    out.companyId = req.companyId;
  }
  return out;
}

const callableOpts = { timeoutSeconds: 120, memory: '512MiB' as const };

/**
 * Shadow read-only endpoint. Returns an IntegratedTruthBundle for one day.
 * Never writes. Gated to admin/it role via requireAdminRole.
 */
export const getIntegratedTruthForDay = httpsV2.onCall(
  callableOpts,
  async (request) => {
    const identity = await requireAdminRole(request);
    const parsed = parseRequest(request.data);
    const companyScope = parsed.companyId ?? identity.companyId;
    const loadParams: { date: string; companyId?: string } = { date: parsed.date };
    if (companyScope) loadParams.companyId = companyScope;
    const { input, sourceErrors, loaded } = await loadTruthInputForDay(loadParams);
    const bundle = buildIntegratedTruthBundle(input);
    return { bundle, sourceErrors, loaded };
  }
);

/**
 * Shadow read-only endpoint. Returns a DashboardReadModel for one day.
 */
export const getDashboardReadModelForDay = httpsV2.onCall(
  callableOpts,
  async (request) => {
    const identity = await requireAdminRole(request);
    const parsed = parseRequest(request.data);
    const companyScope = parsed.companyId ?? identity.companyId;
    const loadParams: { date: string; companyId?: string } = { date: parsed.date };
    if (companyScope) loadParams.companyId = companyScope;
    const { input, sourceErrors, loaded } = await loadTruthInputForDay(loadParams);
    const bundle = buildIntegratedTruthBundle(input);
    const model = buildDashboardReadModel(bundle);
    return { model, sourceErrors, loaded };
  }
);

/**
 * Shadow read-only endpoint. Returns a RAGIngestBundle for one day
 * (raw + canonical records + stats).
 */
export const getRAGIngestBundleForDay = httpsV2.onCall(
  callableOpts,
  async (request) => {
    const identity = await requireAdminRole(request);
    const parsed = parseRequest(request.data);
    const companyScope = parsed.companyId ?? identity.companyId;
    const loadParams: { date: string; companyId?: string } = { date: parsed.date };
    if (companyScope) loadParams.companyId = companyScope;
    const { input, sourceErrors, loaded } = await loadTruthInputForDay(loadParams);
    const bundle = buildIntegratedTruthBundle(input);
    const rag = buildRAGIngestBundle(bundle);
    return { rag, sourceErrors, loaded };
  }
);

/**
 * Shadow read-only endpoint. Returns a ShadowComparisonBundle for one day.
 */
export const getShadowComparisonForDay = httpsV2.onCall(
  callableOpts,
  async (request) => {
    const identity = await requireAdminRole(request);
    const parsed = parseRequest(request.data);
    const companyScope = parsed.companyId ?? identity.companyId;
    const loadParams: { date: string; companyId?: string } = { date: parsed.date };
    if (companyScope) loadParams.companyId = companyScope;
    const { input, sourceErrors, loaded } = await loadTruthInputForDay(loadParams);
    const bundle = buildIntegratedTruthBundle(input);
    const shadow = buildShadowComparisonBundle(bundle);
    return { shadow, sourceErrors, loaded };
  }
);
