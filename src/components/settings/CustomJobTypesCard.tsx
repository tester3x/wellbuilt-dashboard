'use client';

// Custom Job Types Card — Companies can add their own job type labels.
// These appear in the dispatch service type dropdown alongside package-defined types.
// Usage is tracked in Firestore job_type_usage collection.
// Popular custom types get promoted to official package types (R&D pipeline).

import { useState } from 'react';
import { type CompanyConfig, updateCompanyFields } from '@/lib/companySettings';

interface Props {
  company: CompanyConfig;
  onSave: () => void;
}

export function CustomJobTypesCard({ company, onSave }: Props) {
  const [newType, setNewType] = useState('');
  const [saving, setSaving] = useState(false);
  const customTypes = company.customJobTypes || [];

  const addType = async () => {
    const label = newType.trim();
    if (!label) return;
    // Don't allow duplicates (case-insensitive)
    if (customTypes.some(t => t.toLowerCase() === label.toLowerCase())) {
      setNewType('');
      return;
    }
    setSaving(true);
    try {
      await updateCompanyFields(company.id, {
        customJobTypes: [...customTypes, label],
      });
      setNewType('');
      onSave();
    } catch (err) {
      console.error('Failed to add custom job type:', err);
    } finally {
      setSaving(false);
    }
  };

  const removeType = async (label: string) => {
    setSaving(true);
    try {
      await updateCompanyFields(company.id, {
        customJobTypes: customTypes.filter(t => t !== label),
      });
      onSave();
    } catch (err) {
      console.error('Failed to remove custom job type:', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
        <div>
          <h3 className="text-white font-semibold text-sm">Custom Job Types</h3>
          <p className="text-gray-500 text-xs mt-0.5">
            Add company-specific job types for dispatch. Popular types get promoted to official packages.
          </p>
        </div>
        <span className="text-gray-600 text-xs">{customTypes.length} custom</span>
      </div>

      <div className="p-4 space-y-3">
        {/* Add new type */}
        <div className="flex gap-2">
          <input
            type="text"
            value={newType}
            onChange={e => setNewType(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addType()}
            placeholder="e.g. Slickline, Coiled Tubing..."
            className="flex-1 px-3 py-2 bg-gray-700 text-white rounded text-sm placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            maxLength={50}
            disabled={saving}
          />
          <button
            onClick={addType}
            disabled={saving || !newType.trim()}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 disabled:text-gray-400 text-white text-sm font-medium rounded transition-colors"
          >
            Add
          </button>
        </div>

        {/* Existing custom types */}
        {customTypes.length === 0 ? (
          <div className="text-gray-500 text-xs text-center py-4">
            No custom job types yet. Add types specific to your operation.
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {customTypes.map(t => (
              <span
                key={t}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-gray-700 text-gray-200 text-sm rounded-full"
              >
                {t}
                <button
                  onClick={() => removeType(t)}
                  disabled={saving}
                  className="text-gray-500 hover:text-red-400 transition-colors text-xs font-bold"
                  title="Remove"
                >
                  &times;
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
