'use client';

import { useState, useRef, useEffect } from 'react';
import { type CompanyConfig, updateCompanyFields } from '@/lib/companySettings';
import { loadOperators, searchOperators, NdicOperator } from '@/lib/firestoreWells';

interface Props {
  company: CompanyConfig;
  onSave: () => void;
}

export function OilCompaniesCard({ company, onSave }: Props) {
  const [showModal, setShowModal] = useState(false);
  const [search, setSearch] = useState('');
  const [suggestions, setSuggestions] = useState<NdicOperator[]>([]);
  const [allOperators, setAllOperators] = useState<NdicOperator[]>([]);
  const [saving, setSaving] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadOperators().then(ops => setAllOperators(ops)).catch(() => {});
  }, []);

  const openModal = () => {
    setShowModal(true);
    setSearch('');
    setSuggestions([]);
    setTimeout(() => searchRef.current?.focus(), 100);
  };

  const handleSearch = (text: string) => {
    setSearch(text);
    if (text.length < 1) {
      setSuggestions([]);
      return;
    }
    const results = searchOperators(text, allOperators, 10);
    const existing = new Set(company.assignedOperators || []);
    setSuggestions(results.filter(op => !existing.has(op.name)));
  };

  const addOperator = async (operatorName: string) => {
    const existing = company.assignedOperators || [];
    if (existing.includes(operatorName)) return;

    setSaving(true);
    try {
      await updateCompanyFields(company.id, {
        assignedOperators: [...existing, operatorName].sort(),
      });
      setShowModal(false);
      setSearch('');
      onSave();
    } catch (err) {
      console.error('Failed to add operator:', err);
    } finally {
      setSaving(false);
    }
  };

  const removeOperator = async (operatorName: string) => {
    setSaving(true);
    try {
      const updated = (company.assignedOperators || []).filter(op => op !== operatorName);
      await updateCompanyFields(company.id, { assignedOperators: updated });
      onSave();
    } catch (err) {
      console.error('Failed to remove operator:', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="bg-gray-800 rounded-lg overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-yellow-500/30 bg-yellow-900/20">
          <h3 className="text-yellow-400 font-medium text-sm">
            Oil Companies ({company.assignedOperators?.length || 0})
          </h3>
          <button
            onClick={openModal}
            className="px-3 py-1 text-xs rounded bg-yellow-600 hover:bg-yellow-500 text-white"
          >
            + Add
          </button>
        </div>

        <div className="p-4">
          {(company.assignedOperators?.length || 0) === 0 ? (
            <div className="text-gray-500 text-xs py-2">
              No oil companies assigned yet. Add the operators this company hauls for.
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {company.assignedOperators!.map(op => (
                <div
                  key={op}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 bg-yellow-900/40 border border-yellow-700/50 rounded text-sm"
                >
                  <span className="text-yellow-200">{op}</span>
                  <button
                    onClick={() => removeOperator(op)}
                    disabled={saving}
                    className="text-red-400 hover:text-red-300 text-xs ml-1"
                    title="Remove"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Add Operator Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-white font-medium mb-1">Add Oil Company</h3>
            <p className="text-gray-400 text-xs mb-4">
              Search operators and click to add.
            </p>

            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={e => handleSearch(e.target.value)}
              placeholder="Type operator name (e.g., HESS, SLAWSON)..."
              className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm placeholder-gray-500"
              autoFocus
            />

            {suggestions.length > 0 && (
              <div className="bg-gray-900 rounded mt-1 max-h-48 overflow-y-auto">
                {suggestions.map(op => (
                  <div
                    key={op.name}
                    onClick={() => addOperator(op.name)}
                    className="px-3 py-2 hover:bg-gray-700 cursor-pointer text-white text-sm"
                  >
                    {op.name}
                    {op.well_count && (
                      <span className="text-gray-500 ml-2">({op.well_count} wells)</span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {search.length >= 2 && suggestions.length === 0 && (
              <p className="text-gray-500 text-sm mt-2">No matching operators found</p>
            )}

            <div className="flex justify-end mt-4">
              <button
                onClick={() => { setShowModal(false); setSearch(''); }}
                className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded text-sm"
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
