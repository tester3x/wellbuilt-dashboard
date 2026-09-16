'use client';

/**
 * Dispatch Job Types Settings Card (Phase 1)
 *
 * Allows each hauler to define the flat list of job-type terms its dispatchers
 * and drivers see, while mapping each internally to canonical parent workClass: 'pw' | 'sw'.
 *
 * Vocabulary management only — pay rates, billing basis, rates, percentages,
 * hourly rules, and barrel rules remain strictly in Pay Rate Settings.
 */

import { useState, useEffect, useId, useMemo } from 'react';
import { type CompanyConfig, updateCompanyFields } from '@/lib/companySettings';
import {
  type DispatchJobTypeEntry,
  type WorkClass,
  resolveDispatchJobTypes,
  validateDispatchJobTypes,
  buildDispatchJobTypesPayload,
  moveJobTypeUp,
  moveJobTypeDown,
  generateJobTypeId,
  normalizeJobTypeCode,
  normalizeJobTypeName,
} from '@/lib/dispatchJobTypesCore';

interface Props {
  company: CompanyConfig;
  onSave: () => void;
  /** Whether the current user may edit company dispatch settings (manageCompany). */
  canEdit: boolean;
  actorUid?: string;
}

export function DispatchJobTypesCard({ company, onSave, canEdit, actorUid }: Props) {
  // Resolved saved items from company doc (falls back to in-memory PW/SW if missing)
  const initialItems = useMemo(
    () => resolveDispatchJobTypes(company.dispatchJobTypes),
    [company.dispatchJobTypes]
  );

  // Set of stable IDs that were saved in Firestore (or loaded on mount)
  const [savedIds, setSavedIds] = useState<Set<string>>(
    () => new Set(initialItems.map(i => i.id))
  );

  const [draftItems, setDraftItems] = useState<DispatchJobTypeEntry[]>(initialItems);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // New item draft inputs
  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');
  const [newWorkClass, setNewWorkClass] = useState<WorkClass>('pw');
  const [addError, setAddError] = useState<string | null>(null);

  // Re-sync when company doc changes from upstream save/refresh
  useEffect(() => {
    const items = resolveDispatchJobTypes(company.dispatchJobTypes);
    setDraftItems(items);
    setSavedIds(new Set(items.map(i => i.id)));
    setSaveError(null);
  }, [company.dispatchJobTypes]);

  // Validation
  const validation = useMemo(() => validateDispatchJobTypes(draftItems), [draftItems]);

  // Dirty check: check if draft differs from initialItems
  const isDirty = useMemo(() => {
    if (draftItems.length !== initialItems.length) return true;
    for (let i = 0; i < draftItems.length; i++) {
      const d = draftItems[i];
      const s = initialItems[i];
      if (
        d.id !== s.id ||
        d.code !== s.code ||
        d.name !== s.name ||
        d.workClass !== s.workClass ||
        d.enabled !== s.enabled ||
        d.order !== s.order
      ) {
        return true;
      }
    }
    return false;
  }, [draftItems, initialItems]);

  // Field updates for existing rows
  const handleUpdateField = (
    id: string,
    field: 'code' | 'name' | 'workClass' | 'enabled',
    value: unknown
  ) => {
    if (!canEdit) return;
    setSaveSuccess(false);
    setDraftItems(prev =>
      prev.map(item => {
        if (item.id !== id) return item;
        if (field === 'code') {
          return { ...item, code: normalizeJobTypeCode(String(value)).slice(0, 2) };
        }
        if (field === 'name') {
          return { ...item, name: String(value) };
        }
        if (field === 'workClass') {
          return { ...item, workClass: value === 'sw' ? 'sw' : 'pw' };
        }
        if (field === 'enabled') {
          return { ...item, enabled: Boolean(value) };
        }
        return item;
      })
    );
  };

  // Move controls
  const handleMoveUp = (index: number) => {
    if (!canEdit) return;
    setSaveSuccess(false);
    setDraftItems(prev => moveJobTypeUp(prev, index));
  };

  const handleMoveDown = (index: number) => {
    if (!canEdit) return;
    setSaveSuccess(false);
    setDraftItems(prev => moveJobTypeDown(prev, index));
  };

  // Add new row
  const handleAddJobType = () => {
    if (!canEdit) return;
    setAddError(null);
    setSaveSuccess(false);

    const code = normalizeJobTypeCode(newCode);
    const name = normalizeJobTypeName(newName);

    if (!code || !/^[A-Z]{2}$/.test(code)) {
      setAddError('Code must be exactly 2 letters (e.g. DW, FW).');
      return;
    }

    if (!name) {
      setAddError('Display name cannot be empty.');
      return;
    }

    // Check duplicate code
    if (draftItems.some(i => i.code.toUpperCase() === code)) {
      setAddError(`Code "${code}" is already in use.`);
      return;
    }

    // Check duplicate name
    if (draftItems.some(i => i.name.toLowerCase() === name.toLowerCase())) {
      setAddError(`Job type name "${name}" is already in use.`);
      return;
    }

    const newEntry: DispatchJobTypeEntry = {
      id: generateJobTypeId(),
      code,
      name,
      workClass: newWorkClass,
      enabled: true,
      order: draftItems.length,
    };

    setDraftItems(prev => [...prev, newEntry]);
    setNewCode('');
    setNewName('');
    setNewWorkClass('pw');
  };

  // Remove unsaved row (or alert if trying to remove previously saved)
  const handleRemoveRow = (entry: DispatchJobTypeEntry) => {
    if (!canEdit) return;
    setSaveSuccess(false);
    if (!savedIds.has(entry.id)) {
      // Newly added, not yet saved -> cleanly remove
      setDraftItems(prev =>
        prev.filter(i => i.id !== entry.id).map((item, idx) => ({ ...item, order: idx }))
      );
    }
  };

  // Cancel changes
  const handleCancel = () => {
    setDraftItems(initialItems);
    setSaveError(null);
    setAddError(null);
    setSaveSuccess(false);
  };

  // Save changes
  const handleSave = async () => {
    if (!canEdit || !isDirty || !validation.valid) return;
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);

    try {
      const payload = buildDispatchJobTypesPayload(draftItems, actorUid);
      // Governed narrow update: updates only dispatchJobTypes field on companies/{id}
      await updateCompanyFields(company.id, {
        dispatchJobTypes: payload,
      });

      setSavedIds(new Set(payload.items.map(i => i.id)));
      setSaveSuccess(true);
      onSave();
    } catch (err) {
      console.error('Failed to save dispatch job types:', err);
      setSaveError('Could not save dispatch job types — changes were not applied. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const codeInputId = useId();
  const nameInputId = useId();
  const classInputId = useId();

  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-700 bg-gray-850 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-white font-semibold text-sm">Dispatch Job Types</h3>
            {isDirty && (
              <span className="px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider rounded bg-amber-900/50 text-amber-300 border border-amber-600/40">
                Unsaved Changes
              </span>
            )}
          </div>
          <p className="text-gray-400 text-xs mt-0.5">
            Choose the job-type terms dispatchers and drivers see. Each type remains Production Water or Service Work internally.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <span>{draftItems.filter(i => i.enabled).length} of {draftItems.length} enabled</span>
        </div>
      </div>

      {/* Permission / Status Banners */}
      {!canEdit && (
        <div className="px-4 py-2.5 bg-gray-750 border-b border-gray-700 text-gray-400 text-xs flex items-center gap-2">
          <svg className="w-4 h-4 text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
          <span>View-only — you do not have permission to change company dispatch job types.</span>
        </div>
      )}

      {saveError && (
        <div className="px-4 py-2.5 bg-red-900/30 border-b border-red-800/50 text-red-300 text-xs flex items-center justify-between" role="alert">
          <span>{saveError}</span>
          <button onClick={() => setSaveError(null)} className="text-red-400 hover:text-red-200 font-bold ml-2">×</button>
        </div>
      )}

      {saveSuccess && !isDirty && (
        <div className="px-4 py-2 bg-emerald-900/30 border-b border-emerald-800/50 text-emerald-300 text-xs">
          ✓ Dispatch job types successfully saved.
        </div>
      )}

      {validation.generalError && (
        <div className="px-4 py-2 bg-amber-900/30 border-b border-amber-800/50 text-amber-300 text-xs" role="alert">
          ⚠ {validation.generalError}
        </div>
      )}

      {/* Main Content Area */}
      <div className="p-4 space-y-4">
        {/* Job Types List */}
        <div className="space-y-2">
          {draftItems.map((entry, index) => {
            const isSaved = savedIds.has(entry.id);
            const rowError = validation.rowErrors[entry.id];
            const isFirst = index === 0;
            const isLast = index === draftItems.length - 1;

            return (
              <div
                key={entry.id}
                className={`p-3 rounded-lg border transition-colors ${
                  entry.enabled
                    ? 'bg-gray-750/70 border-gray-650'
                    : 'bg-gray-800/60 border-gray-700/60 opacity-75'
                }`}
              >
                <div className="flex flex-col md:flex-row md:items-center gap-3">
                  {/* Reorder Buttons + Code */}
                  <div className="flex items-center gap-2 shrink-0">
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => handleMoveUp(index)}
                        disabled={!canEdit || isFirst}
                        aria-label={`Move ${entry.name || entry.code} up`}
                        title="Move up"
                        className="p-1 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-30 disabled:cursor-not-allowed text-gray-300 hover:text-white transition-colors"
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        onClick={() => handleMoveDown(index)}
                        disabled={!canEdit || isLast}
                        aria-label={`Move ${entry.name || entry.code} down`}
                        title="Move down"
                        className="p-1 rounded bg-gray-700 hover:bg-gray-600 disabled:opacity-30 disabled:cursor-not-allowed text-gray-300 hover:text-white transition-colors"
                      >
                        ▼
                      </button>
                    </div>

                    {/* 2-Letter Code Input */}
                    <div className="w-16">
                      <input
                        type="text"
                        value={entry.code}
                        onChange={e => handleUpdateField(entry.id, 'code', e.target.value)}
                        disabled={!canEdit}
                        maxLength={2}
                        aria-label={`Code for ${entry.name}`}
                        className={`w-full px-2 py-1.5 text-center font-mono font-bold text-sm rounded bg-gray-700 text-white uppercase border focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-60 disabled:cursor-not-allowed ${
                          rowError?.code ? 'border-red-500' : 'border-gray-600'
                        }`}
                      />
                    </div>
                  </div>

                  {/* Display Name Input */}
                  <div className="flex-1 min-w-[140px]">
                    <input
                      type="text"
                      value={entry.name}
                      onChange={e => handleUpdateField(entry.id, 'name', e.target.value)}
                      disabled={!canEdit}
                      placeholder="e.g. Production Water"
                      aria-label={`Display name for ${entry.code}`}
                      className={`w-full px-3 py-1.5 text-sm rounded bg-gray-700 text-white placeholder-gray-500 border focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-60 disabled:cursor-not-allowed ${
                        rowError?.name ? 'border-red-500' : 'border-gray-600'
                      }`}
                    />
                  </div>

                  {/* Internal Work Class Selector */}
                  <div className="shrink-0">
                    <select
                      value={entry.workClass}
                      onChange={e => handleUpdateField(entry.id, 'workClass', e.target.value)}
                      disabled={!canEdit}
                      aria-label={`Internal class for ${entry.name}`}
                      className="px-2.5 py-1.5 text-xs rounded bg-gray-700 text-gray-200 border border-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      <option value="pw">Class: Production Water (PW)</option>
                      <option value="sw">Class: Service Work (SW)</option>
                    </select>
                  </div>

                  {/* Enabled Toggle + Row Status / Actions */}
                  <div className="flex items-center justify-between md:justify-end gap-3 shrink-0">
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={entry.enabled}
                        onChange={e => handleUpdateField(entry.id, 'enabled', e.target.checked)}
                        disabled={!canEdit}
                        className="rounded border-gray-500 text-blue-500 focus:ring-blue-500 focus:ring-offset-0 bg-gray-800 disabled:opacity-50"
                      />
                      <span className={`text-xs ${entry.enabled ? 'text-gray-200' : 'text-gray-400'}`}>
                        {entry.enabled ? 'Enabled' : 'Disabled'}
                      </span>
                    </label>

                    {/* Unsaved item can be removed; saved item shows permanent/archived note */}
                    {!isSaved ? (
                      <button
                        type="button"
                        onClick={() => handleRemoveRow(entry)}
                        disabled={!canEdit}
                        aria-label={`Remove unsaved type ${entry.name || entry.code}`}
                        title="Remove unsaved row"
                        className="px-2 py-1 text-xs text-red-400 hover:text-red-300 hover:bg-red-950/40 rounded transition-colors disabled:opacity-40"
                      >
                        Remove
                      </button>
                    ) : (
                      <span
                        className="text-2xs text-gray-400 px-1.5 py-0.5 rounded bg-gray-700/50"
                        title="Saved job types cannot be deleted to preserve ticket and dispatch history. Use the Enabled toggle to disable."
                      >
                        Saved
                      </span>
                    )}
                  </div>
                </div>

                {/* Inline Row Validation Error */}
                {(rowError?.code || rowError?.name) && (
                  <div className="mt-2 text-2xs text-red-400 space-y-0.5" role="alert">
                    {rowError.code && <div>• {rowError.code}</div>}
                    {rowError.name && <div>• {rowError.name}</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Add Job Type Row */}
        {canEdit && (
          <div className="p-3 bg-gray-850 rounded-lg border border-dashed border-gray-700 space-y-2">
            <div className="text-xs font-medium text-gray-300">Add New Job Type</div>
            <div className="flex flex-col sm:flex-row gap-2">
              <div className="w-full sm:w-20">
                <label htmlFor={codeInputId} className="sr-only">Code</label>
                <input
                  id={codeInputId}
                  type="text"
                  value={newCode}
                  onChange={e => setNewCode(e.target.value.toUpperCase().slice(0, 2))}
                  placeholder="Code"
                  maxLength={2}
                  className="w-full px-2 py-1.5 text-center font-mono font-bold text-sm rounded bg-gray-700 text-white placeholder-gray-500 uppercase border border-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div className="flex-1">
                <label htmlFor={nameInputId} className="sr-only">Display Name</label>
                <input
                  id={nameInputId}
                  type="text"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAddJobType()}
                  placeholder="e.g. Disposal Water, Flowback..."
                  className="w-full px-3 py-1.5 text-sm rounded bg-gray-700 text-white placeholder-gray-500 border border-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div className="w-full sm:w-auto">
                <label htmlFor={classInputId} className="sr-only">Internal Work Class</label>
                <select
                  id={classInputId}
                  value={newWorkClass}
                  onChange={e => setNewWorkClass(e.target.value as WorkClass)}
                  className="w-full sm:w-auto px-2.5 py-1.5 text-xs rounded bg-gray-700 text-gray-200 border border-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="pw">Class: Production Water (PW)</option>
                  <option value="sw">Class: Service Work (SW)</option>
                </select>
              </div>
              <button
                type="button"
                onClick={handleAddJobType}
                disabled={!newCode.trim() || !newName.trim()}
                className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-xs font-medium rounded transition-colors"
              >
                + Add Job Type
              </button>
            </div>
            {addError && (
              <div className="text-2xs text-amber-400" role="alert">
                • {addError}
              </div>
            )}
          </div>
        )}

        {/* Footer Actions: Save & Cancel */}
        {canEdit && (
          <div className="pt-2 border-t border-gray-700 flex items-center justify-between gap-3">
            <div className="text-2xs text-gray-500">
              {isDirty ? 'You have unsaved changes.' : 'All changes saved.'}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleCancel}
                disabled={!isDirty || saving}
                className="px-3 py-1.5 text-xs font-medium text-gray-300 hover:text-white bg-gray-700 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed rounded transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={!isDirty || !validation.valid || saving}
                className="px-4 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed rounded transition-colors flex items-center gap-1.5"
              >
                {saving ? (
                  <>
                    <span className="inline-block w-3 h-3 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                    <span>Saving...</span>
                  </>
                ) : (
                  <span>Save Changes</span>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
