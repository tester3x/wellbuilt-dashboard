'use client';

/**
 * vc51.9A7 — plan catalog administration. ALL mutations go through the
 * typed callable service (createPlan / updatePlan / deprecatePlan);
 * there is NO hard delete and NO direct Firestore access in this file.
 * planId is permanent: the edit form never submits it, and display-name
 * changes cannot alter it.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  createAdminContractService,
  AdminServiceError,
  type PlanCapability,
  type PlanDefinition,
} from '@/lib/adminContractService';
import {
  PLAN_CAPABILITY_OPTIONS,
  errorGuidance,
  validatePlanForm,
  type PlanFormErrors,
} from '@/lib/adminUiLogic';
import {
  WELLBUILT_APP_PRODUCT_NAMES,
  beginConfiguring,
  canSaveEntitlements,
  describePlanEntitlement,
  draftFromStoredApps,
  entitlementPayload,
  setAppIncluded,
  setAppRequiresShift,
  validateDraft,
  type PlanEntitlementDraft,
} from '@/lib/planEntitlement';
import { WELLBUILT_APP_SUITE } from '@tester3x/wellbuilt-contracts';

const service = createAdminContractService();

export function PlansTab() {
  const [plans, setPlans] = useState<PlanDefinition[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  /**
   * Load phase, tracked separately from the list.
   *
   * The empty state used to key on `plans.length === 0`, and `plans` is
   * only replaced on success — so a failed read told the administrator
   * "No plans exist yet. Create the first plan." That is not merely
   * under-reporting: it is an instruction, issued at the exact moment the
   * client does not know what exists. Following it against a non-empty
   * catalog means a refused create, or a genuine duplicate under a
   * different planId.
   */
  const [loadPhase, setLoadPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<PlanDefinition | null>(null);
  const [formPlanId, setFormPlanId] = useState('');
  const [formName, setFormName] = useState('');
  const [formCaps, setFormCaps] = useState<PlanCapability[]>([]);
  const [formErrors, setFormErrors] = useState<PlanFormErrors>({});
  const [entitlements, setEntitlements] = useState<PlanEntitlementDraft>(() => draftFromStoredApps(undefined));
  const [busy, setBusy] = useState(false);

  const surface = (err: unknown) => {
    const g = errorGuidance(err instanceof AdminServiceError ? err : { kind: 'unknown' });
    setNotice(g.message + (g.action === 'reload' ? ' (list reloaded)' : ''));
    if (g.action === 'reload') void load(true);
  };

  const load = useCallback(async (reset: boolean) => {
    setLoading(true);
    setLoadPhase('loading');
    try {
      const page = await service.listPlans({ limit: 25, ...(reset || !cursor ? {} : { cursor }) });
      setPlans((prev) => (reset ? page.plans : [...prev, ...page.plans]));
      setCursor(page.nextCursor);
      setLoadPhase('ready');
    } catch (err) {
      // NOT surface(): it calls load() whenever the guidance action is
      // 'reload', and this IS load()'s catch. not_found and conflict both
      // carry that action, so routing a read failure through it re-enters
      // load from load with nothing to bound it. Recovery is Retry.
      setNotice(errorGuidance(err instanceof AdminServiceError ? err : { kind: 'unknown' }).message);
      setLoadPhase('error');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor]);

  useEffect(() => { void load(true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const openCreate = () => {
    setEditing(null); setFormPlanId(''); setFormName(''); setFormCaps([]); setFormErrors({});
    // A new plan starts LEGACY, not empty: creating one is not by itself a
    // statement that the company gets no apps.
    setEntitlements(draftFromStoredApps(undefined));
    setShowForm(true);
  };
  const openEdit = (p: PlanDefinition) => {
    setEditing(p); setFormPlanId(p.planId); setFormName(p.displayName); setFormCaps([...p.capabilities]); setFormErrors({});
    // Opening reflects what is STORED. Absence stays absence — nothing is
    // materialized until "Configure app access" is pressed.
    setEntitlements(draftFromStoredApps(p.apps));
    setShowForm(true);
  };

  const submit = async () => {
    const check = validatePlanForm({ planId: formPlanId, displayName: formName, capabilities: formCaps, isEdit: !!editing });
    setFormErrors(check.errors);
    if (!check.ok || busy) return;
    const entitlementCheck = validateDraft(entitlements);
    if (!entitlementCheck.ok) {
      setNotice(`App access cannot be saved: ${entitlementCheck.reason}. Use “Configure app access” to set it deliberately.`);
      return;
    }
    // Spreads NOTHING while the section is untouched, so `apps` is omitted
    // from the payload entirely and stored absence survives.
    const appsPayload = entitlementPayload(entitlements);
    setBusy(true);
    try {
      if (editing) {
        // planId is the immutable identifier — only mutable fields travel.
        await service.updatePlan({ planId: editing.planId, displayName: formName.trim(), capabilities: formCaps, ...appsPayload });
        setNotice(`Updated plan ${editing.planId}.`);
      } else {
        await service.createPlan({ planId: formPlanId, displayName: formName.trim(), capabilities: formCaps, ...appsPayload });
        setNotice(`Created plan ${formPlanId}.`);
      }
      setShowForm(false);
      await load(true);
    } catch (err) {
      surface(err);
    } finally {
      setBusy(false);
    }
  };

  const deprecate = async (p: PlanDefinition) => {
    if (!window.confirm(`Deprecate plan "${p.planId}"? Companies already assigned keep working; NEW assignments are blocked. There is no delete.`)) return;
    setBusy(true);
    try {
      await service.deprecatePlan({ planId: p.planId });
      setNotice(`Deprecated ${p.planId}. Assigned companies are unaffected.`);
      await load(true);
    } catch (err) {
      surface(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-white text-sm font-medium">Plans</h3>
          <p className="text-gray-400 text-xs">Commercial entitlement catalog. Plans are deprecated, never deleted.</p>
        </div>
        <button onClick={openCreate} className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-400">
          New Plan
        </button>
      </div>

      {notice && <div role="status" className="text-amber-300 text-xs bg-amber-900/30 border border-amber-700 rounded p-2">{notice}</div>}

      {loading && plans.length === 0 ? (
        <p className="text-gray-400 text-sm">Loading plans…</p>
      ) : loadPhase === 'error' && plans.length === 0 ? (
        <div className="text-sm">
          <p className="text-red-400 mb-2">
            The plan catalog could not be read, so none are listed. Do not create a plan
            from this state — what already exists is unknown.
          </p>
          <button
            onClick={() => { void load(true); }}
            className="px-3 py-1 rounded bg-gray-600 hover:bg-gray-500 text-white"
          >
            Retry
          </button>
        </div>
      ) : loadPhase === 'ready' && plans.length === 0 ? (
        <p className="text-gray-400 text-sm">No plans exist yet. Create the first plan to begin assigning companies.</p>
      ) : (
        <ul className="space-y-2">
          {plans.map((p) => (
            <li key={p.planId} className="bg-gray-700 rounded p-3 flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="text-blue-300 text-sm">{p.planId}</code>
                  <span className="text-white text-sm">{p.displayName}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${p.status === 'active' ? 'bg-green-800 text-green-200' : 'bg-gray-600 text-gray-300'}`}>
                    {p.status}
                  </span>
                  <span className="text-[10px] text-gray-400">contract v{p.contractVersion}</span>
                </div>
                <p className="text-gray-300 text-xs mt-1">
                  {p.capabilities.length ? p.capabilities.join(', ') : 'no capabilities'}
                </p>
                {(() => {
                  // Every plan states its entitlement position explicitly.
                  // Invalid data is never rendered as legacy or as empty.
                  const d = describePlanEntitlement(p.apps);
                  const tone = d.tone === 'danger' ? 'bg-red-900/50 text-red-200 border-red-700'
                    : d.tone === 'warn' ? 'bg-amber-900/40 text-amber-200 border-amber-700'
                    : d.tone === 'info' ? 'bg-blue-900/40 text-blue-200 border-blue-700'
                    : 'bg-gray-600/40 text-gray-300 border-gray-500';
                  return (
                    <p className={`text-[11px] mt-1 inline-block px-1.5 py-0.5 rounded border ${tone}`}>
                      {d.label}
                      {d.kind === 'invalid' && <span className="ml-1 opacity-80">({d.reason})</span>}
                    </p>
                  );
                })()}
              </div>
              <div className="flex gap-2 shrink-0">
                <button onClick={() => openEdit(p)} className="px-2 py-1 text-xs rounded bg-blue-600 hover:bg-blue-500 text-white">Edit</button>
                {p.status === 'active' && (
                  <button onClick={() => deprecate(p)} disabled={busy}
                    className="px-2 py-1 text-xs rounded bg-orange-800 hover:bg-orange-700 text-orange-100 disabled:opacity-50">
                    Deprecate
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {cursor && (
        <button onClick={() => void load(false)} disabled={loading}
          className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm disabled:opacity-50">
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}

      {showForm && (
        <div className="bg-gray-800 border border-gray-600 rounded-lg p-4 space-y-3" role="dialog" aria-label={editing ? `Edit plan ${editing.planId}` : 'Create plan'}>
          <h4 className="text-white text-sm font-medium">{editing ? `Edit ${editing.planId}` : 'Create plan'}</h4>
          {!editing && (
            <div>
              <label htmlFor="plan-id" className="block text-gray-300 text-xs mb-1">Plan ID (permanent, lowercase)</label>
              <input id="plan-id" value={formPlanId} onChange={(e) => setFormPlanId(e.target.value)}
                className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-white text-sm" />
              {formErrors.planId && <p className="text-red-400 text-xs mt-1">{formErrors.planId}</p>}
            </div>
          )}
          {editing && (
            <p className="text-gray-400 text-xs">Plan ID <code className="text-blue-300">{editing.planId}</code> is permanent and cannot change.</p>
          )}
          <div>
            <label htmlFor="plan-name" className="block text-gray-300 text-xs mb-1">Display name</label>
            <input id="plan-name" value={formName} onChange={(e) => setFormName(e.target.value)}
              className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-white text-sm" />
            {formErrors.displayName && <p className="text-red-400 text-xs mt-1">{formErrors.displayName}</p>}
          </div>
          <fieldset>
            <legend className="text-gray-300 text-xs mb-1">Capabilities (customer-configurable areas shown in parentheses)</legend>
            {PLAN_CAPABILITY_OPTIONS.map((opt) => (
              <label key={opt.id} className="flex items-center gap-2 text-sm text-gray-200 py-0.5">
                <input
                  type="checkbox"
                  checked={formCaps.includes(opt.id)}
                  onChange={(e) => setFormCaps((prev) => e.target.checked ? [...prev, opt.id] : prev.filter((c) => c !== opt.id))}
                />
                {opt.label}
                <span className="text-gray-500 text-xs">({opt.customerConfigurable})</span>
              </label>
            ))}
            {formErrors.capabilities && <p className="text-red-400 text-xs mt-1">{formErrors.capabilities}</p>}
          </fieldset>

          <fieldset className="border-t border-gray-700 pt-3">
            <legend className="text-gray-300 text-xs mb-1">App access (commercial entitlement)</legend>
            <p className="text-gray-500 text-[11px] mb-2">
              What the company BOUGHT. Separate from customer configuration and from
              per-shift readiness such as DVIR or JSA.
            </p>

            <p className="text-[11px] text-gray-400 mb-2">
              <span className="text-gray-200">{WELLBUILT_APP_PRODUCT_NAMES[WELLBUILT_APP_SUITE]}</span>
              {' '}— always included. Suite is where a denial is explained and a shift is
              started, so it is core and cannot be sold, withheld, or shift-gated.
            </p>

            {entitlements.state === 'invalid' && (
              <p role="alert" className="text-red-300 text-xs bg-red-900/30 border border-red-700 rounded p-2 mb-2">
                This plan&rsquo;s stored app entitlements are invalid ({entitlements.invalidReason}).
                Nothing will be saved until you deliberately reconfigure them below.
              </p>
            )}

            {entitlements.state !== 'configured' ? (
              <div className="text-xs text-gray-300 space-y-2">
                {entitlements.state === 'legacy' && (
                  <p>
                    Legacy — app access is not configured. Destination apps are
                    temporarily permitted. Saving other changes leaves this untouched.
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => setEntitlements((d) => beginConfiguring(d))}
                  className="px-2 py-1 rounded bg-blue-700 hover:bg-blue-600 text-white"
                >
                  Configure app access
                </button>
              </div>
            ) : (
              <div className="space-y-1">
                {entitlements.rows.map((row) => (
                  <div key={row.app} className="flex flex-wrap items-center gap-3 text-sm text-gray-200 py-0.5">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={row.included}
                        onChange={(e) => setEntitlements((d) => setAppIncluded(d, row.app, e.target.checked))}
                      />
                      {row.productName}
                    </label>
                    <label className={`flex items-center gap-1 text-xs ${row.included ? 'text-gray-300' : 'text-gray-600'}`}>
                      <input
                        type="checkbox"
                        checked={row.requiresActiveShift}
                        // Only an INCLUDED app can be shift-scoped: a shift
                        // condition on something unreachable is contradictory
                        // and the contract refuses it.
                        disabled={!row.included}
                        onChange={(e) => setEntitlements((d) => setAppRequiresShift(d, row.app, e.target.checked))}
                      />
                      {/* GLOBAL by nature: this binds every company assigned
                          this plan. A per-company requirement is set on the
                          company's own contract panel instead. */}
                      Plan mandates active shift for every company
                    </label>
                  </div>
                ))}
                <p className="text-gray-500 text-[11px] pt-1">
                  Saving stores this exactly. Including nothing is a deliberate
                  statement that the company gets no destination apps.
                </p>
              </div>
            )}
          </fieldset>
          <div className="flex gap-2">
            <button onClick={() => void submit()} disabled={busy || !canSaveEntitlements(entitlements)}
              className="px-3 py-1.5 rounded bg-green-700 hover:bg-green-600 text-white text-sm disabled:opacity-50">
              {busy ? 'Saving…' : editing ? 'Save changes' : 'Create plan'}
            </button>
            <button onClick={() => setShowForm(false)} className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
