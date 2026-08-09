/**
 * vc51.9AF — the equipment-audience authorization decision.
 *
 * PURE. No firebase-admin, no clock, no randomness, no I/O: the caller
 * supplies the authoritative records and the time, so the entire
 * shift/capability matrix runs in-memory. This is the "neutral seam" the
 * SSO path uses to reach canonical policy WITHOUT importing an admin
 * handler or UI layer — it consumes already-parsed domain objects and
 * delegates every judgement to the shared canonical functions.
 *
 * WHY A SEPARATE MODULE. Issuance for WB-T is a short, well-reviewed
 * function. Equipment adds contract, plan, capability and shift checks;
 * inlining them would bury the WB-T path in branches and make "did the
 * ticket flow change?" hard to answer. Keeping the addition here means the
 * WB-T path is visibly untouched.
 *
 * WHAT IT DOES NOT DO. It never decides identity — driverId and companyId
 * arrive already derived from the verified Auth context and revalidated
 * against the authoritative driver record. It only answers: may THIS
 * driver bridge to eQuipment for THIS shift and phase, right now?
 */

import {
  isOperationallyOpen,
  resolveWorkPeriod,
  type EffectiveCompanyCapabilities,
  type PlanDefinition,
} from '@tester3x/wellbuilt-contracts';
import {
  computeEffectiveCapabilities,
  type CapabilityResult,
} from '../admin/effectiveCapabilities.js';
import {
  toContractsWorkPeriodConfiguration,
  type WellbuiltContract,
} from '../admin/companyContract.js';
import type { SsoShiftBinding } from './protocol.generated.js';

/** One `driver_shifts/{driverId}_{date}` document, as the server read it. */
export interface ShiftDayDoc {
  /** false ⇒ the READ failed. Never the same as "absent". */
  readable: boolean;
  /** false ⇒ definitively no such document. */
  present: boolean;
  /** '' ⇒ WB-S explicitly closed the shift; absent ⇒ no field. */
  currentShiftId?: string;
}

export type EquipmentAuthzRefusal =
  | 'contract_absent'
  | 'contract_not_enforced'
  | 'contract_invalid'
  | 'plan_missing'
  | 'capabilities_unavailable'
  | 'dvir_not_entitled'
  | 'work_period_not_required'
  | 'shift_not_active'
  | 'shift_id_mismatch';

export type EquipmentAuthzDecision =
  | { ok: true; binding: SsoShiftBinding; capabilities: EffectiveCompanyCapabilities }
  | { ok: false; reason: EquipmentAuthzRefusal; detail: string };

/**
 * The origin day of a shift id.
 *
 * WB-S mints `YYYY-MM-DD_HHMMSS`, so the first ten characters name the
 * local day whose document owns the shift. This is a LOOKUP HINT only —
 * the document read is the authority, and a well-formed id for a shift
 * that was never opened, or was closed, or was superseded, is refused all
 * the same. The census was explicit that format is never proof.
 */
export function shiftOriginDay(shiftId: string): string | null {
  return /^\d{4}-\d{2}-\d{2}_/.test(shiftId) ? shiftId.slice(0, 10) : null;
}

/**
 * Decide an equipment authorization.
 *
 * `originDay` is passed as BOTH the resolver's `today` evidence and its
 * cached-origin evidence on purpose. The question being answered is not
 * "does this driver have some shift open today?" but "is THIS requested
 * shift still the open one on its own day?" — which is what makes a
 * cross-midnight shift resolve correctly without the server needing a
 * timezone it does not have. explicit_shift stores none, and
 * customerEditableFields is [], so there is no server-side local date to
 * borrow; the shift's own day is the only sound frame.
 */
export function decideEquipmentAuthorization(input: {
  driverId: string;
  companyId: string;
  binding: SsoShiftBinding;
  /** Parsed contract, or null when the company has none / it is unusable. */
  contract: WellbuiltContract | null;
  contractState: 'legacy' | 'inert' | 'active' | 'invalid';
  /** The plan named by the contract, or null when absent. */
  plan: PlanDefinition | null;
  /** `driver_shifts/{driverId}_{originDay}`. */
  originDayDoc: ShiftDayDoc;
  nowMs: number;
}): EquipmentAuthzDecision {
  // 1. The company must be under an ENFORCED contract. An inert contract is
  //    configured but deliberately not in force, and a governed DVIR handoff
  //    is exactly the thing enforcement gates.
  if (input.contractState === 'legacy' || !input.contract) {
    return { ok: false, reason: 'contract_absent', detail: 'no wellbuilt contract' };
  }
  if (input.contractState === 'invalid') {
    return { ok: false, reason: 'contract_invalid', detail: 'stored contract unsupported' };
  }
  if (!input.contract.contractEnforced) {
    return { ok: false, reason: 'contract_not_enforced', detail: 'contract is inert' };
  }
  if (!input.plan) {
    return { ok: false, reason: 'plan_missing', detail: 'assigned plan absent' };
  }

  // 2. Canonical capability computation — the same function the admin
  //    surface uses, reached through this seam rather than by importing a
  //    handler. Client assertions about plan or capabilities are never read.
  const caps: CapabilityResult = computeEffectiveCapabilities({
    companyId: input.companyId,
    plan: input.plan,
    contract: input.contract,
    nowMs: input.nowMs,
  });
  if (!caps.ok) {
    return { ok: false, reason: 'capabilities_unavailable', detail: caps.code };
  }
  if (!caps.capabilities.dvirEnabled) {
    return { ok: false, reason: 'dvir_not_entitled', detail: 'dvir capability absent' };
  }
  // A governed DVIR handoff only exists where operational work is bound to a
  // work period. Without that the shift binding would be decorative.
  if (!caps.capabilities.explicitShiftRequiredBeforeJobs) {
    return {
      ok: false,
      reason: 'work_period_not_required',
      detail: 'company does not bind work to an explicit shift',
    };
  }

  // 3. The shift itself, judged by the canonical resolver rather than by a
  //    local reading of the document. That keeps closed / superseded /
  //    absent / unreadable semantics identical to every other consumer.
  const config = toContractsWorkPeriodConfiguration(input.contract);
  if (!config) {
    return { ok: false, reason: 'capabilities_unavailable', detail: 'no work period configuration' };
  }
  const resolution = resolveWorkPeriod({
    contractVersion: config.contractVersion,
    companyId: input.companyId,
    driverId: input.driverId,
    capabilities: caps.capabilities,
    config,
    nowMs: input.nowMs,
    evidence: {
      today: input.originDayDoc,
      cachedShiftId: input.binding.shiftId,
      cachedOriginDay: input.originDayDoc,
    },
  });

  if (!isOperationallyOpen(resolution)) {
    return { ok: false, reason: 'shift_not_active', detail: resolution.outcome };
  }
  // 4. THE binding check. The resolver may report an open period that is a
  //    DIFFERENT shift — a newer one opened the same day supersedes the
  //    requested id. Authorizing that would silently bridge eQuipment to a
  //    shift the governed request never named.
  if (resolution.periodId !== input.binding.shiftId) {
    return {
      ok: false,
      reason: 'shift_id_mismatch',
      detail: 'requested shift is not the open period',
    };
  }

  // 5. Normalized: exactly the two protocol fields, rebuilt rather than
  //    passed through, so nothing extra can ride along into storage.
  return {
    ok: true,
    binding: { shiftId: resolution.periodId, phase: input.binding.phase },
    capabilities: caps.capabilities,
  };
}
