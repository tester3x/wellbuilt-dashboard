'use client';

import { useState } from 'react';
import { type CompanyConfig, type PayConfig, type FrostZone, BAKKEN_COUNTIES, updateCompanyFields } from '@/lib/companySettings';

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
  const [frostZones, setFrostZones] = useState<Record<string, FrostZone>>({});
  const [addingCounty, setAddingCounty] = useState(false);
  const [newCounty, setNewCounty] = useState('');

  const startEdit = () => {
    const cfg = company.payConfig;
    setSplit(cfg?.defaultSplit ? String(Math.round(cfg.defaultSplit * 100)) : '25');
    setRounding(cfg?.payrollRounding || 'match_billing');
    setPeriod(cfg?.payPeriod || 'weekly');
    setAutoApprove(cfg?.autoApproveHours != null ? String(cfg.autoApproveHours) : '48');
    // Load frost zones, falling back to legacy single frost season
    if (cfg?.frostZones && Object.keys(cfg.frostZones).length > 0) {
      setFrostZones({ ...cfg.frostZones });
    } else if (cfg?.frostSeason?.startDate) {
      // Migrate legacy single frost season as "All Counties"
      setFrostZones({ 'All Counties': { startDate: cfg.frostSeason.startDate, endDate: cfg.frostSeason.endDate || '' } });
    } else {
      setFrostZones({});
    }
    setAddingCounty(false);
    setNewCounty('');
    setEditing(true);
  };

  const addCounty = (county: string) => {
    if (!county || frostZones[county]) return;
    setFrostZones(prev => ({ ...prev, [county]: { startDate: '', endDate: '', maxBbls: undefined } }));
    setAddingCounty(false);
    setNewCounty('');
  };

  const removeCounty = (county: string) => {
    setFrostZones(prev => {
      const next = { ...prev };
      delete next[county];
      return next;
    });
  };

  const updateZone = (county: string, field: keyof FrostZone, value: any) => {
    setFrostZones(prev => ({
      ...prev,
      [county]: { ...prev[county], [field]: value },
    }));
  };

  const save = async () => {
    setSaving(true);
    try {
      // Clean up zones: only keep ones with a start date
      const validZones: Record<string, FrostZone> = {};
      for (const [county, zone] of Object.entries(frostZones)) {
        if (zone.startDate) {
          validZones[county] = zone;
        }
      }
      const config: PayConfig = {
        defaultSplit: Number(split) / 100,
        payrollRounding: rounding,
        payPeriod: period,
        autoApproveHours: Number(autoApprove) || 48,
        frostZones: Object.keys(validZones).length > 0 ? validZones : undefined,
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

  // Counties already added (for filtering suggestions)
  const usedCounties = new Set(Object.keys(frostZones));
  const availableCounties = BAKKEN_COUNTIES.filter(c => !usedCounties.has(c));

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

            {/* Frost Zones by County */}
            <div>
              <label className="block text-blue-300 text-xs mb-1">❄ Frost Seasons (by County)</label>
              <p className="text-gray-500 text-xs mb-2">
                Each county has its own frost law dates and weight limits. Per-BBL rates switch to frost rates during active frost season.
              </p>

              {Object.keys(frostZones).length > 0 && (
                <div className="space-y-2 mb-3">
                  {Object.entries(frostZones).sort(([a], [b]) => a === 'All Counties' ? -1 : b === 'All Counties' ? 1 : a.localeCompare(b)).map(([county, zone]) => (
                    <div key={county} className="bg-gray-700/50 rounded p-2">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-blue-300 text-xs font-medium">{county}</span>
                        <button
                          onClick={() => removeCounty(county)}
                          className="text-red-400 hover:text-red-300 text-xs px-1"
                          title="Remove county"
                        >
                          ✕
                        </button>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <input
                          type="date"
                          value={zone.startDate}
                          onChange={e => updateZone(county, 'startDate', e.target.value)}
                          className="px-2 py-1 bg-gray-700 text-white rounded text-xs"
                        />
                        <span className="text-gray-400 text-xs">→</span>
                        <input
                          type="date"
                          value={zone.endDate}
                          onChange={e => updateZone(county, 'endDate', e.target.value)}
                          className="px-2 py-1 bg-gray-700 text-white rounded text-xs"
                          placeholder="Open-ended"
                        />
                        <div className="flex items-center gap-1 ml-2">
                          <input
                            type="number"
                            min="0"
                            value={zone.maxBbls || ''}
                            onChange={e => updateZone(county, 'maxBbls', e.target.value ? Number(e.target.value) : undefined)}
                            className="w-16 px-2 py-1 bg-gray-700 text-white rounded text-xs"
                            placeholder="—"
                          />
                          <span className="text-gray-500 text-xs">BBL max</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {addingCounty ? (
                <div className="flex items-center gap-2">
                  <select
                    value={newCounty}
                    onChange={e => setNewCounty(e.target.value)}
                    className="flex-1 px-2 py-1.5 bg-gray-700 text-white rounded text-xs"
                  >
                    <option value="">Select county...</option>
                    {availableCounties.map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={newCounty}
                    onChange={e => setNewCounty(e.target.value)}
                    placeholder="Or type name..."
                    className="flex-1 px-2 py-1.5 bg-gray-700 text-white rounded text-xs"
                  />
                  <button
                    onClick={() => addCounty(newCounty)}
                    disabled={!newCounty}
                    className="px-2 py-1.5 text-xs rounded bg-blue-700 hover:bg-blue-600 text-white disabled:opacity-30"
                  >
                    Add
                  </button>
                  <button
                    onClick={() => { setAddingCounty(false); setNewCounty(''); }}
                    className="text-gray-400 hover:text-gray-300 text-xs"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setAddingCounty(true)}
                  className="text-blue-400 hover:text-blue-300 text-xs"
                >
                  + Add County
                </button>
              )}
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
          <div className="space-y-2">
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
            {/* Frost zones display */}
            {company.payConfig.frostZones && Object.keys(company.payConfig.frostZones).length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {Object.entries(company.payConfig.frostZones).sort(([a], [b]) => a === 'All Counties' ? -1 : b === 'All Counties' ? 1 : a.localeCompare(b)).map(([county, zone]) => (
                  <span key={county} className="text-blue-300 text-xs bg-blue-900/30 px-2 py-0.5 rounded">
                    ❄ {county}: {zone.startDate}{zone.endDate ? ` → ${zone.endDate}` : ' (active)'}
                    {zone.maxBbls ? ` · ${zone.maxBbls} BBL` : ''}
                  </span>
                ))}
              </div>
            ) : company.payConfig.frostSeason?.startDate ? (
              <span className="text-blue-300 text-xs">
                ❄ {company.payConfig.frostSeason.startDate}{company.payConfig.frostSeason.endDate ? ` → ${company.payConfig.frostSeason.endDate}` : ' (active)'}
              </span>
            ) : null}
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
