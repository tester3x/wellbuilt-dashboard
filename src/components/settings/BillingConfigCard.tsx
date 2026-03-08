'use client';

import { useState } from 'react';
import {
  type CompanyConfig,
  type OperatorBillingConfig,
  type FuelSurchargeMethod,
  type PaymentTerms,
  updateCompanyFields,
  PAYMENT_TERMS_OPTIONS,
  FUEL_SURCHARGE_METHODS,
} from '@/lib/companySettings';

interface Props {
  company: CompanyConfig;
  onSave: () => void;
}

const DEFAULT_CONFIG: OperatorBillingConfig = {
  paymentTerms: 'net_30',
  fuelSurchargeMethod: 'none',
};

export function BillingConfigCard({ company, onSave }: Props) {
  const [editOperator, setEditOperator] = useState<string | null>(null);
  const [config, setConfig] = useState<OperatorBillingConfig>(DEFAULT_CONFIG);
  const [saving, setSaving] = useState(false);

  const operators = company.assignedOperators || [];

  const openConfig = (operator: string) => {
    const existing = company.billingConfig?.[operator];
    setConfig(existing ? { ...existing } : { ...DEFAULT_CONFIG });
    setEditOperator(operator);
  };

  const save = async () => {
    if (!editOperator) return;
    setSaving(true);
    try {
      const updatedConfig = { ...(company.billingConfig || {}) };
      updatedConfig[editOperator] = config;
      await updateCompanyFields(company.id, { billingConfig: updatedConfig });
      setEditOperator(null);
      onSave();
    } catch (err) {
      console.error('Failed to save billing config:', err);
    } finally {
      setSaving(false);
    }
  };

  if (operators.length === 0) return null;

  const fscMethodLabel = (method: FuelSurchargeMethod) =>
    FUEL_SURCHARGE_METHODS.find(m => m.value === method)?.label || 'None';

  const termsLabel = (terms: PaymentTerms) =>
    PAYMENT_TERMS_OPTIONS.find(t => t.value === terms)?.label || 'Net 30';

  return (
    <>
      <div className="bg-gray-800 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-blue-500/30 bg-blue-900/20">
          <h3 className="text-blue-400 font-medium text-sm">Billing Config</h3>
        </div>

        <div className="p-4 space-y-1">
          {operators.map(op => {
            const cfg = company.billingConfig?.[op];
            return (
              <div
                key={op}
                className="flex items-center justify-between px-3 py-2 bg-gray-700/30 rounded text-sm"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-gray-300 truncate">{op}</span>
                  {cfg ? (
                    <span className="text-blue-400 text-xs truncate">
                      {termsLabel(cfg.paymentTerms)} · FSC: {fscMethodLabel(cfg.fuelSurchargeMethod)}
                      {cfg.fuelSurchargeMethod === 'hourly' ? ` (base $${cfg.fuelSurchargeBaseline || 0}/gal, ${cfg.fuelSurchargeMPG || 6} MPG, ${cfg.fuelSurchargeSpeed || 30} MPH)` : ''}
                      {cfg.fuelSurchargeMethod === 'flat' && cfg.fuelSurchargeRate ? ` ($${cfg.fuelSurchargeRate}/load)` : ''}
                      {cfg.fuelSurchargeMethod === 'percentage' && cfg.fuelSurchargePercent ? ` (${(cfg.fuelSurchargePercent * 100).toFixed(1)}%)` : ''}
                      {cfg.fuelSurchargeMethod === 'per_mile' ? ` (base $${cfg.fuelSurchargeBaseline || 0}/gal, ${cfg.fuelSurchargeMPG || 6} MPG)` : ''}
                      {cfg.fuelSurchargeMethod === 'flat_doe' ? ` (×${cfg.fuelSurchargeMultiplier || 8}, base $${cfg.fuelSurchargeBaseline || 3.25})` : ''}
                      {cfg.detentionEnabled ? ` · Detention: $${cfg.detentionHourlyRate || '(hourly rate)'}/hr after ${cfg.detentionThresholdMinutes || 60}min` : ''}
                    </span>
                  ) : (
                    <span className="text-gray-500 text-xs">Not configured</span>
                  )}
                </div>
                <button
                  onClick={() => openConfig(op)}
                  className="px-2 py-0.5 text-xs rounded bg-blue-700 hover:bg-blue-600 text-white shrink-0 ml-2"
                >
                  {cfg ? 'Edit' : '+ Configure'}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Config Modal */}
      {editOperator && (
        <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-white font-medium mb-1">Billing Configuration</h3>
            <p className="text-gray-400 text-xs mb-4">
              {company.name} → {editOperator}
            </p>

            <div className="space-y-4 mb-6">
              {/* Payment Terms */}
              <div>
                <label className="block text-gray-400 text-xs mb-1">Payment Terms</label>
                <select
                  value={config.paymentTerms}
                  onChange={e => setConfig({ ...config, paymentTerms: e.target.value as PaymentTerms })}
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm focus:outline-none focus:border-blue-500 border border-gray-600"
                >
                  {PAYMENT_TERMS_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>

              {/* Fuel Surcharge Method */}
              <div>
                <label className="block text-gray-400 text-xs mb-1">Fuel Surcharge Method</label>
                <select
                  value={config.fuelSurchargeMethod}
                  onChange={e => setConfig({ ...config, fuelSurchargeMethod: e.target.value as FuelSurchargeMethod })}
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm focus:outline-none focus:border-blue-500 border border-gray-600"
                >
                  {FUEL_SURCHARGE_METHODS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>

              {/* Dynamic fields based on method */}
              {(config.fuelSurchargeMethod === 'hourly' || config.fuelSurchargeMethod === 'per_mile') && (
                <>
                  <div>
                    <label className="block text-gray-400 text-xs mb-1">Baseline Diesel Price ($/gal)</label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={config.fuelSurchargeBaseline ?? 0}
                        onChange={e => setConfig({ ...config, fuelSurchargeBaseline: parseFloat(e.target.value) || 0 })}
                        className="w-full pl-7 pr-3 py-2 bg-gray-700 text-white rounded text-sm border border-gray-600 focus:outline-none focus:border-blue-500"
                        placeholder="2.50"
                      />
                    </div>
                    <p className="text-gray-500 text-xs mt-1">Surcharge kicks in when diesel exceeds this price (empty = 0)</p>
                  </div>
                  <div>
                    <label className="block text-gray-400 text-xs mb-1">Truck MPG (loaded)</label>
                    <input
                      type="number"
                      step="0.1"
                      min="1"
                      value={config.fuelSurchargeMPG ?? 0}
                      onChange={e => setConfig({ ...config, fuelSurchargeMPG: parseFloat(e.target.value) || 0 })}
                      className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm border border-gray-600 focus:outline-none focus:border-blue-500"
                      placeholder="6"
                    />
                    <p className="text-gray-500 text-xs mt-1">Water haulers typically 5-6 MPG loaded</p>
                  </div>
                  {config.fuelSurchargeMethod === 'hourly' && (
                    <div>
                      <label className="block text-gray-400 text-xs mb-1">Average Speed (MPH)</label>
                      <input
                        type="number"
                        step="1"
                        min="1"
                        max="80"
                        value={config.fuelSurchargeSpeed ?? 0}
                        onChange={e => setConfig({ ...config, fuelSurchargeSpeed: parseFloat(e.target.value) || 0 })}
                        className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm border border-gray-600 focus:outline-none focus:border-blue-500"
                        placeholder="30"
                      />
                      <p className="text-gray-500 text-xs mt-1">Converts per-mile FSC to per-hour. Set per operator contract.</p>
                    </div>
                  )}
                  {/* Live preview of the calculated rate */}
                  {company.currentDieselPrice != null && (
                    <div className="bg-gray-700/50 rounded p-3 text-xs">
                      <div className="text-gray-400 mb-1">Live calculation preview:</div>
                      <div className="text-white">
                        (${company.currentDieselPrice.toFixed(3)} − ${(config.fuelSurchargeBaseline ?? 0).toFixed(2)}) ÷ {config.fuelSurchargeMPG ?? 6} MPG
                        {config.fuelSurchargeMethod === 'hourly' ? ` × ${config.fuelSurchargeSpeed ?? 30} MPH` : ''}
                        {' = '}
                        <span className="text-green-400 font-medium">
                          ${((() => {
                            const diff = company.currentDieselPrice! - (config.fuelSurchargeBaseline ?? 0);
                            if (diff <= 0) return '0.00';
                            const perMile = diff / (config.fuelSurchargeMPG || 6);
                            if (config.fuelSurchargeMethod === 'hourly') {
                              return (perMile * (config.fuelSurchargeSpeed || 30)).toFixed(2);
                            }
                            return perMile.toFixed(4);
                          })())}
                          {config.fuelSurchargeMethod === 'hourly' ? '/hr' : '/mi'}
                        </span>
                      </div>
                    </div>
                  )}
                </>
              )}

              {config.fuelSurchargeMethod === 'percentage' && (
                <div>
                  <label className="block text-gray-400 text-xs mb-1">Surcharge Percentage (%)</label>
                  <div className="relative">
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      max="100"
                      value={config.fuelSurchargePercent ? (config.fuelSurchargePercent * 100).toFixed(1) : ''}
                      onChange={e => setConfig({ ...config, fuelSurchargePercent: (parseFloat(e.target.value) || 0) / 100 })}
                      className="w-full px-3 pr-8 py-2 bg-gray-700 text-white rounded text-sm border border-gray-600 focus:outline-none focus:border-blue-500"
                      placeholder="8.0"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">%</span>
                  </div>
                  <p className="text-gray-500 text-xs mt-1">Applied to the base linehaul amount</p>
                </div>
              )}

              {config.fuelSurchargeMethod === 'flat' && (
                <div>
                  <label className="block text-gray-400 text-xs mb-1">Flat Rate per Load ($)</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={config.fuelSurchargeRate ?? 0}
                      onChange={e => setConfig({ ...config, fuelSurchargeRate: parseFloat(e.target.value) || 0 })}
                      className="w-full pl-7 pr-3 py-2 bg-gray-700 text-white rounded text-sm border border-gray-600 focus:outline-none focus:border-blue-500"
                      placeholder="15.00"
                    />
                  </div>
                  <p className="text-gray-500 text-xs mt-1">Manually entered — oil company texts you the weekly rate</p>
                </div>
              )}

              {config.fuelSurchargeMethod === 'flat_doe' && (
                <>
                  <div className="bg-blue-900/30 border border-blue-500/20 rounded p-3 text-xs text-blue-300">
                    Bakken-style: auto-calculates a $/hr FSC rate from the DOE diesel price each week.
                    Formula: multiplier × (floor(DOE ÷ step) × step − baseline) = rate/hr × job hours
                  </div>
                  <div>
                    <label className="block text-gray-400 text-xs mb-1">Baseline Diesel Price ($/gal)</label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={config.fuelSurchargeBaseline ?? 0}
                        onChange={e => setConfig({ ...config, fuelSurchargeBaseline: parseFloat(e.target.value) || 0 })}
                        className="w-full pl-7 pr-3 py-2 bg-gray-700 text-white rounded text-sm border border-gray-600 focus:outline-none focus:border-blue-500"
                        placeholder="3.25"
                      />
                    </div>
                    <p className="text-gray-500 text-xs mt-1">No surcharge when diesel is at or below this price</p>
                  </div>
                  <div>
                    <label className="block text-gray-400 text-xs mb-1">Multiplier</label>
                    <input
                      type="number"
                      step="1"
                      min="1"
                      value={config.fuelSurchargeMultiplier ?? 0}
                      onChange={e => setConfig({ ...config, fuelSurchargeMultiplier: parseFloat(e.target.value) || 0 })}
                      className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm border border-gray-600 focus:outline-none focus:border-blue-500"
                      placeholder="8"
                    />
                    <p className="text-gray-500 text-xs mt-1">Bakken default: 8</p>
                  </div>
                  <div>
                    <label className="block text-gray-400 text-xs mb-1">Rounding Step ($)</label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                      <input
                        type="number"
                        step="0.01"
                        min="0.01"
                        value={config.fuelSurchargeStep ?? 0}
                        onChange={e => setConfig({ ...config, fuelSurchargeStep: parseFloat(e.target.value) || 0 })}
                        className="w-full pl-7 pr-3 py-2 bg-gray-700 text-white rounded text-sm border border-gray-600 focus:outline-none focus:border-blue-500"
                        placeholder="0.10"
                      />
                    </div>
                    <p className="text-gray-500 text-xs mt-1">DOE price floored to nearest step before calculating (Bakken default: $0.10)</p>
                  </div>
                  {/* Live preview */}
                  {company.currentDieselPrice != null && (
                    <div className="bg-gray-700/50 rounded p-3 text-xs">
                      <div className="text-gray-400 mb-1">Live calculation preview:</div>
                      <div className="text-white">
                        {(() => {
                          const diesel = company.currentDieselPrice!;
                          const baseline = config.fuelSurchargeBaseline || 3.25;
                          const multiplier = config.fuelSurchargeMultiplier || 8;
                          const step = config.fuelSurchargeStep || 0.10;
                          const stepped = Math.floor(diesel / step) * step;
                          const diff = stepped - baseline;
                          const fsc = diff > 0 ? Math.round(multiplier * diff * 100) / 100 : 0;
                          return (
                            <>
                              {multiplier} × (floor(${diesel.toFixed(3)} ÷ ${step.toFixed(2)}) × ${step.toFixed(2)} − ${baseline.toFixed(2)})
                              {' = '}
                              {multiplier} × (${stepped.toFixed(2)} − ${baseline.toFixed(2)})
                              {' = '}
                              <span className="text-green-400 font-medium">${fsc.toFixed(2)}/hr</span>
                            </>
                          );
                        })()}
                      </div>
                    </div>
                  )}
                </>
              )}
              {/* SWD Detention */}
              <div className="border-t border-gray-600 pt-4">
                <div className="flex items-center gap-2 mb-2">
                  <input
                    type="checkbox"
                    id="detentionEnabled"
                    checked={config.detentionEnabled || false}
                    onChange={e => setConfig({ ...config, detentionEnabled: e.target.checked })}
                    className="rounded"
                  />
                  <label htmlFor="detentionEnabled" className="text-gray-300 text-sm font-medium">
                    SWD Detention Pay
                  </label>
                  <span className="text-gray-500 text-xs">(BBL-rate jobs only)</span>
                </div>
                {config.detentionEnabled && (
                  <div className="space-y-3 ml-5">
                    <div className="bg-orange-900/20 border border-orange-500/20 rounded p-2 text-xs text-orange-300">
                      When a driver waits at an SWD longer than the threshold, hourly pay kicks in on top of the BBL rate.
                    </div>
                    <div>
                      <label className="block text-gray-400 text-xs mb-1">Wait Threshold (minutes)</label>
                      <input
                        type="number"
                        step="1"
                        min="1"
                        value={config.detentionThresholdMinutes ?? 60}
                        onChange={e => setConfig({ ...config, detentionThresholdMinutes: parseInt(e.target.value) || 60 })}
                        className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm border border-gray-600 focus:outline-none focus:border-blue-500"
                        placeholder="60"
                      />
                      <p className="text-gray-500 text-xs mt-1">Hourly pay starts after this many minutes at the SWD</p>
                    </div>
                    <div>
                      <label className="block text-gray-400 text-xs mb-1">Detention Rate ($/hr)</label>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={config.detentionHourlyRate ?? ''}
                          onChange={e => setConfig({ ...config, detentionHourlyRate: parseFloat(e.target.value) || 0 })}
                          className="w-full pl-7 pr-3 py-2 bg-gray-700 text-white rounded text-sm border border-gray-600 focus:outline-none focus:border-blue-500"
                          placeholder="Leave blank to use hourly rate"
                        />
                      </div>
                      <p className="text-gray-500 text-xs mt-1">Leave blank to use the operator&apos;s hourly rate from the rate sheet</p>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={save}
                disabled={saving}
                className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save Config'}
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
