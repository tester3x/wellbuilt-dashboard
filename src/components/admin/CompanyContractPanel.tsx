'use client';

/**
 * vc51.9A7 — per-company WellBuilt contract administration: contract
 * state, plan assignment, entitlement overrides, effective-policy
 * preview, and the separate enforcement control. Every mutation goes
 * through the typed callable service — NO firebase/firestore import
 * exists in this file. Assignment NEVER enforces: activation is its
 * own deliberate, confirmed action.
 *
 * Overrides here adjust the company's PURCHASED/EFFECTIVE capabilities
 * (what the company is entitled to). They are unrelated to employee
 * roleCapabilities, which stay in the Roles settings card.
 */

import { useCallback, useEffect, useState } from 'react';
import { VerifiedAdminGate } from './VerifiedAdminGate';
import { useVerifiedAdmin } from '@/lib/useVerifiedAdmin';
import { contractLoadFailure } from '@/lib/adminLoadFailure';
import {
  CORE_APPS,
  beginConfiguringCompany,
  canSaveCompanyAppSettings,
  companyAppConfigurationPayload,
  describeCompanyAppSettings,
  draftFromContract,
  setCompanyAppEnabled,
  setCompanyAppRequiresShift,
  validateCompanyDraft,
  type CompanyAppSettingsDraft,
} from '@/lib/companyAppSettings';
import { WELLBUILT_APP_PRODUCT_NAMES } from '@/lib/planEntitlement';
import {
  createAdminContractService,
  AdminServiceError,
  type CapabilityResult,
  type CompanyContractStateLabel,
  type PlanCapability,
  type PlanDefinition,
  type WellbuiltContract,
} from '@/lib/adminContractService';
import {
  ENFORCEMENT_WARNING,
  PLAN_CAPABILITY_OPTIONS,
  contractStateView,
  describeEffectivePreview,
  enforcementReadiness,
  errorGuidance,
  overrideView,
} from '@/lib/adminUiLogic';

const service = createAdminContractService();

const TONE_CLASS: Record<string, string> = {
  neutral: 'text-gray-300', info: 'text-blue-300', active: 'text-green-300',
  warn: 'text-amber-300', danger: 'text-red-300',
};

export function CompanyContractPanel({ companyId }: { companyId: string }) {
  const { session, refreshAccess } = useVerifiedAdmin();
  /**
   * Load phase, tracked separately from the data.
   *
   * This panel used `state === null` as its spinner condition, and `state`
   * is only assigned when the read succeeds — so a rejected
   * getCompanyContractConfiguration left the operator on
   * "Loading contract state…" forever, with the error invisible because
   * the early return fired before the notice could render.
   */
  const [loadPhase, setLoadPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string>('');
  const [state, setState] = useState<CompanyContractStateLabel | null>(null);
  const [contract, setContract] = useState<WellbuiltContract | null>(null);
  const [invalidReason, setInvalidReason] = useState<string | undefined>();
  const [preview, setPreview] = useState<CapabilityResult | null>(null);
  const [plans, setPlans] = useState<PlanDefinition[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [assignPlanId, setAssignPlanId] = useState('');
  /**
   * The company app-settings draft.
   *
   * Rebuilt from the AUTHORITATIVE contract on every load, so viewing a
   * company — or a failed write that leaves stored state untouched — can
   * never leave a stale or half-made map on screen.
   */
  const [appDraft, setAppDraft] = useState<CompanyAppSettingsDraft>(
    () => draftFromContract(null, undefined));
  const [ovCapability, setOvCapability] = useState<PlanCapability>('jsa');
  const [ovGranted, setOvGranted] = useState(true);
  const [ovReason, setOvReason] = useState('');
  const [ovExpires, setOvExpires] = useState('');
  const nowMs = Date.now();

  const surface = (err: unknown) => {
    const g = errorGuidance(err instanceof AdminServiceError ? err : { kind: 'unknown' });
    setNotice(g.message);
    if (g.action === 'reload') void reload();
  };

  /**
   * Report without acting. surface() re-enters reload() whenever the
   * guidance action is 'reload' — correct after a mutation left the view
   * stale, but fatal inside reload() itself, which is where every failure
   * below is caught. not_found and conflict both carry that action, and
   * adminGetCompanyContractConfiguration answers not-found/company_not_found
   * for any company without a contract document, so routing a LOAD failure
   * through surface() calls reload from reload with nothing to bound it.
   * Recovery here is the operator's Retry button.
   */
  const reportOnly = (err: unknown) => setNotice(contractLoadFailure(err).message);

  const reload = useCallback(async () => {
    setLoadPhase('loading');
    setLoadError('');
    try {
      const cfg = await service.getCompanyContractConfiguration({ companyId });
      setState(cfg.state);
      setContract(cfg.contract ?? null);
      setInvalidReason(cfg.invalidReason);
      if (cfg.state === 'inert' || cfg.state === 'active') {
        // A capability-preview failure must not blank the contract state we
        // already read successfully.
        try {
          const p = await service.previewCompanyEffectiveCapabilities({ companyId });
          setPreview(p.result ?? null);
        } catch (previewErr) {
          setPreview(null);
          reportOnly(previewErr);
        }
      } else {
        setPreview(null);
      }
      setLoadPhase('ready');
    } catch (err) {
      // The service always rejects with an AdminServiceError (kind +
      // adminCode) — it has no `code` property, so inspecting one matched
      // nothing and reported every cause as the same generic sentence.
      setLoadError(contractLoadFailure(err).message);
      setLoadPhase('error');
      setNotice(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  useEffect(() => {
    // Both callables are dual-gated server-side. Reading them without a
    // verified session produces a guaranteed permission-denied per company
    // row, so wait for the claim rather than spend the call.
    if (session.status !== 'verified') return;
    void reload();
    service.listPlans({ limit: 50 }).then((r) => setPlans(r.plans)).catch(surface);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, session.status]);

  /**
   * Rebuild the draft from AUTHORITATIVE state whenever it changes.
   *
   * That covers first load, switching company, and the reload `run()`
   * performs after a successful write — so what is on screen is always
   * what the server last confirmed, never an optimistic guess. A FAILED
   * write does not reload, so the stored state stays displayed and the
   * operator keeps their edits alongside the error.
   */
  useEffect(() => {
    const plan = plans.find((p) => p.planId === contract?.planId) ?? null;
    setAppDraft(draftFromContract(plan, contract?.appConfiguration));
  }, [contract, plans]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await fn();
      setNotice(label);
      await reload();
    } catch (err) {
      surface(err);
    } finally {
      setBusy(false);
    }
  };

  /**
   * The server's gate, mirrored.
   *
   * CompaniesTab offers this panel on isPlatformAdmin(user) — a Firestore
   * PROFILE role. authorizeAdminCall requires something else entirely: the
   * wellbuiltAdmin custom claim AND an enabled platform_admins/{uid}
   * record. A company role, "Owner" included, implies neither, so the tool
   * was being offered to sessions that could never use it and the denial
   * arrived as an unexplained failed read. The profile-role gate is
   * unchanged and still decides who is offered this area; this is the
   * second gate, shown honestly, with the refresh action attached.
   */
  if (session.status !== 'verified') {
    return (
      <VerifiedAdminGate session={session} onRefresh={refreshAccess}>
        {null}
      </VerifiedAdminGate>
    );
  }
  if (loadPhase === 'error') {
    return (
      <div className="text-sm">
        <p className="text-red-400 mb-2">{loadError || 'Could not load contract state.'}</p>
        <button
          onClick={() => { void reload(); }}
          className="px-3 py-1 rounded bg-gray-600 hover:bg-gray-500 text-white"
        >
          Retry
        </button>
      </div>
    );
  }
  if (loadPhase === 'loading' || state === null) {
    return <p className="text-gray-400 text-sm">Loading contract state…</p>;
  }
  const view = contractStateView(state, invalidReason);
  const selectedPlan = plans.find((p) => p.planId === assignPlanId);
  // The plan this company is ACTUALLY on — the ceiling its app settings sit
  // under. Distinct from `selectedPlan`, which is whatever the assign
  // dropdown is currently showing.
  const assignedPlan = plans.find((p) => p.planId === contract?.planId) ?? null;
  const readiness = enforcementReadiness({ state, contract, preview });
  const lines = describeEffectivePreview({ state, result: preview ?? undefined, invalidReason, contract }, nowMs);

  return (
    <div className="border-t border-gray-600 pt-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-purple-400 text-sm font-medium">WellBuilt Contract</h4>
        <span className={`px-2 py-0.5 text-xs rounded bg-gray-900 ${TONE_CLASS[view.tone]}`}>{view.label}</span>
      </div>
      <p className="text-gray-400 text-xs">{view.description}</p>
      {contract && (
        <p className="text-gray-400 text-xs">
          Plan <code className="text-blue-300">{contract.planId}</code> · contract v{contract.contractVersion} · configuration v{contract.configurationVersion}
        </p>
      )}
      {notice && <div role="status" className="text-amber-300 text-xs bg-amber-900/30 border border-amber-700 rounded p-2">{notice}</div>}

      {state !== 'invalid' && (
        <div className="space-y-1">
          <label htmlFor={`assign-${companyId}`} className="block text-gray-300 text-xs">
            Assign plan (assignment alone never enforces — activation is a separate step)
          </label>
          <div className="flex flex-wrap gap-2">
            <select id={`assign-${companyId}`} value={assignPlanId} onChange={(e) => setAssignPlanId(e.target.value)}
              className="bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-white text-sm">
              <option value="">— choose plan —</option>
              {plans.map((p) => (
                <option key={p.planId} value={p.planId}>{p.planId} ({p.status})</option>
              ))}
            </select>
            <button
              disabled={!assignPlanId || busy || selectedPlan?.status === 'deprecated'}
              onClick={() => void run(`Assigned ${assignPlanId} (inert — not enforced).`, () =>
                service.assignCompanyPlan({ companyId, planId: assignPlanId }))}
              className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white text-sm disabled:opacity-50">
              Assign
            </button>
          </div>
          {selectedPlan?.status === 'deprecated' && (
            <p className="text-amber-300 text-xs">This plan is deprecated — new assignment is blocked by the server (a narrowly named migration override exists for migrations only).</p>
          )}
        </div>
      )}

      {(state === 'inert' || state === 'active') && contract && (
        <>
          {/* Entitlement overrides — purchased capability, not employee roles */}
          <div className="space-y-1">
            <h5 className="text-gray-200 text-xs font-medium">Entitlement overrides</h5>
            <p className="text-gray-500 text-xs">
              Overrides adjust what this company is ENTITLED to beyond its plan. They never change employee roles — role permissions live in Settings → Roles.
            </p>
            {contract.entitlementOverrides.length === 0 && <p className="text-gray-400 text-xs">No overrides.</p>}
            <ul className="space-y-1">
              {contract.entitlementOverrides.map((o, idx) => {
                const v = overrideView(o, nowMs);
                return (
                  <li key={idx} className={`text-xs rounded p-2 bg-gray-900 ${v.expired ? 'opacity-60' : ''}`}>
                    <span className={v.effect === 'grants' ? 'text-green-300' : 'text-red-300'}>{v.effect}</span>{' '}
                    <code className="text-blue-300">{v.capability}</code>{' '}
                    <span className="text-gray-400">— {v.reason} · {v.expiresText}{v.expired ? ' (EXPIRED — no longer applied)' : ''}</span>
                    <div className="text-gray-500">{v.actorText}</div>
                    <button
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm(`Remove all "${v.capability}" overrides for ${companyId}?`)) return;
                        const reason = window.prompt('Removal reason (required, audited):')?.trim();
                        if (!reason) { setNotice('A removal reason is required.'); return; }
                        void run(`Removed ${v.capability} override.`, () =>
                          service.removeEntitlementOverride({ companyId, capability: v.capability, reason }));
                      }}
                      className="mt-1 px-2 py-0.5 text-[10px] rounded bg-red-900/60 hover:bg-red-800 text-red-200 disabled:opacity-50">
                      Remove…
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="flex flex-wrap items-end gap-2 pt-1">
              <div>
                <label htmlFor={`ov-cap-${companyId}`} className="block text-gray-400 text-[10px]">Capability</label>
                <select id={`ov-cap-${companyId}`} value={ovCapability} onChange={(e) => setOvCapability(e.target.value as PlanCapability)}
                  className="bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs">
                  {PLAN_CAPABILITY_OPTIONS.map((c) => <option key={c.id} value={c.id}>{c.id}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor={`ov-effect-${companyId}`} className="block text-gray-400 text-[10px]">Effect</label>
                <select id={`ov-effect-${companyId}`} value={ovGranted ? 'grant' : 'revoke'} onChange={(e) => setOvGranted(e.target.value === 'grant')}
                  className="bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs">
                  <option value="grant">grant</option>
                  <option value="revoke">revoke</option>
                </select>
              </div>
              <div className="grow min-w-40">
                <label htmlFor={`ov-reason-${companyId}`} className="block text-gray-400 text-[10px]">Reason (required, max 300, audited)</label>
                <input id={`ov-reason-${companyId}`} value={ovReason} maxLength={300} onChange={(e) => setOvReason(e.target.value)}
                  className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs" />
              </div>
              <div>
                <label htmlFor={`ov-exp-${companyId}`} className="block text-gray-400 text-[10px]">Expires (optional)</label>
                <input id={`ov-exp-${companyId}`} type="datetime-local" value={ovExpires} onChange={(e) => setOvExpires(e.target.value)}
                  className="bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs" />
              </div>
              <button
                disabled={busy || !ovReason.trim()}
                onClick={() => void run(`Added ${ovCapability} override. Actor and time are recorded server-side.`, () =>
                  service.addEntitlementOverride({
                    companyId, capability: ovCapability, granted: ovGranted, reason: ovReason.trim(),
                    ...(ovExpires ? { expiresAt: new Date(ovExpires).toISOString() } : {}),
                  }))}
                className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white text-xs disabled:opacity-50">
                Add override
              </button>
            </div>
          </div>

          {/* Effective policy preview — server-computed only */}
          <div className="space-y-1">
            <h5 className="text-gray-200 text-xs font-medium">Effective policy (server preview)</h5>
            <dl className="space-y-0.5">
              {lines.map((l, i) => (
                <div key={i} className="flex gap-2 text-xs">
                  <dt className="text-gray-500 w-40 shrink-0">{l.label}</dt>
                  <dd className={TONE_CLASS[l.tone]}>{l.value}</dd>
                </div>
              ))}
            </dl>
          </div>

          {/* Enforcement — separate deliberate action */}
          <div className="space-y-1 border border-gray-700 rounded p-2">
            <h5 className="text-gray-200 text-xs font-medium">Contract enforcement</h5>
            <p className="text-amber-300 text-xs">{ENFORCEMENT_WARNING}</p>
            {state === 'inert' && !readiness.canEnable && (
              <ul className="text-red-300 text-xs list-disc ml-4">
                {readiness.blockers.map((b, i) => <li key={i}>{b}</li>)}
              </ul>
            )}
            {state === 'inert' && (
              <button
                disabled={!readiness.canEnable || busy}
                onClick={() => {
                  const typed = window.prompt(`Enforcement affects live operational apps. Type the company id "${companyId}" to confirm:`);
                  if (typed !== companyId) { setNotice('Enforcement not confirmed.'); return; }
                  void run('Contract ENFORCED.', () => service.setCompanyContractEnforcement({ companyId, enforced: true }));
                }}
                className="px-3 py-1.5 rounded bg-red-800 hover:bg-red-700 text-white text-xs disabled:opacity-50"
                title={readiness.canEnable ? undefined : 'Blocked until all preconditions above are resolved'}>
                Enforce contract…
              </button>
            )}
            {state === 'active' && (
              <button
                disabled={busy}
                onClick={() => {
                  if (!window.confirm('Disable enforcement (rollback containment)? Apps return to pre-contract behavior; the configuration is preserved.')) return;
                  void run('Enforcement disabled (rollback containment).', () => service.setCompanyContractEnforcement({ companyId, enforced: false }));
                }}
                className="px-3 py-1.5 rounded bg-orange-800 hover:bg-orange-700 text-white text-xs disabled:opacity-50">
                Disable enforcement (rollback)
              </button>
            )}
          </div>

          {/* ── App operation (per company) ───────────────────────────── */}
          <div className="border-t border-gray-700 pt-3 mt-3">
            <h5 className="text-white text-xs font-medium">App operation for this company</h5>
            <p className="text-gray-500 text-[11px] mb-2">
              The plan decides which apps this company purchased. This decides how those
              purchased apps operate here. A company may switch an included app off or
              require an active shift for it; it can never add an app the plan does not
              include, and it cannot relax a restriction the plan mandates.
            </p>

            <p className="text-[11px] text-gray-400 mb-2">
              <span className="text-gray-200">{WELLBUILT_APP_PRODUCT_NAMES[CORE_APPS[0]]}</span>
              {' '}— Always included — core. Not configurable.
            </p>

            {(() => {
              const display = describeCompanyAppSettings(contract?.appConfiguration);
              const tone = display.tone === 'danger'
                ? 'bg-red-900/40 text-red-200 border-red-700'
                : display.tone === 'info'
                  ? 'bg-blue-900/40 text-blue-200 border-blue-700'
                  : 'bg-gray-600/40 text-gray-300 border-gray-500';
              return (
                <p className={`text-[11px] mb-2 inline-block px-1.5 py-0.5 rounded border ${tone}`}>
                  {display.label}
                  {display.kind === 'invalid' && <span className="ml-1 opacity-80">({display.reason})</span>}
                </p>
              );
            })()}

            {appDraft.state === 'invalid' && (
              <p role="alert" className="text-red-300 text-xs bg-red-900/30 border border-red-700 rounded p-2 mb-2">
                This company&rsquo;s stored app settings are invalid ({appDraft.invalidReason}).
                Nothing will be saved until you deliberately reconfigure them.
              </p>
            )}

            <ul className="space-y-1 mb-2">
              {appDraft.rows.map((row) => (
                <li key={row.app} className="flex flex-wrap items-center gap-3 text-xs">
                  <span className="text-gray-200 min-w-[11rem]">{WELLBUILT_APP_PRODUCT_NAMES[row.app]}</span>
                  {row.plan.kind !== 'included' ? (
                    <span className="text-gray-500">
                      {row.plan.kind === 'excluded' ? 'Not included in plan'
                        : row.plan.kind === 'legacy' ? 'Plan does not configure app access (legacy)'
                        : `Invalid plan entitlement (${row.plan.reason})`}
                    </span>
                  ) : appDraft.state !== 'configured' ? (
                    <span className="text-gray-400">
                      Included by plan
                      {row.planMandatesShift && ' · plan mandates active shift'}
                    </span>
                  ) : (
                    <>
                      <label className="flex items-center gap-1 text-gray-300">
                        <input
                          type="checkbox"
                          checked={row.enabled}
                          disabled={busy}
                          onChange={(e) => setAppDraft((d) => setCompanyAppEnabled(d, row.app, e.target.checked))}
                        />
                        enabled for this company
                      </label>
                      {row.planMandatesShift ? (
                        // Inherited from the plan and NOT removable here: a
                        // company may add a restriction, never relax one.
                        <span className="text-amber-300" title="Set by the plan for every assigned company">
                          active shift required by plan (inherited)
                        </span>
                      ) : (
                        <label className={`flex items-center gap-1 ${row.enabled ? 'text-gray-300' : 'text-gray-600'}`}>
                          <input
                            type="checkbox"
                            checked={row.companyRequiresShift}
                            disabled={!row.enabled || busy}
                            onChange={(e) => setAppDraft((d) => setCompanyAppRequiresShift(d, row.app, e.target.checked))}
                          />
                          require active shift for this company
                        </label>
                      )}
                    </>
                  )}
                </li>
              ))}
            </ul>

            {appDraft.state !== 'configured' ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => setAppDraft((d) => beginConfiguringCompany(d))}
                className="px-2 py-1 rounded bg-blue-700 hover:bg-blue-600 text-white text-xs disabled:opacity-50">
                Configure company app settings
              </button>
            ) : (
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy || !canSaveCompanyAppSettings(appDraft)}
                  onClick={() => {
                    const check = validateCompanyDraft(appDraft);
                    if (!check.ok) { setNotice(`App settings cannot be saved: ${check.reason}.`); return; }
                    const appConfiguration = companyAppConfigurationPayload(appDraft);
                    // null means "nothing to write" — the section was never
                    // deliberately configured, so no callable is invoked.
                    if (appConfiguration === null) return;
                    void run('Company app settings saved.', () =>
                      service.setCompanyAppConfiguration({ companyId, appConfiguration }));
                  }}
                  className="px-2 py-1 rounded bg-green-700 hover:bg-green-600 text-white text-xs disabled:opacity-50">
                  Save app settings
                </button>
                <button
                  type="button"
                  disabled={busy}
                  // Cancel returns to the AUTHORITATIVE stored state — it
                  // never writes, and never leaves a half-made map behind.
                  onClick={() => setAppDraft(draftFromContract(assignedPlan, contract?.appConfiguration))}
                  className="px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs disabled:opacity-50">
                  Cancel
                </button>
              </div>
            )}
            <p className="text-gray-500 text-[11px] mt-1">
              Saving with nothing restricted is a deliberate &ldquo;no company-specific
              restrictions&rdquo; setting. There is no way to return to the
              never-configured state from here.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
