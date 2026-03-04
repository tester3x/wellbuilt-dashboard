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
                      {cfg.fuelSurchargeMethod === 'hourly' && cfg.fuelSurchargeRate ? ` ($${cfg.fuelSurchargeRate}/hr)` : ''}
                      {cfg.fuelSurchargeMethod === 'flat' && cfg.fuelSurchargeRate ? ` ($${cfg.fuelSurchargeRate}/load)` : ''}
                      {cfg.fuelSurchargeMethod === 'percentage' && cfg.fuelSurchargePercent ? ` (${(cfg.fuelSurchargePercent * 100).toFixed(1)}%)` : ''}
                      {cfg.fuelSurchargeMethod === 'per_mile' ? ` (base $${cfg.fuelSurchargeBaseline || 0}/gal, ${cfg.fuelSurchargeMPG || 6} MPG)` : ''}
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
              {config.fuelSurchargeMethod === 'hourly' && (
                <div>
                  <label className="block text-gray-400 text-xs mb-1">Rate ($/hr)</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={config.fuelSurchargeRate || ''}
                      onChange={e => setConfig({ ...config, fuelSurchargeRate: parseFloat(e.target.value) || 0 })}
                      className="w-full pl-7 pr-3 py-2 bg-gray-700 text-white rounded text-sm border border-gray-600 focus:outline-none focus:border-blue-500"
                      placeholder="12.00"
                    />
                  </div>
                </div>
              )}

              {config.fuelSurchargeMethod === 'per_mile' && (
                <>
                  <div>
                    <label className="block text-gray-400 text-xs mb-1">Baseline Diesel Price ($/gal)</label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={config.fuelSurchargeBaseline || ''}
                        onChange={e => setConfig({ ...config, fuelSurchargeBaseline: parseFloat(e.target.value) || 0 })}
                        className="w-full pl-7 pr-3 py-2 bg-gray-700 text-white rounded text-sm border border-gray-600 focus:outline-none focus:border-blue-500"
                        placeholder="2.50"
                      />
                    </div>
                    <p className="text-gray-500 text-xs mt-1">Surcharge kicks in when diesel exceeds this price</p>
                  </div>
                  <div>
                    <label className="block text-gray-400 text-xs mb-1">Truck MPG (loaded)</label>
                    <input
                      type="number"
                      step="0.1"
                      min="1"
                      value={config.fuelSurchargeMPG || ''}
                      onChange={e => setConfig({ ...config, fuelSurchargeMPG: parseFloat(e.target.value) || 6 })}
                      className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm border border-gray-600 focus:outline-none focus:border-blue-500"
                      placeholder="6"
                    />
                    <p className="text-gray-500 text-xs mt-1">Water haulers typically 5-6 MPG loaded</p>
                  </div>
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
                      value={config.fuelSurchargeRate || ''}
                      onChange={e => setConfig({ ...config, fuelSurchargeRate: parseFloat(e.target.value) || 0 })}
                      className="w-full pl-7 pr-3 py-2 bg-gray-700 text-white rounded text-sm border border-gray-600 focus:outline-none focus:border-blue-500"
                      placeholder="15.00"
                    />
                  </div>
                </div>
              )}
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
