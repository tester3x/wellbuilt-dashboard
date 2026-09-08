/**
 * Pure authorization + identity + idempotency spine for a governed Dashboard
 * pull DELETE. Salvaged (delete-only) from the reviewed pullCorrectionAuthorize
 * on fb6ce67d and rebased onto the deployed lineage.
 *
 * The Dashboard's legacy deletePull wrote a raw packet straight into
 * packets/incoming, which the deployed secure RTDB rules deny
 * (packets/incoming .write:false) — the proven cause of "Failed to delete pull".
 * The governed replacement derives the actor, company, and authorization from
 * the authenticated session and NEVER trusts a client-supplied tenant or display
 * name: identity is the immutable packetId plus the SERVER-stored wellName.
 *
 * Free of Firebase Admin I/O so the whole decision surface is unit-testable.
 */
import { callerCanViewGlobalWellPool } from '../dashboardCatalogProjection.js';

export type HttpsCode =
  | 'unauthenticated'
  | 'permission-denied'
  | 'invalid-argument'
  | 'failed-precondition';

export interface DeleteCaller {
  companyId?: string;
  isPlatformAdmin: boolean;
  caps: string[];
}

export interface DeleteAuthorizeInput {
  packetId: unknown;
  /** The well the client believes the pull belongs to (display/scope claim). */
  wellName: unknown;
  /** packets/processed/{packetId}, loaded server-side. null when absent. */
  processed: Record<string, unknown> | null;
  caller: DeleteCaller;
}

export type DeleteAuthorizeDecision =
  | { ok: true; action: 'delete'; packetId: string; wellName: string }
  | { ok: true; action: 'already_gone'; packetId: string; wellName: string }
  | { ok: false; code: HttpsCode; reason: string; message: string };

// RTDB keys (and thus packetId) forbid these characters.
const FORBIDDEN_KEY = /[.$#[\]/]/;
const MAX_ID = 512;

function asTrimmedString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function evaluateDeletePull(input: DeleteAuthorizeInput): DeleteAuthorizeDecision {
  const deny = (code: HttpsCode, reason: string, message: string): DeleteAuthorizeDecision =>
    ({ ok: false, code, reason, message });

  // 1. Capability + tenant gate (fail closed). The well pool is untenanted, so a
  //    company-scoped, non-legacy caller may not delete pool pulls.
  if (!Array.isArray(input.caller?.caps) || !input.caller.caps.includes('manageDrivers')) {
    return deny('permission-denied', 'manageDrivers_required', 'Caller lacks manageDrivers capability.');
  }
  if (!callerCanViewGlobalWellPool(input.caller)) {
    return deny('permission-denied', 'pool_forbidden', 'Caller may not delete global well-pool pulls.');
  }

  // 2. Immutable identity.
  const packetId = asTrimmedString(input.packetId);
  if (!packetId || packetId.length > MAX_ID || FORBIDDEN_KEY.test(packetId)) {
    return deny('invalid-argument', 'invalid_packetId', 'A valid immutable packetId is required.');
  }
  const wellName = asTrimmedString(input.wellName);
  if (!wellName) {
    return deny('invalid-argument', 'missing_wellName', 'The pull’s well is required.');
  }

  // 3. Idempotent: an already-removed pull is a truthful success, not an error.
  if (!input.processed) {
    return { ok: true, action: 'already_gone', packetId, wellName };
  }

  // 4. Identity by SERVER-stored wellName, never the display name alone.
  const storedWell = asTrimmedString(input.processed.wellName);
  if (storedWell && storedWell !== wellName) {
    return deny('failed-precondition', 'well_mismatch',
      'This pull no longer belongs to the named well; refresh and retry.');
  }

  return { ok: true, action: 'delete', packetId, wellName: storedWell || wellName };
}

/** Deterministic incoming key so retries collapse to a single governed packet. */
export function deleteIncomingKey(packetId: string): string {
  return `delete_${packetId}`;
}
