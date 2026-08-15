/**
 * Server decision for jsaResolveCurrentShiftReadEvidence.
 *
 * Identity and the open period come from Auth claims +
 * driver_shift_authority. The request body may carry only
 * protocolVersion. Hostile identity/period fields refuse.
 *
 * Unverifiable authority and query failures THROW — they must
 * never degrade to `none`.
 */
import {
  decideCurrentShiftReadEvidence,
  terminalActionIncludesRead,
  validateJsaCurrentShiftReadEvidenceRequest,
  validateJsaCurrentShiftReadEvidenceResponse,
  JSA_CURRENT_SHIFT_READ_EVIDENCE_PROTOCOL_VERSION,
  type JsaCurrentShiftReadEvidenceRecord,
  type JsaCurrentShiftReadEvidenceResponse,
} from '@tester3x/wellbuilt-contracts';
import type { ResolveResult } from '../security/operational/shiftAuthority.js';
import {
  parseAuthPrincipal,
  requireAudience,
  JSA_APP_WBT,
  type AuthPrincipal,
} from './jsaReceiptCore.js';
import { JsaReceiptError } from './jsaReceiptHandlers.js';

export type CurrentShiftReadEvidenceDeps = {
  resolveShift(driverId: string, companyId: string): Promise<ResolveResult>;
  listGovernedByPeriod(
    companyId: string,
    driverId: string,
    periodId: string,
  ): Promise<JsaCurrentShiftReadEvidenceRecord[]>;
  log(event: string, extra: Record<string, string>): void;
};

function throwAuth(d: { ok: false; refusal: string; detail: string }): never {
  if (d.refusal === 'unauthenticated') {
    throw new JsaReceiptError('unauthenticated', 'unauthenticated', d.detail);
  }
  throw new JsaReceiptError('permission-denied', d.refusal as never, d.detail);
}

function principalOf(auth: { uid?: string | null; claims?: Record<string, unknown> | null }): AuthPrincipal {
  const p = parseAuthPrincipal(auth);
  if (!p.ok) throwAuth(p);
  const aud = requireAudience(p.value, JSA_APP_WBT);
  if (!aud.ok) throwAuth(aud);
  return p.value;
}

export async function handleResolveCurrentShiftReadEvidence(
  deps: CurrentShiftReadEvidenceDeps,
  auth: { uid?: string | null; claims?: Record<string, unknown> | null },
  data: unknown,
): Promise<JsaCurrentShiftReadEvidenceResponse> {
  const parsed = validateJsaCurrentShiftReadEvidenceRequest(data);
  if (!parsed.ok) {
    throw new JsaReceiptError(
      parsed.errorCode === 'unsupported_protocol' ? 'failed-precondition' : 'invalid-argument',
      parsed.errorCode === 'client_identity' ? 'client_identity' : 'malformed',
      parsed.field,
    );
  }

  const p = principalOf(auth);
  let shift: ResolveResult;
  try {
    shift = await deps.resolveShift(p.driverId, p.companyId);
  } catch {
    throw new JsaReceiptError('permission-denied', 'authority_unverifiable', 'resolve_failed');
  }
  if (shift.state === 'unverifiable') {
    throw new JsaReceiptError('permission-denied', 'authority_unverifiable', shift.reason);
  }
  if (shift.state === 'none') {
    const body: JsaCurrentShiftReadEvidenceResponse = {
      protocolVersion: JSA_CURRENT_SHIFT_READ_EVIDENCE_PROTOCOL_VERSION,
      state: 'no_active_shift',
    };
    const checked = validateJsaCurrentShiftReadEvidenceResponse(body);
    if (!checked.ok) throw new JsaReceiptError('failed-precondition', 'malformed', 'response');
    deps.log('jsa.shift_read_evidence', { state: 'no_active_shift' });
    return checked.value;
  }

  let records: JsaCurrentShiftReadEvidenceRecord[];
  try {
    records = await deps.listGovernedByPeriod(p.companyId, p.driverId, shift.periodId);
  } catch {
    throw new JsaReceiptError('failed-precondition', 'authority_unverifiable', 'query_failed');
  }

  const state = decideCurrentShiftReadEvidence(shift.periodId, records, {
    companyId: p.companyId,
    driverId: p.driverId,
  });
  const body: JsaCurrentShiftReadEvidenceResponse = {
    protocolVersion: JSA_CURRENT_SHIFT_READ_EVIDENCE_PROTOCOL_VERSION,
    state,
    periodId: shift.periodId,
  };
  const checked = validateJsaCurrentShiftReadEvidenceResponse(body);
  if (!checked.ok) throw new JsaReceiptError('failed-precondition', 'malformed', 'response');
  deps.log('jsa.shift_read_evidence', { state });
  return checked.value;
}

/** Re-export so tests and the callable share one action predicate. */
export { terminalActionIncludesRead };
