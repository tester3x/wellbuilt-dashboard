'use client';

/**
 * vc51.9A7 — Work Period settings card (deliberately separate from
 * JsaCard). Displays the company's work-period policy from the
 * WellBuilt contract and — for verified WellBuilt Admins only — edits
 * it through the protected callable service. Company admins see
 * read-only until a separately verified customer-admin authority
 * exists. No firebase/firestore import; nothing here writes directly.
 *
 * The derived-schedule example comes from the canonical
 * @tester3x/wellbuilt-contracts resolver (via adminUiLogic), so the preview can
 * never disagree with what the apps will compute — including DST edges.
 */

import { useCallback, useEffect, useState } from 'react';
import type { CompanyConfig } from '@/lib/companySettings';
import {
  createAdminContractService,
  AdminServiceError,
  type CompanyContractStateLabel,
  type StoredWorkPeriodConfiguration,
  type WellbuiltContract,
} from '@/lib/adminContractService';
import {
  EXPLICIT_MODE_ACTIONS,
  LOGIN_VS_SHIFT_COPY,
  derivedScheduleExample,
  errorGuidance,
  isOvernight,
} from '@/lib/adminUiLogic';
import { useVerifiedAdmin } from '@/lib/useVerifiedAdmin';

const service = createAdminContractService();

interface Props { company: CompanyConfig; onSave?: () => void }

export function WorkPeriodCard({ company, onSave }: Props) {
  const { session } = useVerifiedAdmin();
  const canEdit = session.status === 'verified';
  const [state, setState] = useState<CompanyContractStateLabel | null>(null);
  const [contract, setContract] = useState<WellbuiltContract | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editMode, setEditMode] = useState<'explicit_shift' | 'company_defined_period'>('explicit_shift');
  const [tz, setTz] = useState('America/Chicago');
  const [start, setStart] = useState('06:00');
  const [duration, setDuration] = useState('720');

  const reload = useCallback(async () => {
    if (!canEdit) return; // configuration is read through the admin callable
    try {
      const cfg = await service.getCompanyContractConfiguration({ companyId: company.id });
      setState(cfg.state);
      setContract(cfg.contract ?? null);
      const wpc = cfg.contract?.workPeriodConfiguration;
      if (wpc) {
        setEditMode(wpc.mode);
        if (wpc.timezone) setTz(wpc.timezone);
        if (wpc.startLocalTime) setStart(wpc.startLocalTime);
        if (wpc.durationMinutes) setDuration(String(wpc.durationMinutes));
      }
    } catch (err) {
      setNotice(errorGuidance(err instanceof AdminServiceError ? err : { kind: 'unknown' }).message);
    }
  }, [company.id, canEdit]);

  useEffect(() => { void reload(); }, [reload]);

  const wpc = contract?.workPeriodConfiguration ?? null;
  const mode = wpc?.mode ?? null;
  const draft: StoredWorkPeriodConfiguration = editMode === 'explicit_shift'
    ? { mode: 'explicit_shift', timezone: tz }
    : { mode: 'company_defined_period', timezone: tz, startLocalTime: start, durationMinutes: Number(duration) };
  const example = editMode === 'company_defined_period'
    ? derivedScheduleExample(draft, Date.now())
    : null;
  const draftValid = editMode === 'explicit_shift' || (example !== null && example.ok);
  const complete = mode === 'explicit_shift'
    || (mode === 'company_defined_period' && !!wpc?.timezone && !!wpc?.startLocalTime && typeof wpc?.durationMinutes === 'number');

  return (
    <div className="bg-gray-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-purple-400 font-medium">Work Period</h3>
        {contract && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${contract.contractEnforced ? 'bg-green-800 text-green-200' : 'bg-gray-700 text-gray-300'}`}>
            {contract.contractEnforced ? 'contract enforced' : 'configured — not enforced'}
          </span>
        )}
      </div>
      <p className="text-gray-300 text-sm mb-2">{LOGIN_VS_SHIFT_COPY}</p>
      <p className="text-gray-400 text-xs mb-3">
        Suite login: required for everyone. Work periods bind only the operational workflows listed below.
      </p>

      {!canEdit && (
        <p className="text-gray-400 text-xs bg-gray-900 rounded p-2">
          Read-only: work-period policy is managed by WellBuilt Admin until verified customer-admin authority exists.
          {state === null && ' Sign in as a verified WellBuilt Admin to view the configured policy.'}
        </p>
      )}

      {canEdit && state === 'legacy' && (
        <p className="text-gray-400 text-xs">No WellBuilt contract yet — assign a plan in Admin → Companies before configuring a work period.</p>
      )}
      {canEdit && state === 'invalid' && (
        <p className="text-red-300 text-xs">Stored contract is invalid/upgrade-required — resolve in Admin → Companies first.</p>
      )}

      {canEdit && (state === 'inert' || state === 'active') && (
        <div className="space-y-3">
          <div className="text-sm text-gray-300">
            Mode: <span className="text-white">{mode === 'company_defined_period' ? 'Company-defined period' : mode === 'explicit_shift' ? 'Explicit shift (WB-S Start Shift)' : 'not configured'}</span>
            {' · '}Timezone: <span className="text-white">{wpc?.timezone ?? 'America/Chicago'}</span>
            {' · '}Configuration: <span className={complete ? 'text-green-300' : 'text-amber-300'}>{complete ? 'complete' : 'incomplete'}</span>
          </div>

          {mode === 'explicit_shift' && (
            <div className="text-xs text-gray-400 space-y-1">
              <p>Applicable operational work requires a shift STARTED in WB-S. No derived schedule exists in this mode.</p>
              <ul className="space-y-0.5">
                {EXPLICIT_MODE_ACTIONS.map((a) => (
                  <li key={a.action}><span className="text-gray-300">{a.action}:</span> {a.requirement}</li>
                ))}
              </ul>
            </div>
          )}

          {notice && <div role="status" className="text-amber-300 text-xs bg-amber-900/30 border border-amber-700 rounded p-2">{notice}</div>}

          <fieldset className="border border-gray-700 rounded p-2 space-y-2">
            <legend className="text-gray-300 text-xs px-1">Edit configuration (WellBuilt Admin)</legend>
            <div role="radiogroup" aria-label="Work period mode" className="flex flex-wrap gap-3 text-sm text-gray-200">
              <label className="flex items-center gap-1.5">
                <input type="radio" name={`wp-mode-${company.id}`} checked={editMode === 'explicit_shift'} onChange={() => setEditMode('explicit_shift')} />
                Explicit shift
              </label>
              <label className="flex items-center gap-1.5">
                <input type="radio" name={`wp-mode-${company.id}`} checked={editMode === 'company_defined_period'} onChange={() => setEditMode('company_defined_period')} />
                Company-defined period
              </label>
            </div>
            <div className="flex flex-wrap gap-2">
              <div>
                <label htmlFor={`wp-tz-${company.id}`} className="block text-gray-400 text-[10px]">IANA timezone</label>
                <input id={`wp-tz-${company.id}`} value={tz} onChange={(e) => setTz(e.target.value)}
                  className="bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs w-44" />
              </div>
              {editMode === 'company_defined_period' && (
                <>
                  <div>
                    <label htmlFor={`wp-start-${company.id}`} className="block text-gray-400 text-[10px]">Local start (HH:MM)</label>
                    <input id={`wp-start-${company.id}`} value={start} onChange={(e) => setStart(e.target.value)}
                      className="bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs w-24" />
                  </div>
                  <div>
                    <label htmlFor={`wp-dur-${company.id}`} className="block text-gray-400 text-[10px]">Duration (minutes)</label>
                    <input id={`wp-dur-${company.id}`} type="number" min={1} max={1440} value={duration} onChange={(e) => setDuration(e.target.value)}
                      className="bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs w-24" />
                  </div>
                </>
              )}
            </div>

            {editMode === 'company_defined_period' && example && (
              example.ok ? (
                <div className="text-xs text-gray-400 space-y-0.5">
                  {isOvernight(draft) && <p className="text-amber-300">Overnight schedule: each period crosses local midnight into the next day.</p>}
                  <p>Current period: {example.current ? `${new Date(example.current.startIso).toLocaleString()} → ${new Date(example.current.endIso).toLocaleString()}` : 'none right now (between periods)'}</p>
                  <p>Next period: {example.next ? `${new Date(example.next.startIso).toLocaleString()} → ${new Date(example.next.endIso).toLocaleString()}` : '—'}</p>
                  <p>Boundaries are computed in {tz} by the shared suite resolver — daylight-saving transitions shift the wall-clock boundary, never the local start time.</p>
                </div>
              ) : (
                <p className="text-red-300 text-xs">Invalid schedule: {example.reason}. Fix it to enable saving.</p>
              )
            )}

            <button
              disabled={busy || !draftValid}
              onClick={async () => {
                if (busy) return;
                setBusy(true);
                try {
                  await service.setCompanyWorkPeriodConfiguration({ companyId: company.id, configuration: draft });
                  setNotice('Work-period configuration saved (contract remains as-is; enforcement is separate).');
                  await reload();
                  onSave?.();
                } catch (err) {
                  setNotice(errorGuidance(err instanceof AdminServiceError ? err : { kind: 'unknown' }).message);
                } finally {
                  setBusy(false);
                }
              }}
              className="px-3 py-1.5 rounded bg-green-700 hover:bg-green-600 text-white text-xs disabled:opacity-50"
              title={draftValid ? undefined : 'Invalid schedules cannot be submitted'}>
              {busy ? 'Saving…' : 'Save configuration'}
            </button>
          </fieldset>
        </div>
      )}
    </div>
  );
}
