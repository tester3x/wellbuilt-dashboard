'use client';

import { useState } from 'react';
import {
  type CompanyConfig,
  type RateEntry,
  updateCompanyFields,
  JOB_TYPES,
  BILLING_METHODS,
} from '@/lib/companySettings';

interface Props {
  company: CompanyConfig;
  onSave: () => void;
}

export function RateSheetsCard({ company, onSave }: Props) {
  // Modal state
  const [editOperator, setEditOperator] = useState<string | null>(null);
  const [entries, setEntries] = useState<RateEntry[]>([]);
  const [saving, setSaving] = useState(false);

  const operators = company.assignedOperators || [];
  // Counties that have frost zones configured — "All Counties" first
  const frostCounties = Object.keys(company.payConfig?.frostZones || {})
    .sort((a, b) => a === 'All Counties' ? -1 : b === 'All Counties' ? 1 : a.localeCompare(b));

  const openRateSheet = (operator: string) => {
    const existing = company.rateSheets?.[operator] || [];
    setEntries(existing.length > 0 ? [...existing] : [
      { jobType: 'Production %', method: 'per_bbl', rate: 0 },
    ]);
    setEditOperator(operator);
  };

  const addEntry = () => {
    setEntries(prev => [...prev, { jobType: '', method: 'per_bbl', rate: 0 }]);
  };

  const removeEntry = (idx: number) => {
    setEntries(prev => prev.filter((_, i) => i !== idx));
  };

  const updateEntry = (idx: number, field: keyof RateEntry, value: any) => {
    setEntries(prev => prev.map((entry, i) =>
      i === idx ? { ...entry, [field]: value } : entry
    ));
  };

  const updateFrostRate = (idx: number, county: string, value: number) => {
    setEntries(prev => prev.map((entry, i) => {
      if (i !== idx) return entry;
      const frostRates = { ...(entry.frostRates || {}) };
      if (value > 0) {
        frostRates[county] = value;
      } else {
        delete frostRates[county];
      }
      return { ...entry, frostRates };
    }));
  };

  const save = async () => {
    if (!editOperator) return;
    setSaving(true);
    try {
      const validEntries = entries.filter(e => e.jobType && e.rate > 0);
      const updatedSheets = { ...(company.rateSheets || {}) };
      if (validEntries.length > 0) {
        updatedSheets[editOperator] = validEntries;
      } else {
        delete updatedSheets[editOperator];
      }
      await updateCompanyFields(company.id, { rateSheets: updatedSheets });
      setEditOperator(null);
      onSave();
    } catch (err) {
      console.error('Failed to save rate sheet:', err);
    } finally {
      setSaving(false);
    }
  };

  /** Format frost rate display for summary */
  const formatFrostRates = (r: RateEntry): string => {
    if (r.method !== 'per_bbl') return '';
    if (r.frostRates && Object.keys(r.frostRates).length > 0) {
      const sorted = Object.entries(r.frostRates)
        .sort(([a], [b]) => a === 'All Counties' ? -1 : b === 'All Counties' ? 1 : a.localeCompare(b));
      return ' (' + sorted.map(([c, v]) => `❄${c}: $${v}`).join(', ') + ')';
    }
    if (r.frostRate) return ` (❄$${r.frostRate})`;
    return '';
  };

  if (operators.length === 0) return null;

  return (
    <>
      <div className="bg-gray-800 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-green-500/30 bg-green-900/20">
          <h3 className="text-green-400 font-medium text-sm">Rate Sheets</h3>
        </div>

        <div className="p-4 space-y-1">
          {operators.map(op => {
            const rates = company.rateSheets?.[op];
            const hasRates = rates && rates.length > 0;
            return (
              <div
                key={op}
                className="flex items-center justify-between px-3 py-2 bg-gray-700/30 rounded text-sm"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-gray-300 truncate">{op}</span>
                  {hasRates ? (
                    <span className="text-green-400 text-xs truncate">
                      {rates!.length} rate{rates!.length !== 1 ? 's' : ''}
                      {' · '}
                      {rates!.map(r => `${r.jobType}: $${r.rate}${r.method === 'per_bbl' ? '/bbl' : '/hr'}${formatFrostRates(r)}`).join(', ')}
                    </span>
                  ) : (
                    <span className="text-gray-500 text-xs">No rates set</span>
                  )}
                </div>
                <button
                  onClick={() => openRateSheet(op)}
                  className="px-2 py-0.5 text-xs rounded bg-green-700 hover:bg-green-600 text-white shrink-0 ml-2"
                >
                  {hasRates ? 'Edit' : '+ Set Rates'}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Rate Sheet Modal */}
      {editOperator && (
        <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-2xl w-full mx-4">
            <h3 className="text-white font-medium mb-1">Rate Sheet</h3>
            <p className="text-gray-400 text-xs mb-4">
              {company.name} → {editOperator}
            </p>

            <div className="space-y-3 mb-4 max-h-96 overflow-y-auto">
              {entries.map((entry, idx) => (
                <div key={idx} className="bg-gray-700/30 rounded p-2">
                  <div className="flex items-center gap-2">
                    <select
                      value={entry.jobType}
                      onChange={e => updateEntry(idx, 'jobType', e.target.value)}
                      className="flex-1 px-2 py-1.5 bg-gray-700 text-white rounded text-sm"
                    >
                      <option value="">Select job type...</option>
                      {JOB_TYPES.map(jt => (
                        <option key={jt} value={jt}>{jt}</option>
                      ))}
                    </select>

                    <select
                      value={entry.method}
                      onChange={e => updateEntry(idx, 'method', e.target.value)}
                      className="w-24 px-2 py-1.5 bg-gray-700 text-white rounded text-sm"
                    >
                      {BILLING_METHODS.map(bm => (
                        <option key={bm.value} value={bm.value}>{bm.label}</option>
                      ))}
                    </select>

                    <div className="relative w-28">
                      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={entry.rate || ''}
                        onChange={e => updateEntry(idx, 'rate', parseFloat(e.target.value) || 0)}
                        className="w-full pl-6 pr-2 py-1.5 bg-gray-700 text-white rounded text-sm"
                        placeholder="0.00"
                      />
                    </div>

                    <button
                      onClick={() => removeEntry(idx)}
                      className="text-red-400 hover:text-red-300 text-sm px-1"
                      title="Remove"
                    >
                      ✕
                    </button>
                  </div>

                  {/* Per-county frost rates — only for per_bbl entries when frost zones exist */}
                  {entry.method === 'per_bbl' && frostCounties.length > 0 && (
                    <div className="flex items-center gap-3 mt-2 pl-1 flex-wrap">
                      <span className="text-blue-300 text-xs">❄ Frost:</span>
                      {frostCounties.map(county => (
                        <div key={county} className="flex items-center gap-1">
                          <span className="text-blue-300/70 text-xs">{county}</span>
                          <div className="relative w-20">
                            <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-blue-300 text-xs">$</span>
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              value={entry.frostRates?.[county] || ''}
                              onChange={e => updateFrostRate(idx, county, parseFloat(e.target.value) || 0)}
                              className="w-full pl-5 pr-1 py-1 bg-gray-700 text-blue-300 rounded text-xs"
                              placeholder="—"
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <button
              onClick={addEntry}
              className="text-green-400 hover:text-green-300 text-xs mb-4"
            >
              + Add Rate
            </button>

            {frostCounties.length === 0 && entries.some(e => e.method === 'per_bbl') && (
              <p className="text-gray-500 text-xs mb-3">
                Set up frost zones in Payroll Config to add per-county frost rates.
              </p>
            )}

            <div className="flex gap-2">
              <button
                onClick={save}
                disabled={saving}
                className="flex-1 px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save Rates'}
              </button>
              <button
                onClick={() => setEditOperator(null)}
                className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
