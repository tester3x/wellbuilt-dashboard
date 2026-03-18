'use client';

import { useState } from 'react';
import {
  type CompanyConfig,
  type PayrollTemplate,
  ALL_PAYROLL_COLUMNS,
  DEFAULT_PAYROLL_COLUMNS,
  updateCompanyFields,
} from '@/lib/companySettings';

interface Props {
  company: CompanyConfig;
  onSave: () => void;
}

export function PayrollTemplateCard({ company, onSave }: Props) {
  const saved = company.payConfig?.payrollTemplate;
  const [columns, setColumns] = useState<string[]>(saved?.columns || DEFAULT_PAYROLL_COLUMNS);
  const [editingOrder, setEditingOrder] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const toggle = (id: string) => {
    setColumns(prev => {
      const next = prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id];
      setDirty(true);
      return next;
    });
  };

  const move = (id: string, dir: -1 | 1) => {
    setColumns(prev => {
      const idx = prev.indexOf(id);
      if (idx < 0) return prev;
      const target = idx + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      setDirty(true);
      return next;
    });
  };

  const handleSave = async () => {
    if (!company.id) return;
    setSaving(true);
    await updateCompanyFields(company.id, {
      'payConfig.payrollTemplate': { columns } as PayrollTemplate,
    });
    setSaving(false);
    setDirty(false);
    onSave();
  };

  const handleReset = () => {
    setColumns(DEFAULT_PAYROLL_COLUMNS);
    setDirty(true);
  };

  // For the checkbox grid, show all columns. Checked = in `columns` array.
  // For the order list, show only enabled columns in their current order.
  const enabledCols = columns.map(id => ALL_PAYROLL_COLUMNS.find(c => c.id === id)!).filter(Boolean);

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-xl p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-bold text-white">Payroll Timesheet Template</h3>
          <p className="text-gray-400 text-sm mt-1">Choose which columns appear on timesheets and their order</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleReset}
            className="px-3 py-1.5 rounded text-xs font-medium bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors"
          >
            Reset
          </button>
          <button
            onClick={() => setEditingOrder(!editingOrder)}
            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              editingOrder ? 'bg-blue-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
            }`}
          >
            {editingOrder ? 'Done Ordering' : 'Edit Order'}
          </button>
        </div>
      </div>

      {/* Checkbox Grid */}
      {!editingOrder && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 mb-4">
          {ALL_PAYROLL_COLUMNS.map(col => (
            <label
              key={col.id}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                columns.includes(col.id)
                  ? 'border-blue-500/40 bg-blue-600/10 text-white'
                  : 'border-gray-600 bg-gray-700/30 text-gray-400'
              }`}
            >
              <input
                type="checkbox"
                checked={columns.includes(col.id)}
                onChange={() => toggle(col.id)}
                className="w-4 h-4 rounded border-gray-500 bg-gray-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
              />
              <span className="text-sm font-medium">{col.label}</span>
            </label>
          ))}
        </div>
      )}

      {/* Reorder List */}
      {editingOrder && (
        <div className="space-y-1 mb-4">
          {enabledCols.map((col, idx) => (
            <div
              key={col.id}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-700/40 border border-gray-600"
            >
              <span className="text-gray-500 text-xs font-mono w-5 text-right">{idx + 1}</span>
              <span className="text-white text-sm font-medium flex-1">{col.label}</span>
              <span className="text-gray-500 text-xs">{col.align === 'right' ? 'Right' : 'Left'}</span>
              <button
                onClick={() => move(col.id, -1)}
                disabled={idx === 0}
                className={`p-1 rounded transition-colors ${idx === 0 ? 'text-gray-600' : 'text-gray-400 hover:text-white hover:bg-gray-600'}`}
              >
                ▲
              </button>
              <button
                onClick={() => move(col.id, 1)}
                disabled={idx === enabledCols.length - 1}
                className={`p-1 rounded transition-colors ${idx === enabledCols.length - 1 ? 'text-gray-600' : 'text-gray-400 hover:text-white hover:bg-gray-600'}`}
              >
                ▼
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Preview */}
      <div className="mb-4">
        <p className="text-gray-500 text-xs font-medium uppercase mb-2">Preview</p>
        <div className="overflow-x-auto rounded-lg border border-gray-700">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-gray-700/50">
                {enabledCols.map(col => (
                  <th
                    key={col.id}
                    className={`px-2 py-1.5 font-medium text-gray-400 ${col.align === 'right' ? 'text-right' : 'text-left'}`}
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-gray-700/50">
                {enabledCols.map(col => (
                  <td key={col.id} className={`px-2 py-1 text-gray-500 ${col.align === 'right' ? 'text-right' : ''}`}>
                    {col.format === 'currency' ? '$0.00' : col.format === 'decimal' ? '0.00' : col.format === 'number' ? '0' : '—'}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Save */}
      {dirty && (
        <button
          onClick={handleSave}
          disabled={saving}
          className={`w-full py-2 rounded-lg text-sm font-bold transition-colors ${
            saving ? 'bg-gray-600 text-gray-400' : 'bg-blue-600 hover:bg-blue-700 text-white'
          }`}
        >
          {saving ? 'Saving...' : 'Save Payroll Template'}
        </button>
      )}
    </div>
  );
}
