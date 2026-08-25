/**
 * Durable governed-edit apply checkpoint.
 *
 * Phases (RTDB packets/editApplyState/{editEventId}):
 *   captured   — incoming payload copied; no processed mutation yet
 *   mutated    — processed + immutable history written; no accepted receipt
 *   downstream — required outgoing/current/wells status committed (or not required)
 *   versioned  — incoming_version advanced exactly once for this event
 *   terminal   — accepted receipt published; incoming consumed
 *
 * Accepted is ONLY written at terminal. Crash/retry resumes the missing phase.
 * Same editEventId + same digest never double-applies, never double-increments
 * version, never duplicates history.
 */

export const GOVERNED_EDIT_APPLY_STATE_ROOT = 'packets/editApplyState';

export type GovernedEditApplyPhase =
  | 'captured'
  | 'mutated'
  | 'downstream'
  | 'versioned'
  | 'terminal';

export interface GovernedEditApplyState {
  editEventId: string;
  originalPacketId: string;
  incomingId: string;
  payloadDigest: string;
  wellName: string;
  noLevel: boolean;
  phase: GovernedEditApplyPhase;
  historyWritten: boolean;
  processedWritten: boolean;
  outgoingRequired: boolean;
  outgoingCommitted: boolean;
  wellStatusCommitted: boolean;
  versionPublished: boolean;
  publishedVersion: number | null;
  seqBefore: number | null;
  incomingPayload: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export function applyStatePath(editEventId: string): string {
  return `${GOVERNED_EDIT_APPLY_STATE_ROOT}/${editEventId}`;
}

const PHASE_RANK: Record<GovernedEditApplyPhase, number> = {
  captured: 0,
  mutated: 1,
  downstream: 2,
  versioned: 3,
  terminal: 4,
};

export function phaseAtLeast(
  state: GovernedEditApplyState | null | undefined,
  phase: GovernedEditApplyPhase,
): boolean {
  if (!state) return false;
  return PHASE_RANK[state.phase] >= PHASE_RANK[phase];
}

export function parseApplyState(raw: unknown): GovernedEditApplyState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.editEventId !== 'string' || !r.editEventId) return null;
  if (typeof r.payloadDigest !== 'string' || !r.payloadDigest) return null;
  const phase = r.phase;
  if (
    phase !== 'captured' && phase !== 'mutated' && phase !== 'downstream'
    && phase !== 'versioned' && phase !== 'terminal'
  ) {
    return null;
  }
  return {
    editEventId: r.editEventId,
    originalPacketId: typeof r.originalPacketId === 'string' ? r.originalPacketId : '',
    incomingId: typeof r.incomingId === 'string' ? r.incomingId : '',
    payloadDigest: r.payloadDigest,
    wellName: typeof r.wellName === 'string' ? r.wellName : '',
    noLevel: r.noLevel === true,
    phase,
    historyWritten: r.historyWritten === true,
    processedWritten: r.processedWritten === true,
    outgoingRequired: r.outgoingRequired === true,
    outgoingCommitted: r.outgoingCommitted === true,
    wellStatusCommitted: r.wellStatusCommitted === true,
    versionPublished: r.versionPublished === true,
    publishedVersion: typeof r.publishedVersion === 'number' ? r.publishedVersion : null,
    seqBefore: typeof r.seqBefore === 'number' ? r.seqBefore : null,
    incomingPayload: r.incomingPayload && typeof r.incomingPayload === 'object' && !Array.isArray(r.incomingPayload)
      ? r.incomingPayload as Record<string, unknown>
      : null,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : '',
  };
}

export function buildCapturedApplyState(args: {
  editEventId: string;
  originalPacketId: string;
  incomingId: string;
  payloadDigest: string;
  wellName: string;
  noLevel: boolean;
  now: string;
  incomingPayload?: Record<string, unknown> | null;
}): GovernedEditApplyState {
  return {
    editEventId: args.editEventId,
    originalPacketId: args.originalPacketId,
    incomingId: args.incomingId,
    payloadDigest: args.payloadDigest,
    wellName: args.wellName,
    noLevel: args.noLevel,
    phase: 'captured',
    historyWritten: false,
    processedWritten: false,
    outgoingRequired: false,
    outgoingCommitted: false,
    wellStatusCommitted: false,
    versionPublished: false,
    publishedVersion: null,
    seqBefore: null,
    incomingPayload: args.incomingPayload ?? null,
    createdAt: args.now,
    updatedAt: args.now,
  };
}

export function withPhase(
  state: GovernedEditApplyState,
  phase: GovernedEditApplyPhase,
  patch: Partial<GovernedEditApplyState>,
  now: string,
): GovernedEditApplyState {
  return { ...state, ...patch, phase, updatedAt: now };
}

/**
 * If history already proves this event+digest was written but the checkpoint
 * lagged, treat the apply as at least mutated so retry does not re-mint history.
 */
export function inferPhaseFromHistory(args: {
  state: GovernedEditApplyState | null;
  historyDigest: string | null;
  incomingDigest: string;
  acceptedReceipt: boolean;
}): GovernedEditApplyPhase | null {
  if (args.acceptedReceipt) return 'terminal';
  if (args.state && args.state.payloadDigest === args.incomingDigest) {
    return args.state.phase;
  }
  if (args.historyDigest && args.historyDigest === args.incomingDigest) {
    return args.state && PHASE_RANK[args.state.phase] > PHASE_RANK.mutated
      ? args.state.phase
      : 'mutated';
  }
  return args.state?.phase ?? null;
}

/**
 * Version exactly-once: if seqBefore was captured and the live counter already
 * moved past it, this event's increment already happened (crash after publish,
 * before checkpoint). Do not increment again.
 */
export function versionAlreadyPublished(args: {
  publishedVersion: number | null;
  seqBefore: number | null;
  liveVersion: number;
}): { done: true; seq: number } | { done: false } {
  if (typeof args.publishedVersion === 'number' && args.publishedVersion > 0) {
    return { done: true, seq: args.publishedVersion };
  }
  if (typeof args.seqBefore === 'number' && args.liveVersion > args.seqBefore) {
    return { done: true, seq: args.liveVersion };
  }
  return { done: false };
}

export function readLiveVersion(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? '0'), 10);
  return Number.isFinite(n) ? n : 0;
}

/** Test-only crash/fault injection. Production leaves this null. */
export type GovernedEditApplyFault =
  | null
  | 'after_captured'
  | 'after_mutated'
  | 'outgoing_fail'
  | 'after_downstream'
  | 'version_null'
  | 'after_versioned';

let applyFault: GovernedEditApplyFault = null;

export function setGovernedEditApplyFault(fault: GovernedEditApplyFault): void {
  applyFault = fault;
}

export function getGovernedEditApplyFault(): GovernedEditApplyFault {
  return applyFault;
}

export class GovernedEditApplyInterrupted extends Error {
  constructor(public readonly after: Exclude<GovernedEditApplyFault, null>) {
    super(`GOVERNED_EDIT_APPLY_FAULT:${after}`);
    this.name = 'GovernedEditApplyInterrupted';
  }
}

export function maybeInterrupt(after: Exclude<GovernedEditApplyFault, null | 'outgoing_fail' | 'version_null'>): void {
  if (applyFault === after) {
    throw new GovernedEditApplyInterrupted(after);
  }
}
