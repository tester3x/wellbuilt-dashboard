/**
 * vc51.9L — plan app-entitlement display and editing, as pure logic.
 *
 * No React, no Firestore, no callable transport: the component renders
 * what these functions decide, so the whole matrix — legacy vs empty vs
 * configured vs invalid, and every save payload — runs in a node harness.
 *
 * EVERY RULE COMES FROM CONTRACTS 0.3.0. The app keys, the core-app rule,
 * the entry shape, validation and normalization are all the package's;
 * nothing here restates them. That is what keeps the editor from being a
 * second opinion about what a plan means, and it is why an alias like
 * `wbt` cannot be displayed or submitted — it is not a canonical key, so
 * it never enters a row.
 *
 * COMMERCIAL ONLY. These entitlements say what a company BOUGHT. They are
 * not customer configuration, not per-shift readiness (DVIR/JSA/Pre-Trip),
 * and not the operational work-period rule. `requiresActiveShift` here
 * means "this app is sold as shift-scoped access" and nothing else.
 */

import {
  WELLBUILT_APP_KEYS,
  WELLBUILT_APP_TICKETS,
  WELLBUILT_APP_EQUIPMENT,
  WELLBUILT_APP_JSA,
  WELLBUILT_APP_MOBILE,
  WELLBUILT_APP_SUITE,
  WELLBUILT_APP_DASHBOARD,
  isCoreApp,
  validatePlanAppEntitlements,
  type PlanAppEntitlements,
  type WellbuiltAppKey,
} from '@tester3x/wellbuilt-contracts';

/** Canonical product names. Keyed by canonical key — never by an alias. */
export const WELLBUILT_APP_PRODUCT_NAMES: Readonly<Record<WellbuiltAppKey, string>> = Object.freeze({
  [WELLBUILT_APP_SUITE]: 'WellBuilt Suite',
  [WELLBUILT_APP_TICKETS]: 'WellBuilt Tickets',
  [WELLBUILT_APP_EQUIPMENT]: 'WellBuilt eQuipment',
  [WELLBUILT_APP_JSA]: 'WellBuilt JSA',
  [WELLBUILT_APP_MOBILE]: 'WellBuilt Mobile',
  [WELLBUILT_APP_DASHBOARD]: 'WellBuilt Dashboard',
});

/** Destination apps — everything the plan actually prices. */
export const DESTINATION_APPS: readonly WellbuiltAppKey[] = Object.freeze(
  WELLBUILT_APP_KEYS.filter((k) => !isCoreApp(k)),
);

// ── display ───────────────────────────────────────────────────────────────

export type PlanEntitlementDisplay =
  | { kind: 'legacy'; label: string; tone: 'neutral' }
  | { kind: 'none'; label: string; tone: 'warn' }
  | { kind: 'configured'; label: string; tone: 'info'; included: number; total: number }
  | { kind: 'invalid'; label: string; tone: 'danger'; reason: string };

/**
 * Classify a plan's stored `apps` for display.
 *
 * Takes `unknown` on purpose: what came back from the callable is stored
 * data, not a promise about its shape. Invalid data is NEVER shown as
 * legacy or as empty — those are meaningful, deliberate states, and
 * quietly folding corruption into either would tell an administrator the
 * plan says something it does not.
 */
export function describePlanEntitlement(apps: unknown): PlanEntitlementDisplay {
  const result = validatePlanAppEntitlements(apps);
  if (!result.ok) {
    return {
      kind: 'invalid',
      tone: 'danger',
      label: 'Invalid entitlement data',
      reason: result.key ? `${result.rejection}: ${result.key}` : result.rejection,
    };
  }
  if (!result.present) {
    return { kind: 'legacy', tone: 'neutral', label: 'Legacy — app access not configured' };
  }
  const included = DESTINATION_APPS.filter((a) => result.value[a]?.included === true).length;
  if (included === 0 && Object.keys(result.value).length === 0) {
    return { kind: 'none', tone: 'warn', label: 'No destination apps included' };
  }
  return {
    kind: 'configured',
    tone: 'info',
    label: included === 0
      ? 'No destination apps included'
      : `${included} of ${DESTINATION_APPS.length} destination apps included`,
    included,
    total: DESTINATION_APPS.length,
  };
}

// ── editing ───────────────────────────────────────────────────────────────

export interface AppEntitlementRow {
  app: WellbuiltAppKey;
  productName: string;
  included: boolean;
  requiresActiveShift: boolean;
}

export interface PlanEntitlementDraft {
  /**
   * legacy     — `apps` absent. Saving omits the field entirely.
   * configured — a deliberate map. Saving submits it, `{}` included.
   * invalid    — stored data could not be trusted. Cannot be saved until
   *              the administrator deliberately reconfigures, so a bad
   *              document is never silently rewritten into something
   *              plausible.
   */
  state: 'legacy' | 'configured' | 'invalid';
  rows: AppEntitlementRow[];
  invalidReason?: string;
}

const blankRows = (): AppEntitlementRow[] => DESTINATION_APPS.map((app) => ({
  app,
  productName: WELLBUILT_APP_PRODUCT_NAMES[app],
  included: false,
  requiresActiveShift: false,
}));

/** Build the editor's starting state from a plan's stored `apps`. */
export function draftFromStoredApps(apps: unknown): PlanEntitlementDraft {
  const result = validatePlanAppEntitlements(apps);
  if (!result.ok) {
    return {
      state: 'invalid',
      rows: blankRows(),
      invalidReason: result.key ? `${result.rejection}: ${result.key}` : result.rejection,
    };
  }
  if (!result.present) return { state: 'legacy', rows: blankRows() };
  return {
    state: 'configured',
    rows: DESTINATION_APPS.map((app) => {
      const entry = result.value[app];
      return {
        app,
        productName: WELLBUILT_APP_PRODUCT_NAMES[app],
        included: entry?.included === true,
        requiresActiveShift: entry?.requiresActiveShift === true,
      };
    }),
  };
}

/**
 * The deliberate act that materializes a map.
 *
 * Opening a legacy plan, editing its name, and cancelling must all leave
 * absence intact — `{}` is an authoritative statement that the company
 * gets no destination apps, and nobody should make that statement by
 * accident. This is the only way out of 'legacy', and it is also the
 * repair path out of 'invalid'.
 */
export function beginConfiguring(draft: PlanEntitlementDraft): PlanEntitlementDraft {
  if (draft.state === 'configured') return draft;
  return { state: 'configured', rows: draft.rows.map((r) => ({ ...r })) };
}

/** Include or exclude one destination app. */
export function setAppIncluded(
  draft: PlanEntitlementDraft,
  app: WellbuiltAppKey,
  included: boolean,
): PlanEntitlementDraft {
  if (draft.state !== 'configured') return draft;
  return {
    ...draft,
    rows: draft.rows.map((r) => (r.app !== app ? r : {
      ...r,
      included,
      // Excluding clears the shift condition rather than leaving it set
      // but unreachable: a shift requirement on something the company
      // cannot reach is contradictory, and the contract rejects it.
      requiresActiveShift: included ? r.requiresActiveShift : false,
    })),
  };
}

/**
 * NO plan-level shift authoring exists any more.
 *
 * A shift requirement is a per-COMPANY operational decision, so a plan
 * mandating one for every assigned company is not a shape this product
 * creates. The setter is gone rather than merely hidden, so no UI or
 * future caller can mint a new plan-level gate.
 *
 * LEGACY FLAGS ARE PRESERVED, NOT ERASED. A plan written before this
 * decision may still carry `requiresActiveShift: true`; that value is read
 * into the row and written back out unchanged, so editing an unrelated
 * field cannot silently relax a gate that is still enforced. Removing such
 * a flag is a deliberate migration, not a side effect of an edit.
 */

/** Invalid stored data must be deliberately repaired before any save. */
export function canSaveEntitlements(draft: PlanEntitlementDraft): boolean {
  return draft.state !== 'invalid';
}

/**
 * The `apps` portion of a create/update payload.
 *
 * Returns an EMPTY OBJECT for the legacy state — meaning the caller
 * spreads nothing, so the field is genuinely omitted and the backend
 * leaves stored absence untouched. A configured draft yields `{apps: …}`,
 * including a deliberate `{}`. Suite is never submitted: core access does
 * not depend on plan data, so the map stays purely commercial.
 */
export function entitlementPayload(
  draft: PlanEntitlementDraft,
): Record<string, never> | { apps: PlanAppEntitlements } {
  if (draft.state !== 'configured') return {};
  const apps: PlanAppEntitlements = {};
  for (const row of draft.rows) {
    if (isCoreApp(row.app)) continue;
    apps[row.app] = row.included && row.requiresActiveShift
      ? { included: true, requiresActiveShift: true }
      : { included: row.included };
  }
  return { apps };
}

/**
 * Local pre-flight using the canonical validator.
 *
 * The backend remains the authoritative write boundary — this only stops
 * an obviously invalid payload from making the round trip, and proves the
 * editor cannot construct something the contract would refuse.
 */
export function validateDraft(draft: PlanEntitlementDraft): { ok: true } | { ok: false; reason: string } {
  if (draft.state === 'invalid') {
    return { ok: false, reason: draft.invalidReason ?? 'invalid_entitlement_data' };
  }
  const payload = entitlementPayload(draft);
  if (!('apps' in payload)) return { ok: true };
  const result = validatePlanAppEntitlements(payload.apps);
  return result.ok
    ? { ok: true }
    : { ok: false, reason: result.key ? `${result.rejection}: ${result.key}` : result.rejection };
}
