// stageCReconcile.ts — partial Stage-C reconciliation (predeploy gate Rev-4
// Blocker 5). A name-filtered multi-function deploy is NOT atomic: the CLI can
// change some revisions and then fail, the process can die mid-run, or a
// revision lookup can be momentarily unavailable. The rollout controller must
// NEVER assume the whole command applied and must NEVER reopen on a CLI exit
// code. It reopens ONLY when all four intended consumer revisions are observed
// live. This pure function encodes that decision; the controller inventories
// live revisions and feeds them in.

export const STAGE_C_FUNCTIONS = [
  'processIncomingPull',
  'processEditRequest',
  'processDeleteRequest',
  'watchdogStrandedPackets',
] as const;

export type StageCFn = typeof STAGE_C_FUNCTIONS[number];

export interface ReconcileInput {
  intended: Record<string, string>;              // fn -> intended revision id
  observed: Record<string, string | null>;       // fn -> live revision id (null = not deployed / unknown)
  lookupOk: boolean;                              // did the live revision lookup itself succeed?
  cliExitCode?: number;                           // the deploy CLI exit code — DELIBERATELY not trusted for reopen
}

export interface ReconcileResult {
  complete: boolean;                 // all four intended revisions are live
  matched: string[];
  missing: string[];                 // not deployed yet (observed null)
  mismatched: string[];              // deployed but not the intended revision
  reopenAllowed: boolean;            // ONLY when complete AND the lookup itself succeeded
  action: 'reopen_ok' | 'complete_forward_deploy' | 'hold_closed';
  note: string;
}

/**
 * Decide the Stage-C state from live revisions. Fail-closed:
 * - a failed revision lookup → hold_closed (never assume);
 * - any missing/mismatched consumer → hold_closed, list the forward work;
 * - reopen is allowed ONLY when all four intended revisions are observed live.
 * The CLI exit code is intentionally ignored for the reopen decision — a
 * "successful" exit with incomplete revisions must NOT reopen, and a "failed"
 * exit whose revisions all actually match may proceed (decision follows the
 * live truth, not the exit code).
 */
export function reconcileStageC(input: ReconcileInput): ReconcileResult {
  if (!input.lookupOk) {
    return { complete: false, matched: [], missing: [], mismatched: [], reopenAllowed: false, action: 'hold_closed', note: 'revision lookup failed — cannot confirm; hold closed' };
  }
  const matched: string[] = [];
  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const fn of STAGE_C_FUNCTIONS) {
    const want = input.intended[fn];
    const have = input.observed[fn] ?? null;
    if (!want) { mismatched.push(fn); continue; } // no intended revision recorded → cannot confirm
    if (have === null) missing.push(fn);
    else if (have === want) matched.push(fn);
    else mismatched.push(fn);
  }
  const complete = matched.length === STAGE_C_FUNCTIONS.length;
  if (complete) {
    return { complete, matched, missing, mismatched, reopenAllowed: true, action: 'reopen_ok', note: 'all four consumer revisions match the reviewed build' };
  }
  return {
    complete, matched, missing, mismatched, reopenAllowed: false,
    action: 'complete_forward_deploy',
    note: `hold closed — forward-deploy ${[...missing, ...mismatched].join(', ')} (never reopen on a CLI exit code)`,
  };
}
