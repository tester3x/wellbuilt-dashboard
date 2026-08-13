/**
 * JSA spine — the server-authored authority binding for the WB-JSA
 * SSO audience.
 *
 * WHY THIS EXISTS. WB-JSA vc5 authenticated from launch-URI material and
 * scoped its records to a locally cached shift — it reused a stale legacy
 * session and a JUNE shift during an active AUGUST Suite shift. The
 * governed replacement binds every JSA session to what the AUTHORITY
 * record says at issuance:
 *
 *   open  → the exact authoritative periodId and its frozen origin day
 *           (decided once at claim, never re-derived from a clock — there
 *           is deliberately NO UTC-date fallback anywhere in this path);
 *   none  → an initialized-empty pointer, legal only when the effective
 *           plan + company configuration do not require an active shift
 *           (the owner-operator / free-plan case);
 *   anything else → REFUSED. A missing, uninitialized, half-written,
 *           foreign, or corrupt authority is never represented as a
 *           state; representing it is exactly how a stale shift gets
 *           reused.
 *
 * PURE. No firebase-admin, no clock, no I/O — the issuance handler
 * supplies the already-resolved authority verdict and the effective
 * policy flags, so the whole matrix runs in-memory.
 *
 * The binding shape mirrors contracts SsoJsaBinding (0.5.0-dev). It is
 * declared structurally here because this module must typecheck against
 * the pinned 0.4.0 mirror; the conformance harness ties the two together
 * at the 0.5.0 publish step.
 */
import type { ResolveResult } from '../security/operational/shiftAuthority.js';

/** Structural mirror of contracts SsoJsaBinding (0.5.0-dev). */
export interface JsaBindingShape {
  shiftState: 'open' | 'none';
  periodId?: string;
  originLocalDate?: string;
  requiresActiveShift: boolean;
  jsaEnabled: boolean;
}

export type JsaBindingRefusal =
  /** Policy requires an active shift and the authority proves none open. */
  | 'active_shift_required'
  /** The authority cannot vouch for this driver at all. Fail closed. */
  | 'authority_unverifiable';

export type JsaBindingDecision =
  | { ok: true; binding: JsaBindingShape }
  | { ok: false; refusal: JsaBindingRefusal; detail: string };

/**
 * Decide the binding a JSA issuance stores (and the exchange later
 * returns). `shift` must be the AUTHORITATIVE resolver verdict — for the
 * jsa audience the issuance handler always reads the authority record,
 * even when no shift is required, because the binding states shift FACTS
 * and facts require evidence.
 */
export function decideJsaBinding(input: {
  shift: ResolveResult;
  requiresActiveShift: boolean;
  jsaEnabled: boolean;
}): JsaBindingDecision {
  const { shift, requiresActiveShift, jsaEnabled } = input;

  if (shift.state === 'open') {
    return {
      ok: true,
      binding: {
        shiftState: 'open',
        // Both fields come from the authority record via decideResolve,
        // which has already enforced period/origin-day consistency.
        periodId: shift.periodId,
        originLocalDate: shift.originLocalDate,
        requiresActiveShift,
        jsaEnabled,
      },
    };
  }

  if (shift.state === 'none') {
    if (requiresActiveShift) {
      // Same refusal class the entitlement gate uses, so the public
      // envelope stays uniform and internally the operator sees which
      // gate fired.
      return { ok: false, refusal: 'active_shift_required', detail: 'shift_none' };
    }
    return {
      ok: true,
      binding: { shiftState: 'none', requiresActiveShift, jsaEnabled },
    };
  }

  // Unverifiable — absent, uninitialized, inconsistent, or foreign.
  // ALWAYS refused, even when no shift is required: every company-bound
  // driver has an initialized authority (provisioning and the governed
  // company binding both ensure it), so an unverifiable record here is a
  // defect or an attack, and stating 'none' on no evidence is the exact
  // stale-shift failure this spine removes.
  return {
    ok: false,
    refusal: 'authority_unverifiable',
    detail: `authority_${shift.reason}`,
  };
}

/**
 * The stored → returned round-trip guard. The exchange must hand WB-JSA
 * exactly what issuance stored; a document that lost or grew fields in
 * between is refused rather than repaired.
 */
export function readStoredJsaBinding(v: unknown): JsaBindingShape | null {
  const o = v as Record<string, unknown> | null;
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return null;
  if (typeof o.requiresActiveShift !== 'boolean') return null;
  if (typeof o.jsaEnabled !== 'boolean') return null;
  const keys = Object.keys(o);
  if (o.shiftState === 'open') {
    if (keys.length !== 5) return null;
    if (typeof o.periodId !== 'string' || !/^\d{4}-\d{2}-\d{2}_\d{6}$/.test(o.periodId)) return null;
    if (typeof o.originLocalDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.originLocalDate)) return null;
    if (o.periodId.slice(0, 10) !== o.originLocalDate) return null;
    return {
      shiftState: 'open',
      periodId: o.periodId,
      originLocalDate: o.originLocalDate,
      requiresActiveShift: o.requiresActiveShift,
      jsaEnabled: o.jsaEnabled,
    };
  }
  if (o.shiftState === 'none') {
    if (keys.length !== 3) return null;
    return {
      shiftState: 'none',
      requiresActiveShift: o.requiresActiveShift,
      jsaEnabled: o.jsaEnabled,
    };
  }
  return null;
}
