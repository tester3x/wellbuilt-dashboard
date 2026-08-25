/**
 * Durable governed-edit apply checkpoint, lease, and version ledger.
 *
 * Phases (RTDB packets/editApplyState/{editEventId}):
 *   captured   — payload copied; no processed mutation yet
 *   mutated    — processed + immutable history written; no accepted receipt
 *   downstream — required outgoing/current/wells status committed (or not required)
 *   versioned  — this event's version claim is published to incoming_version
 *   terminal   — accepted receipt published; incoming consumed
 *
 * Version proof is event-specific (packets/editVersionLedger.claims/{editEventId}),
 * never "the global incoming_version number moved."
 *
 * Lease: one durable owner per editEventId. Stale owners cannot regress phase.
 */

export const GOVERNED_EDIT_APPLY_STATE_ROOT = 'packets/editApplyState';
export const VERSION_LEDGER_PATH = 'packets/editVersionLedger';

/** v1 database onWrite default/declared timeout for processEditRequest. */
export const GOVERNED_EDIT_FUNCTION_TIMEOUT_SECONDS = 60;
/** Production lease length. Heartbeat renews so a healthy 60s run cannot be stolen. */
export const GOVERNED_EDIT_LEASE_MS_DEFAULT = 30_000;

export type GovernedEditApplyPhase =
  | 'captured'
  | 'mutated'
  | 'downstream'
  | 'versioned'
  | 'terminal';

export interface ApplyLease {
  ownerId: string;
  expiresAt: number;
}

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
  assignedVersion: number | null;
  seqBefore: number | null;
  incomingPayload: Record<string, unknown> | null;
  lease: ApplyLease | null;
  createdAt: string;
  updatedAt: string;
}

export interface VersionClaim {
  editEventId: string;
  payloadDigest: string;
  seq: number;
}

export interface VersionLedger {
  nextSeq: number;
  claims: Record<string, VersionClaim>;
}

export function applyStatePath(editEventId: string): string {
  return `${GOVERNED_EDIT_APPLY_STATE_ROOT}/${editEventId}`;
}

export const PHASE_RANK: Record<GovernedEditApplyPhase, number> = {
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

function parseLease(raw: unknown): ApplyLease | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.ownerId !== 'string' || !r.ownerId) return null;
  const expiresAt = typeof r.expiresAt === 'number' ? r.expiresAt : Number(r.expiresAt);
  if (!Number.isFinite(expiresAt)) return null;
  return { ownerId: r.ownerId, expiresAt };
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
    assignedVersion: typeof r.assignedVersion === 'number' ? r.assignedVersion : null,
    seqBefore: typeof r.seqBefore === 'number' ? r.seqBefore : null,
    incomingPayload: r.incomingPayload && typeof r.incomingPayload === 'object' && !Array.isArray(r.incomingPayload)
      ? r.incomingPayload as Record<string, unknown>
      : null,
    lease: parseLease(r.lease),
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
  lease?: ApplyLease | null;
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
    assignedVersion: null,
    seqBefore: null,
    incomingPayload: args.incomingPayload ?? null,
    lease: args.lease ?? null,
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

export function mergeMonotonic(
  current: GovernedEditApplyState,
  incoming: GovernedEditApplyState,
): GovernedEditApplyState {
  const phase = PHASE_RANK[incoming.phase] >= PHASE_RANK[current.phase]
    ? incoming.phase
    : current.phase;
  return {
    ...current,
    ...incoming,
    phase,
    historyWritten: current.historyWritten || incoming.historyWritten,
    processedWritten: current.processedWritten || incoming.processedWritten,
    outgoingRequired: current.outgoingRequired || incoming.outgoingRequired,
    outgoingCommitted: current.outgoingCommitted || incoming.outgoingCommitted,
    wellStatusCommitted: current.wellStatusCommitted || incoming.wellStatusCommitted,
    versionPublished: current.versionPublished || incoming.versionPublished,
    publishedVersion: current.publishedVersion ?? incoming.publishedVersion,
    assignedVersion: current.assignedVersion ?? incoming.assignedVersion,
    seqBefore: current.seqBefore ?? incoming.seqBefore,
    payloadDigest: current.payloadDigest,
    editEventId: current.editEventId,
    createdAt: current.createdAt || incoming.createdAt,
  };
}

export function leaseIsHeld(
  lease: ApplyLease | null | undefined,
  nowMs: number,
  ownerId?: string,
): boolean {
  if (!lease) return false;
  if (lease.expiresAt <= nowMs) return false;
  if (ownerId && lease.ownerId !== ownerId) return true;
  if (ownerId && lease.ownerId === ownerId) return true;
  return true;
}

export function isActiveOwner(
  state: GovernedEditApplyState | null,
  ownerId: string,
  nowMs: number,
): boolean {
  if (!state?.lease) return false;
  return state.lease.ownerId === ownerId && state.lease.expiresAt > nowMs;
}

/** Fencing token: recorded owner may write until another owner acquires. */
export function isWriteOwner(
  state: GovernedEditApplyState | null,
  ownerId: string,
): boolean {
  return !!state?.lease && state.lease.ownerId === ownerId;
}

export type AcquireDecision =
  | { action: 'acquired'; state: GovernedEditApplyState }
  | { action: 'busy'; ownerId: string }
  | { action: 'conflict' }
  | { action: 'terminal'; state: GovernedEditApplyState };

export function decideAcquireLease(args: {
  current: GovernedEditApplyState | null;
  candidate: GovernedEditApplyState;
  ownerId: string;
  nowMs: number;
  leaseMs: number;
}): AcquireDecision {
  const lease: ApplyLease = { ownerId: args.ownerId, expiresAt: args.nowMs + args.leaseMs };
  if (!args.current) {
    return { action: 'acquired', state: { ...args.candidate, lease, updatedAt: args.candidate.updatedAt } };
  }
  if (args.current.payloadDigest !== args.candidate.payloadDigest) {
    return { action: 'conflict' };
  }
  if (args.current.phase === 'terminal') {
    return { action: 'terminal', state: args.current };
  }
  if (
    args.current.lease
    && args.current.lease.ownerId !== args.ownerId
    && args.current.lease.expiresAt > args.nowMs
  ) {
    return { action: 'busy', ownerId: args.current.lease.ownerId };
  }
  return {
    action: 'acquired',
    state: { ...args.current, lease, incomingId: args.candidate.incomingId || args.current.incomingId, incomingPayload: args.current.incomingPayload || args.candidate.incomingPayload, updatedAt: args.candidate.updatedAt },
  };
}

export type AdvanceDecision =
  | { action: 'write'; state: GovernedEditApplyState }
  | { action: 'keep'; state: GovernedEditApplyState }
  | { action: 'stale' }
  | { action: 'conflict' };

export function decideAdvancePhase(args: {
  current: GovernedEditApplyState | null;
  desired: GovernedEditApplyState;
  ownerId: string;
  nowMs: number;
}): AdvanceDecision {
  if (!args.current) return { action: 'stale' };
  if (args.current.payloadDigest !== args.desired.payloadDigest) {
    return { action: 'conflict' };
  }
  if (!isWriteOwner(args.current, args.ownerId) && args.current.phase !== 'terminal') {
    return { action: 'stale' };
  }
  const merged = mergeMonotonic(args.current, {
    ...args.desired,
    lease: args.current.lease,
  });
  if (PHASE_RANK[args.desired.phase] < PHASE_RANK[args.current.phase]) {
    return { action: 'keep', state: args.current };
  }
  return { action: 'write', state: merged };
}

export function decideRenewLease(args: {
  current: GovernedEditApplyState | null;
  ownerId: string;
  nowMs: number;
  leaseMs: number;
}): { action: 'renew'; state: GovernedEditApplyState } | { action: 'lost' } {
  if (!args.current) return { action: 'lost' };
  if (!args.current.lease || args.current.lease.ownerId !== args.ownerId) {
    return { action: 'lost' };
  }
  return {
    action: 'renew',
    state: {
      ...args.current,
      lease: { ownerId: args.ownerId, expiresAt: args.nowMs + args.leaseMs },
    },
  };
}

export function decideReleaseLease(
  current: GovernedEditApplyState | null,
  ownerId: string,
): GovernedEditApplyState | null {
  if (!current) return null;
  if (!current.lease || current.lease.ownerId !== ownerId) return current;
  return { ...current, lease: null };
}

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

/** Event-specific proof only — never live global counter movement. */
export function eventHasVersionClaim(args: {
  assignedVersion: number | null;
  publishedVersion: number | null;
}): { done: true; seq: number } | { done: false } {
  if (typeof args.assignedVersion === 'number' && args.assignedVersion > 0) {
    return { done: true, seq: args.assignedVersion };
  }
  if (typeof args.publishedVersion === 'number' && args.publishedVersion > 0) {
    return { done: true, seq: args.publishedVersion };
  }
  return { done: false };
}

/** @deprecated Do not use liveVersion>seqBefore as event proof. Kept name unused. */

export function readLiveVersion(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? '0'), 10);
  return Number.isFinite(n) ? n : 0;
}

export function parseVersionLedger(raw: unknown): VersionLedger {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { nextSeq: 0, claims: {} };
  }
  const r = raw as Record<string, unknown>;
  const nextSeq = typeof r.nextSeq === 'number' && r.nextSeq >= 0 ? Math.floor(r.nextSeq) : 0;
  const claims: Record<string, VersionClaim> = {};
  const rawClaims = r.claims && typeof r.claims === 'object' && !Array.isArray(r.claims)
    ? r.claims as Record<string, unknown>
    : {};
  for (const [id, c] of Object.entries(rawClaims)) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
    const row = c as Record<string, unknown>;
    if (typeof row.payloadDigest !== 'string' || typeof row.seq !== 'number') continue;
    claims[id] = {
      editEventId: typeof row.editEventId === 'string' ? row.editEventId : id,
      payloadDigest: row.payloadDigest,
      seq: row.seq,
    };
  }
  return { nextSeq, claims };
}

export function decideLedgerClaim(args: {
  ledger: VersionLedger;
  editEventId: string;
  payloadDigest: string;
  publicFloor?: number;
}):
  | { ok: true; ledger: VersionLedger; seq: number; reused: boolean }
  | { ok: false; reason: 'edit_event_payload_conflict' } {
  const existing = args.ledger.claims[args.editEventId];
  if (existing) {
    if (existing.payloadDigest !== args.payloadDigest) {
      return { ok: false, reason: 'edit_event_payload_conflict' };
    }
    return { ok: true, ledger: args.ledger, seq: existing.seq, reused: true };
  }
  const floor = Math.max(
    args.ledger.nextSeq,
    Number.isFinite(args.publicFloor) ? Math.floor(args.publicFloor as number) : 0,
    0,
  );
  const seq = floor + 1;
  return {
    ok: true,
    reused: false,
    seq,
    ledger: {
      nextSeq: seq,
      claims: {
        ...args.ledger.claims,
        [args.editEventId]: {
          editEventId: args.editEventId,
          payloadDigest: args.payloadDigest,
          seq,
        },
      },
    },
  };
}

export function decideAnonymousVersionTick(args: {
  ledger: VersionLedger;
  publicFloor?: number;
}): { ledger: VersionLedger; seq: number } {
  const floor = Math.max(
    args.ledger.nextSeq,
    Number.isFinite(args.publicFloor) ? Math.floor(args.publicFloor as number) : 0,
    0,
  );
  const seq = floor + 1;
  return { seq, ledger: { nextSeq: seq, claims: args.ledger.claims } };
}

export function decidePublicVersionAdvance(current: number, assignedSeq: number): number {
  const cur = Number.isFinite(current) && current > 0 ? current : 0;
  return assignedSeq > cur ? assignedSeq : cur;
}

/**
 * First publication of a new claim must be observable even when an unrelated
 * writer already moved the public scalar onto this event's seq. Concurrent
 * higher governed seqs (current > assignedSeq) must not extra-increment.
 * Retries (forceIfAbsorbed=false) are strictly max() / idempotent.
 */
export function decidePublicVersionPublish(args: {
  current: number;
  assignedSeq: number;
  forceIfAbsorbed: boolean;
}): number {
  const cur = decidePublicVersionAdvance(args.current, 0);
  if (args.assignedSeq > cur) return args.assignedSeq;
  if (args.forceIfAbsorbed && args.assignedSeq > 0 && args.assignedSeq === cur) {
    return cur + 1;
  }
  return cur;
}

export function shouldRetriggerEditIncoming(args: {
  isGoverned: boolean;
  applyState: GovernedEditApplyState | null;
}): boolean {
  if (args.applyState?.phase === 'terminal') return false;
  if (args.isGoverned) return true;
  return !!args.applyState;
}

/** Test-only crash/fault injection. Production leaves this null. */
export type GovernedEditApplyFault =
  | null
  | 'before_captured'
  | 'after_captured'
  | 'after_mutated'
  | 'outgoing_fail'
  | 'after_downstream'
  | 'version_null'
  | 'after_claim_before_public'
  | 'after_public_before_versioned'
  | 'after_versioned';

let applyFault: GovernedEditApplyFault = null;
let leaseMs = GOVERNED_EDIT_LEASE_MS_DEFAULT;
let leaseRenewEnabled = true;
let leaseHold: { promise: Promise<void>; resolve: () => void; consumed: boolean } | null = null;

export function setGovernedEditApplyFault(fault: GovernedEditApplyFault): void {
  applyFault = fault;
}

export function getGovernedEditApplyFault(): GovernedEditApplyFault {
  return applyFault;
}

export function setGovernedEditLeaseMs(ms: number): void {
  leaseMs = ms > 0 ? ms : GOVERNED_EDIT_LEASE_MS_DEFAULT;
}

export function getGovernedEditLeaseMs(): number {
  return leaseMs;
}

export function setGovernedEditLeaseRenew(enabled: boolean): void {
  leaseRenewEnabled = enabled;
}

export function getGovernedEditLeaseRenew(): boolean {
  return leaseRenewEnabled;
}

export function governedEditLeaseHeartbeatMs(): number {
  return Math.max(250, Math.floor(getGovernedEditLeaseMs() / 3));
}

export function armGovernedEditLeaseHold(): () => void {
  let resolve = () => {};
  const promise = new Promise<void>((r) => { resolve = r; });
  leaseHold = { promise, resolve, consumed: false };
  return () => {
    resolve();
    leaseHold = null;
  };
}

export function clearGovernedEditLeaseHold(): void {
  if (!leaseHold) return;
  leaseHold.resolve();
  leaseHold = null;
}

export async function maybeHoldLease(): Promise<void> {
  if (!leaseHold) return;
  if (leaseHold.consumed) return;
  leaseHold.consumed = true;
  await leaseHold.promise;
}

export class GovernedEditApplyInterrupted extends Error {
  constructor(public readonly after: Exclude<GovernedEditApplyFault, null>) {
    super(`GOVERNED_EDIT_APPLY_FAULT:${after}`);
    this.name = 'GovernedEditApplyInterrupted';
  }
}

export function maybeInterrupt(
  after: Exclude<GovernedEditApplyFault, null | 'outgoing_fail' | 'version_null'>,
): void {
  if (applyFault === after) {
    throw new GovernedEditApplyInterrupted(after);
  }
}
