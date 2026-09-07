/**
 * Pure authorization + identity + idempotency spine for governed pull
 * corrections (move a load entered on the wrong well, or a genuine delete).
 *
 * The Dashboard's legacy deletePull/editPull wrote raw packets straight into
 * packets/incoming, which the deployed secure RTDB rules deny
 * (packets/incoming .write:false) — the proven cause of "Failed to delete pull".
 * The governed replacement (staffCorrectPull callable) derives the actor,
 * company, and authorization from the authenticated session and NEVER trusts a
 * client-supplied tenant or display name: identity is the immutable packetId and
 * the SERVER-stored wellName, not the name shown in the UI.
 *
 * This module is intentionally free of Firebase Admin I/O so the whole decision
 * surface is unit-testable with plain fixtures.
 */
import { callerCanViewGlobalWellPool } from '../dashboardCatalogProjection.js';

export type PullCorrectionOp = 'move' | 'delete';

export type HttpsCode =
  | 'unauthenticated'
  | 'permission-denied'
  | 'invalid-argument'
  | 'failed-precondition';

export interface CorrectionCaller {
  companyId?: string;
  isPlatformAdmin: boolean;
  caps: string[];
}

export interface AuthorizeInput {
  op: unknown;
  packetId: unknown;
  fromWell: unknown;
  toWell?: unknown;
  /** packets/processed/{packetId}, loaded server-side. null when absent. */
  processed: Record<string, unknown> | null;
  /** well_config map (bare-name keyed), loaded server-side, to prove target exists. */
  wellConfig: Record<string, unknown>;
  caller: CorrectionCaller;
}

export type AuthorizeDecision =
  | { ok: true; op: 'delete'; action: 'delete'; packetId: string; wellName: string }
  | { ok: true; op: 'delete'; action: 'already_gone'; packetId: string; wellName: string }
  | { ok: true; op: 'move'; action: 'move'; packetId: string; fromWell: string; toWell: string }
  | { ok: true; op: 'move'; action: 'already_moved'; packetId: string; fromWell: string; toWell: string }
  | { ok: false; code: HttpsCode; reason: string; message: string };

// RTDB keys (and thus packetId / well_config keys) forbid these characters.
const FORBIDDEN_KEY = /[.$#[\]/]/;
const MAX_ID = 512;

function asTrimmedString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Match how well_config / packets are keyed: exact, else whitespace-stripped. */
export function wellConfigHasWell(wellConfig: Record<string, unknown>, wellName: string): boolean {
  if (!wellName) return false;
  if (Object.prototype.hasOwnProperty.call(wellConfig, wellName)) return true;
  const clean = wellName.replace(/\s/g, '');
  for (const key of Object.keys(wellConfig)) {
    if (key === clean || key.replace(/\s/g, '') === clean) return true;
  }
  return false;
}

export function evaluatePullCorrection(input: AuthorizeInput): AuthorizeDecision {
  const deny = (code: HttpsCode, reason: string, message: string): AuthorizeDecision =>
    ({ ok: false, code, reason, message });

  // 1. Capability + tenant gate (fail closed). The well pool is untenanted, so
  //    a company-scoped, non-legacy caller may not correct pool pulls.
  if (!Array.isArray(input.caller?.caps) || !input.caller.caps.includes('manageDrivers')) {
    return deny('permission-denied', 'manageDrivers_required', 'Caller lacks manageDrivers capability.');
  }
  if (!callerCanViewGlobalWellPool(input.caller)) {
    return deny('permission-denied', 'pool_forbidden', 'Caller may not correct global well-pool pulls.');
  }

  // 2. Operation + immutable identity.
  const op = input.op;
  if (op !== 'move' && op !== 'delete') {
    return deny('invalid-argument', 'invalid_op', 'op must be "move" or "delete".');
  }
  const packetId = asTrimmedString(input.packetId);
  if (!packetId || packetId.length > MAX_ID || FORBIDDEN_KEY.test(packetId)) {
    return deny('invalid-argument', 'invalid_packetId', 'A valid immutable packetId is required.');
  }
  const fromWell = asTrimmedString(input.fromWell);
  if (!fromWell) {
    return deny('invalid-argument', 'missing_fromWell', 'The current (wrong) well is required.');
  }

  const storedWell = input.processed ? asTrimmedString(input.processed.wellName) : '';

  if (op === 'delete') {
    // Idempotent: an already-removed pull is a truthful success, not an error.
    if (!input.processed) {
      return { ok: true, op: 'delete', action: 'already_gone', packetId, wellName: fromWell };
    }
    // Identity by stored wellName, never by the display name alone.
    if (storedWell && storedWell !== fromWell) {
      return deny('failed-precondition', 'well_mismatch',
        'This pull no longer belongs to the named well; refresh and retry.');
    }
    return { ok: true, op: 'delete', action: 'delete', packetId, wellName: storedWell || fromWell };
  }

  // op === 'move'
  const toWell = asTrimmedString(input.toWell);
  if (!toWell) {
    return deny('invalid-argument', 'missing_toWell', 'A target well is required to move the load.');
  }
  if (toWell.length > MAX_ID || FORBIDDEN_KEY.test(toWell)) {
    return deny('invalid-argument', 'invalid_toWell', 'The target well name is invalid.');
  }
  if (toWell === fromWell) {
    return deny('invalid-argument', 'same_well', 'The target well matches the current well.');
  }
  if (!input.processed) {
    // Cannot move a pull that does not exist; do not fabricate one.
    return deny('failed-precondition', 'pull_not_found', 'The pull no longer exists.');
  }
  // Idempotent: already re-anchored to the target well.
  if (storedWell === toWell) {
    return { ok: true, op: 'move', action: 'already_moved', packetId, fromWell, toWell };
  }
  // Stale client view: the pull is on some other well now.
  if (storedWell && storedWell !== fromWell) {
    return deny('failed-precondition', 'well_mismatch',
      'This pull no longer belongs to the named well; refresh and retry.');
  }
  if (!wellConfigHasWell(input.wellConfig, toWell)) {
    return deny('failed-precondition', 'target_well_not_found', 'The target well was not found.');
  }
  return { ok: true, op: 'move', action: 'move', packetId, fromWell, toWell };
}

/** Deterministic incoming key so retries collapse to a single governed packet. */
export function correctionIncomingKey(op: PullCorrectionOp, packetId: string): string {
  return `${op}_${packetId}`;
}
