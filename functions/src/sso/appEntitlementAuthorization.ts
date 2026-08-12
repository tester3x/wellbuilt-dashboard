/**
 * vc51.9L — the per-app commercial entitlement decision for issuance.
 *
 * PURE. No firebase-admin, no clock, no randomness, no I/O: the caller
 * supplies the authoritative records, so the whole plan/shift matrix runs
 * in-memory. Same "neutral seam" discipline as equipmentAuthorization —
 * it consumes already-parsed domain objects and delegates every judgement
 * to the canonical contracts functions rather than restating them.
 *
 * IT ANSWERS ONE QUESTION. May this driver, for THIS selected company, be
 * issued an authorization code for THIS destination app right now? It
 * never decides identity — driverId and companyId arrive already derived
 * from the verified Auth context and revalidated against the authoritative
 * driver record — and it never decides per-shift READINESS. DVIR, JSA,
 * Pre-Trip and Post-Trip are separate gates that run after this one says
 * the driver may reach the app at all.
 *
 * NOTHING HERE READS THE REQUEST. Plan, entitlement, configuration and
 * shift state all come from server records. A client cannot assert any of
 * them, which is the entire point of deciding this server-side.
 */

import {
  decideAppAccess,
  isCoreApp,
  type PlanDefinition,
  type WellbuiltAppKey,
} from '@tester3x/wellbuilt-contracts';
import type { WellbuiltContract } from '../admin/companyContract.js';
import type { ResolveResult } from '../security/operational/shiftAuthority.js';

export type AppAuthzRefusal =
  /** The audience does not map to a canonical WellBuilt app key. */
  | 'app_not_recognized'
  /** No company contract at all — missing commercial authority. */
  | 'contract_missing'
  /** The stored company contract is unusable. Never guess past it. */
  | 'contract_invalid'
  /** A contract with no usable plan reference. */
  | 'plan_reference_invalid'
  /** A contract names a plan whose document is absent — a broken pointer. */
  | 'plan_missing'
  /** The plan document is not an object. */
  | 'plan_not_object'
  /** COMMERCIAL: the plan excludes this app, or its data is unusable. */
  | 'app_not_entitled'
  /** SHIFT: entitled, but no authoritative open shift proves the gate. */
  | 'active_shift_required';

export type AppAuthzDecision =
  | { ok: true; outcome: string; detail: string }
  | { ok: false; refusal: AppAuthzRefusal; detail: string };

/**
 * The authoritative shift state, or null when it has not been read.
 *
 * Two-phase by design: the caller runs this function with `shift: null`
 * first, and only pays for the authority read when the answer comes back
 * `active_shift_required`. That keeps the "does this plan need a shift?"
 * judgement inside the canonical resolver instead of duplicating it in the
 * handler to decide whether to fetch.
 */
export type ShiftEvidence = ResolveResult | null;

export function decideAppEntitlementAuthorization(input: {
  app: WellbuiltAppKey | null;
  contractState: 'legacy' | 'inert' | 'active' | 'invalid';
  contract: WellbuiltContract | null;
  plan: PlanDefinition | null;
  shift: ShiftEvidence;
}): AppAuthzDecision {
  const { app } = input;
  // An audience with no canonical app key is not a destination this
  // system knows how to price. Fail closed rather than assume.
  if (!app) {
    return { ok: false, refusal: 'app_not_recognized', detail: 'audience has no canonical app key' };
  }

  // CORE apps are structural, not commercial. Suite is where a plan denial
  // is explained, a required shift is started, and access is recovered, so
  // it is decided before any plan data is consulted and cannot be lost to
  // a missing, empty, or corrupt entitlement map. This grants Suite and
  // NOTHING else — every other app falls through to the plan below.
  if (isCoreApp(app)) {
    return { ok: true, outcome: 'INCLUDED_NO_SHIFT_REQUIRED', detail: 'core_app_always_included' };
  }

  if (input.contractState === 'invalid') {
    return { ok: false, refusal: 'contract_invalid', detail: 'stored contract unsupported' };
  }
  // EVERY company has a plan — a free owner-operator included. A missing
  // contract is missing COMMERCIAL AUTHORITY, not a legacy entitlement
  // configuration, so it can never reach the temporarily permissive path.
  // LEGACY_UNCONFIGURED describes a plan that lacks the `apps` field, and
  // a company with no plan at all has not made that statement.
  if (input.contractState === 'legacy' || !input.contract) {
    return { ok: false, refusal: 'contract_missing', detail: 'company has no contract' };
  }
  // 'inert' is deliberately NOT refused here. An inert contract is a real
  // commercial relationship whose OPERATIONAL rules are not in force; the
  // plan it names still says what the company bought. Enforcement of work
  // rules and existence of entitlement are separate questions.
  if (typeof input.contract.planId !== 'string' || input.contract.planId.length === 0) {
    return { ok: false, refusal: 'plan_reference_invalid', detail: 'contract names no plan' };
  }
  if (!input.plan) {
    return { ok: false, refusal: 'plan_missing', detail: 'contract names an absent plan' };
  }
  if (typeof input.plan !== 'object' || Array.isArray(input.plan)) {
    return { ok: false, refusal: 'plan_not_object', detail: 'plan is not an object' };
  }

  // THE canonical decision. Absent `apps` resolves LEGACY_UNCONFIGURED and
  // stays permissive; `{}` and explicit exclusions deny; malformed stored
  // data denies as INVALID_ENTITLEMENT_DATA. Aliases and unknown keys are
  // refused by the same validator the admin write path uses, so nothing is
  // silently normalized on read.
  const hasActiveShift = input.shift !== null && input.shift.state === 'open';
  const access = decideAppAccess(input.plan, app, { hasActiveShift });

  if (access.access === 'allowed') {
    return { ok: true, outcome: access.outcome, detail: access.reason };
  }
  if (access.access === 'shift_required') {
    // Distinguished from commercial exclusion INTERNALLY. The public
    // envelope stays coarse so a caller cannot probe a company's plan.
    return {
      ok: false,
      refusal: 'active_shift_required',
      detail: input.shift === null ? 'shift_not_read' : `shift_${input.shift.state}`,
    };
  }
  // Commercial exclusion, or entitlement data that could not be trusted.
  // Both are 'denied' to the client; the outcome separates them for an
  // operator without telling the caller which.
  return { ok: false, refusal: 'app_not_entitled', detail: access.outcome };
}
