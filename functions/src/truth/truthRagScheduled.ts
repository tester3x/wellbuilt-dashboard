// ════════════════════════════════════════════════════════════════════════
// DISABLED BY DEFAULT — scheduled export prep template (Phase 8).
//
// This file is a TEMPLATE showing how a future scheduled job would invoke
// the same derived export path as the admin-triggered callables. It does
// NOT register a scheduler, does NOT run automatically, and is NOT exported
// from functions/src/index.ts.
//
// To promote this to a live schedule in a later phase:
//   1. Decide the cron expression + timezone (document in PR).
//   2. Wire the handler via `onSchedule('…', …)` from
//      'firebase-functions/v2/scheduler'.
//   3. Export the handler name from functions/src/index.ts.
//   4. Deploy functions.
//
// Keep this gate in place until a later phase explicitly approves promotion.
// ════════════════════════════════════════════════════════════════════════
import type { AdminIdentity } from './requireAdminRole';
import { runTruthRagExport } from './truthRagExportCore';

export interface PrepareScheduledTruthRagExportParams {
  date: string;
  companyId?: string;
  /** Service-account identity whose uid/role will be recorded in the manifest. */
  identity: AdminIdentity;
  reason?: string;
}

/**
 * Helper-only export. NOT a Cloud Function (no httpsV2.onCall / onSchedule
 * wrapper). A future scheduled-job handler can call this to produce a run
 * with mode='scheduled_prep' without re-implementing the export logic.
 *
 * Callers MUST provide an identity — there is no anonymous scheduler path.
 */
export async function prepareScheduledTruthRagExport(
  params: PrepareScheduledTruthRagExportParams
) {
  const coreParams: Parameters<typeof runTruthRagExport>[0] = {
    identity: params.identity,
    date: params.date,
    mode: 'scheduled_prep',
  };
  if (params.companyId) coreParams.companyId = params.companyId;
  if (params.reason) coreParams.reason = params.reason;
  return runTruthRagExport(coreParams);
}
