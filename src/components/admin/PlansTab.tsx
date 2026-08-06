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

const service = createAdminContractService();

export function PlansTab() {
  const [plans, setPlans] = useState<PlanDefinition[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<PlanDefinition | null>(null);
  const [formPlanId, setFormPlanId] = useState('');
  const [formName, setFormName] = useState('');
  const [formCaps, setFormCaps] = useState<PlanCapability[]>([]);
  const [formErrors, setFormErrors] = useState<PlanFormErrors>({});
  const [busy, setBusy] = useState(false);

  const surface = (err: unknown) => {
    const g = errorGuidance(err instanceof AdminServiceError ? err : { kind: 'unknown' });
    setNotice(g.message + (g.action === 'reload' ? ' (list reloaded)' : ''));
    if (g.action === 'reload') void load(true);
  };

  const load = useCallback(async (reset: boolean) => {
    setLoading(true);
    try {
      const page = await service.listPlans({ limit: 25, ...(reset || !cursor ? {} : { cursor }) });
      setPlans((prev) => (reset ? page.plans : [...prev, ...page.plans]));
      setCursor(page.nextCursor);
    } catch (err) {
      surface(err);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor]);

  useEffect(() => { void load(true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const openCreate = () => {
    setEditing(null); setFormPlanId(''); setFormName(''); setFormCaps([]); setFormErrors({}); setShowForm(true);
  };
  const openEdit = (p: PlanDefinition) => {
    setEditing(p); setFormPlanId(p.planId); setFormName(p.displayName); setFormCaps([...p.capabilities]); setFormErrors({}); setShowForm(true);
  };

  const submit = async () => {
    const check = validatePlanForm({ planId: formPlanId, displayName: formName, capabilities: formCaps, isEdit: !!editing });
    setFormErrors(check.errors);
    if (!check.ok || busy) return;
    setBusy(true);
    try {
      if (editing) {
        // planId is the immutable identifier — only mutable fields travel.
        await service.updatePlan({ planId: editing.planId, displayName: formName.trim(), capabilities: formCaps });
        setNotice(`Updated plan ${editing.planId}.`);
      } else {
        await service.createPlan({ planId: formPlanId, displayName: formName.trim(), capabilities: formCaps });
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
      ) : plans.length === 0 ? (
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
          <div className="flex gap-2">
            <button onClick={() => void submit()} disabled={busy}
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
