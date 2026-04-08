'use client';

import { useState } from 'react';
import { type CompanyConfig, updateCompanyFields } from '@/lib/companySettings';

interface Props {
  company: CompanyConfig;
  onSave: () => void;
}

const JSA_MODES = [
  { value: 'off', label: 'Off', desc: 'JSA available in menu but not required' },
  { value: 'per_shift', label: 'Per Shift', desc: 'Required once at the start of each shift' },
  { value: 'per_location', label: 'Per Location', desc: 'Required at each new well location + shift start' },
] as const;

export function JsaCard({ company, onSave }: Props) {
  const [saving, setSaving] = useState(false);
  const currentMode = company.jsaMode || 'off';

  const setMode = async (mode: 'off' | 'per_shift' | 'per_location') => {
    if (mode === currentMode) return;
    setSaving(true);
    try {
      await updateCompanyFields(company.id, { jsaMode: mode });
      onSave();
    } catch (err) {
      console.error('Failed to save jsaMode:', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-gray-800 rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-red-500/30 bg-red-900/20">
        <h3 className="text-red-400 font-medium text-sm">Job Safety Analysis (JSA)</h3>
      </div>

      <div className="p-4 space-y-3">
        <div className="text-gray-400 text-xs mb-2">
          Control when drivers are required to complete a JSA form before starting work.
          Requires WB JSA app installed on driver devices.
        </div>

        {JSA_MODES.map((mode) => (
          <button
            key={mode.value}
            onClick={() => setMode(mode.value)}
            disabled={saving}
            className={`w-full text-left px-3 py-3 rounded-lg border transition-colors ${
              currentMode === mode.value
                ? 'border-red-500/50 bg-red-900/20'
                : 'border-gray-700 hover:border-gray-500'
            } ${saving ? 'opacity-50' : ''}`}
          >
            <div className="flex items-center gap-3">
              <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                currentMode === mode.value
                  ? 'border-red-400'
                  : 'border-gray-600'
              }`}>
                {currentMode === mode.value && (
                  <div className="w-2 h-2 rounded-full bg-red-400" />
                )}
              </div>
              <div>
                <div className={`text-sm font-medium ${
                  currentMode === mode.value ? 'text-red-400' : 'text-white'
                }`}>{mode.label}</div>
                <div className="text-gray-500 text-xs">{mode.desc}</div>
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
