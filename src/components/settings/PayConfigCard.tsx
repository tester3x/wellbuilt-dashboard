'use client';

import { useState } from 'react';
import { type CompanyConfig, type PayConfig, updateCompanyFields } from '@/lib/companySettings';

interface Props {
  company: CompanyConfig;
  onSave: () => void;
}

export function PayConfigCard({ company, onSave }: Props) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  const [split, setSplit] = useState('25');
  const [rounding, setRounding] = useState<PayConfig['payrollRounding']>('match_billing');
  const [period, setPeriod] = useState<PayConfig['payPeriod']>('weekly');
  const [autoApprove, setAutoApprove] = useState('48');

  const startEdit = () => {
    const cfg = company.payConfig;
    setSplit(cfg?.defaultSplit ? String(Math.round(cfg.defaultSplit * 100)) : '25');
    setRounding(cfg?.payrollRounding || 'match_billing');
    setPeriod(cfg?.payPeriod || 'weekly');
    setAutoApprove(cfg?.autoApproveHours != null ? String(cfg.autoApproveHours) : '48');
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const config: PayConfig = {
        defaultSplit: Number(split) / 100,
        payrollRounding: rounding,
        payPeriod: period,
        autoApproveHours: Number(autoApprove) || 48,
      };
      await updateCompanyFields(company.id, { payConfig: config });
      setEditing(false);
      onSave();
    } catch (err) {
      console.error('Failed to save pay config:', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-gray-800 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-cyan-500/30 bg-cyan-900/20">
        <h3 className="text-cyan-400 font-medium text-sm">Payroll Config</h3>
        {!editing && (
          <button
            onClick={startEdit}
            className="px-3 py-1 text-xs rounded bg-cyan-700 hover:bg-cyan-600 text-white"
          >
            {company.payConfig ? 'Edit' : '+ Set Up'}
          </button>
        )}
      </div>

      <div className="p-4">
        {editing ? (
          <div className="space-y-4">
            {/* Employee Split */}
            <div>
              <label className="block text-gray-400 text-xs mb-1">Employee Split (%)</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={split}
                  onChange={e => setSplit(e.target.value)}
                  className="w-24 px-3 py-2 bg-gray-700 text-white rounded text-sm"
                />
                <span className="text-gray-400 text-sm">%</span>
                <span className="text-gray-500 text-xs ml-2">
                  (driver gets {split}% of amount billed)
                </span>
              </div>
            </div>

            {/* Pay Period */}
            <div>
              <label className="block text-gray-400 text-xs mb-1">Pay Period</label>
              <select
                value={period}
                onChange={e => setPeriod(e.target.value as PayConfig['payPeriod'])}
                className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm"
              >
                <option value="weekly">Weekly</option>
                <option value="biweekly">Bi-Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </div>

            {/* Payroll Rounding */}
            <div>
              <label className="block text-gray-400 text-xs mb-1">Payroll Time Rounding</label>
              <select
                value={rounding}
                onChange={e => setRounding(e.target.value as PayConfig['payrollRounding'])}
                className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm"
              >
                <option value="match_billing">Match billing rounding (per operator)</option>
                <option value="none">No rounding (to the minute)</option>
                <option value="quarter_hour">Quarter hour</option>
                <option value="half_hour">Half hour</option>
              </select>
              {rounding === 'match_billing' && (
                <p className="text-gray-500 text-xs mt-1">
                  Payroll hours will match whatever rounding each oil company uses for billing.
                </p>
              )}
            </div>

            {/* Auto-Approve */}
            <div>
              <label className="block text-gray-400 text-xs mb-1">Auto-Approve Deadline (hours)</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="0"
                  value={autoApprove}
                  onChange={e => setAutoApprove(e.target.value)}
                  className="w-24 px-3 py-2 bg-gray-700 text-white rounded text-sm"
                />
                <span className="text-gray-400 text-sm">hours</span>
              </div>
              <p className="text-gray-500 text-xs mt-1">
                If driver doesn&apos;t respond within this time, timesheet is auto-approved. Set 0 to disable.
              </p>
            </div>

            <div className="flex gap-2 pt-1">
              <button
                onClick={save}
                disabled={saving}
                className="px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded text-sm disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
              <button
                onClick={() => setEditing(false)}
                className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : company.payConfig ? (
          <div className="flex flex-wrap gap-3 text-xs">
            <span className="text-gray-400">
              Split: <span className="text-cyan-300">{Math.round(company.payConfig.defaultSplit * 100)}%</span>
            </span>
            <span className="text-gray-400">
              Period: <span className="text-cyan-300">{company.payConfig.payPeriod}</span>
            </span>
            <span className="text-gray-400">
              Rounding: <span className="text-cyan-300">
                {company.payConfig.payrollRounding === 'match_billing' ? 'Match billing' : company.payConfig.payrollRounding}
              </span>
            </span>
            <span className="text-gray-400">
              Auto-approve: <span className="text-cyan-300">{company.payConfig.autoApproveHours || 48}h</span>
            </span>
          </div>
        ) : (
          <div className="text-gray-500 text-xs py-1">
            Not configured yet. Set up employee split, pay period, and rounding.
          </div>
        )}
      </div>
    </div>
  );
}
