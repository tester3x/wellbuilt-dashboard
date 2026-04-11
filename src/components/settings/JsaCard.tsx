'use client';

import { useState, useEffect, useCallback } from 'react';
import { type CompanyConfig, updateCompanyFields } from '@/lib/companySettings';
import {
  type JsaTemplate,
  type JsaTemplateStep,
  type JsaPpeItem,
  type JsaPreparedItem,
  uploadAndParseJsaPdf,
  saveJsaTemplate,
  loadJsaTemplates,
  activateJsaTemplate,
  deactivateJsaTemplate,
  deleteJsaTemplate,
} from '@/lib/jsaTemplates';

interface Props {
  company: CompanyConfig;
  onSave: () => void;
}

const JSA_MODES = [
  { value: 'off', label: 'Off', desc: 'JSA available in menu but not required' },
  { value: 'per_shift', label: 'Per Shift', desc: 'Required once at the start of each shift' },
  { value: 'per_location', label: 'Per Location', desc: 'Required at each new well location + shift start' },
] as const;

type UploadState = 'idle' | 'uploading' | 'parsing' | 'error';

export function JsaCard({ company, onSave }: Props) {
  const [saving, setSaving] = useState(false);
  const currentMode = company.jsaMode || 'off';

  // Contact management state
  const [emergencyContacts, setEmergencyContacts] = useState<{ label: string; phone: string }[]>(
    company.emergencyContacts || []
  );
  const [companyContacts, setCompanyContacts] = useState<{ label: string; phone: string }[]>(
    company.companyContacts || []
  );
  const [contactsDirty, setContactsDirty] = useState(false);

  // Multi-template state
  const [templates, setTemplates] = useState<JsaTemplate[]>([]);
  const [templateLoading, setTemplateLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [uploadState, setUploadState] = useState<UploadState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Editing state (local copy for whichever template is being edited)
  const [editName, setEditName] = useState('');
  const [editPackageId, setEditPackageId] = useState<string>('');
  const [editSteps, setEditSteps] = useState<JsaTemplateStep[]>([]);
  const [editPpe, setEditPpe] = useState<JsaPpeItem[]>([]);
  const [editPrepared, setEditPrepared] = useState<JsaPreparedItem[]>([]);

  const activePackages = company.activePackages || ['water-hauling'];

  // Load all templates
  const refreshTemplates = useCallback(async () => {
    try {
      const all = await loadJsaTemplates(company.id);
      // Sort: active first, then by name
      all.sort((a, b) => {
        if (a.status === 'active' && b.status !== 'active') return -1;
        if (b.status === 'active' && a.status !== 'active') return 1;
        return a.name.localeCompare(b.name);
      });
      setTemplates(all);
    } catch (err) {
      console.error('Failed to load JSA templates:', err);
    }
  }, [company.id]);

  useEffect(() => {
    setTemplateLoading(true);
    refreshTemplates().finally(() => setTemplateLoading(false));
  }, [refreshTemplates]);

  // Populate edit fields from a template
  const populateEdit = useCallback((t: JsaTemplate) => {
    setEditName(t.name);
    setEditPackageId(t.packageId || '');
    setEditSteps(JSON.parse(JSON.stringify(t.steps)));
    setEditPpe(JSON.parse(JSON.stringify(t.ppeItems)));
    setEditPrepared(JSON.parse(JSON.stringify(t.preparedItems)));
  }, []);

  // JSA Mode handler
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

  // Format phone as (XXX) XXX-XXXX while typing
  const formatPhone = (value: string): string => {
    const digits = value.replace(/\D/g, '').slice(0, 10);
    if (digits.length <= 3) return digits;
    if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  };

  // Contact helpers
  const addContact = (type: 'emergency' | 'company') => {
    const setter = type === 'emergency' ? setEmergencyContacts : setCompanyContacts;
    setter(prev => [...prev, { label: '', phone: '' }]);
    setContactsDirty(true);
  };
  const removeContact = (type: 'emergency' | 'company', idx: number) => {
    const setter = type === 'emergency' ? setEmergencyContacts : setCompanyContacts;
    setter(prev => prev.filter((_, i) => i !== idx));
    setContactsDirty(true);
  };
  const updateContact = (type: 'emergency' | 'company', idx: number, field: 'label' | 'phone', value: string) => {
    const setter = type === 'emergency' ? setEmergencyContacts : setCompanyContacts;
    const formatted = field === 'phone' ? formatPhone(value) : value;
    setter(prev => prev.map((c, i) => i === idx ? { ...c, [field]: formatted } : c));
    setContactsDirty(true);
  };
  const saveContacts = async () => {
    setSaving(true);
    try {
      // Filter out empty rows
      const ec = emergencyContacts.filter(c => c.label.trim() || c.phone.trim());
      const cc = companyContacts.filter(c => c.label.trim() || c.phone.trim());
      await updateCompanyFields(company.id, { emergencyContacts: ec, companyContacts: cc });
      setEmergencyContacts(ec);
      setCompanyContacts(cc);
      setContactsDirty(false);
      onSave();
    } catch (err) {
      console.error('Failed to save contacts:', err);
    } finally {
      setSaving(false);
    }
  };

  // Toggle expand/collapse
  const toggleExpand = (id: string) => {
    if (editingId) return; // don't collapse while editing
    setExpandedId(prev => prev === id ? null : id);
  };

  // Start editing a template
  const startEdit = (t: JsaTemplate) => {
    populateEdit(t);
    setEditingId(t.id);
    setExpandedId(t.id);
  };

  // Cancel editing
  const cancelEdit = () => {
    setEditingId(null);
  };

  // PDF Upload handler — creates a NEW template
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setErrorMessage('Please upload a PDF file');
      return;
    }

    setErrorMessage(null);
    setUploadState('parsing');

    try {
      const parsed = await uploadAndParseJsaPdf(company.id, file);

      // Use filename (without extension) as template name
      const friendlyName = file.name.replace(/\.pdf$/i, '').replace(/[_-]/g, ' ');
      const newId = await saveJsaTemplate(company.id, null, {
        name: friendlyName,
        steps: parsed.steps,
        ppeItems: parsed.ppeItems,
        preparedItems: parsed.preparedItems,
        sourceFile: { storagePath: parsed.storagePath, storageUrl: parsed.storageUrl, fileName: file.name },
        status: 'draft',
      }, 'admin');

      await refreshTemplates();
      setExpandedId(newId);
      setUploadState('idle');

      // Auto-enter edit mode on the new template
      const fresh = (await loadJsaTemplates(company.id)).find(t => t.id === newId);
      if (fresh) startEdit(fresh);
    } catch (err: any) {
      console.error('JSA parse failed:', err);
      setErrorMessage(err?.message || 'Failed to process PDF');
      setUploadState('error');
    }

    // Reset file input
    e.target.value = '';
  };

  // Save edits
  const handleSave = async () => {
    if (!editingId) return;
    setSaving(true);
    try {
      await saveJsaTemplate(company.id, editingId, {
        name: editName,
        packageId: editPackageId || undefined,
        steps: editSteps,
        ppeItems: editPpe,
        preparedItems: editPrepared,
      }, 'admin');
      await refreshTemplates();
      setEditingId(null);
    } catch (err) {
      console.error('Failed to save template:', err);
    } finally {
      setSaving(false);
    }
  };

  // Activate
  const handleActivate = async (templateId: string) => {
    setSaving(true);
    try {
      // If currently editing this one, save first
      if (editingId === templateId) {
        await saveJsaTemplate(company.id, templateId, {
          name: editName,
          packageId: editPackageId || undefined,
          steps: editSteps,
          ppeItems: editPpe,
          preparedItems: editPrepared,
        }, 'admin');
      }
      await activateJsaTemplate(company.id, templateId, 'admin');
      await refreshTemplates();
      setEditingId(null);
      onSave();
    } catch (err) {
      console.error('Failed to activate template:', err);
    } finally {
      setSaving(false);
    }
  };

  // Deactivate
  const handleDeactivate = async (templateId: string) => {
    setSaving(true);
    try {
      await deactivateJsaTemplate(company.id, templateId);
      await refreshTemplates();
      onSave();
    } catch (err) {
      console.error('Failed to deactivate template:', err);
    } finally {
      setSaving(false);
    }
  };

  // Delete
  const handleDelete = async (templateId: string) => {
    setSaving(true);
    try {
      await deleteJsaTemplate(company.id, templateId);
      await refreshTemplates();
      if (expandedId === templateId) setExpandedId(null);
      if (editingId === templateId) setEditingId(null);
      setConfirmDeleteId(null);
    } catch (err) {
      console.error('Failed to delete template:', err);
    } finally {
      setSaving(false);
    }
  };

  // Re-upload PDF for existing template
  const handleReupload = async (templateId: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !file.name.toLowerCase().endsWith('.pdf')) return;

    setErrorMessage(null);
    setUploadState('parsing');
    setExpandedId(templateId);

    try {
      const parsed = await uploadAndParseJsaPdf(company.id, file);
      const friendlyName = file.name.replace(/\.pdf$/i, '').replace(/[_-]/g, ' ');
      await saveJsaTemplate(company.id, templateId, {
        name: friendlyName,
        steps: parsed.steps,
        ppeItems: parsed.ppeItems,
        preparedItems: parsed.preparedItems,
        sourceFile: { storagePath: parsed.storagePath, storageUrl: parsed.storageUrl, fileName: file.name },
      }, 'admin');
      await refreshTemplates();
      const fresh = (await loadJsaTemplates(company.id)).find(t => t.id === templateId);
      if (fresh) startEdit(fresh);
      setUploadState('idle');
    } catch (err: any) {
      console.error('JSA re-upload failed:', err);
      setErrorMessage(err?.message || 'Failed to process PDF');
      setUploadState('error');
    }

    e.target.value = '';
  };

  // ── Step editing helpers ──

  const updateStepTitle = (stepIdx: number, title: string) => {
    setEditSteps(prev => prev.map((s, i) => i === stepIdx ? { ...s, title } : s));
  };

  const updateHazard = (stepIdx: number, itemIdx: number, field: 'hazard' | 'controls', value: string) => {
    setEditSteps(prev => prev.map((s, i) => {
      if (i !== stepIdx) return s;
      const items = s.items.map((item, j) => j === itemIdx ? { ...item, [field]: value } : item);
      return { ...s, items };
    }));
  };

  const addHazard = (stepIdx: number) => {
    setEditSteps(prev => prev.map((s, i) => {
      if (i !== stepIdx) return s;
      return { ...s, items: [...s.items, { hazard: '', controls: '' }] };
    }));
  };

  const removeHazard = (stepIdx: number, itemIdx: number) => {
    setEditSteps(prev => prev.map((s, i) => {
      if (i !== stepIdx) return s;
      return { ...s, items: s.items.filter((_, j) => j !== itemIdx) };
    }));
  };

  const addStep = () => {
    const id = `step-${Date.now()}`;
    setEditSteps(prev => [...prev, { id, title: '', items: [{ hazard: '', controls: '' }] }]);
  };

  const removeStep = (stepIdx: number) => {
    setEditSteps(prev => prev.filter((_, i) => i !== stepIdx));
  };

  const moveStep = (stepIdx: number, direction: -1 | 1) => {
    const newIdx = stepIdx + direction;
    if (newIdx < 0 || newIdx >= editSteps.length) return;
    setEditSteps(prev => {
      const arr = [...prev];
      [arr[stepIdx], arr[newIdx]] = [arr[newIdx], arr[stepIdx]];
      return arr;
    });
  };

  // ── PPE/Prepared editing helpers ──

  const updatePpeLabel = (idx: number, label: string) => {
    setEditPpe(prev => prev.map((p, i) => i === idx ? { ...p, label } : p));
  };
  const addPpeItem = () => {
    setEditPpe(prev => [...prev, { id: `ppe-${Date.now()}`, label: '' }]);
  };
  const removePpeItem = (idx: number) => {
    setEditPpe(prev => prev.filter((_, i) => i !== idx));
  };
  const updatePreparedLabel = (idx: number, label: string) => {
    setEditPrepared(prev => prev.map((p, i) => i === idx ? { ...p, label } : p));
  };
  const addPreparedItem = () => {
    setEditPrepared(prev => [...prev, { id: `prep-${Date.now()}`, label: '' }]);
  };
  const removePreparedItem = (idx: number) => {
    setEditPrepared(prev => prev.filter((_, i) => i !== idx));
  };

  // Get friendly package name
  const packageLabel = (pkgId?: string) => {
    if (!pkgId) return 'Default (all packages)';
    return pkgId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  };

  // ── Render a single template card ──
  const renderTemplate = (t: JsaTemplate) => {
    const isExpanded = expandedId === t.id;
    const isEditing = editingId === t.id;
    const isActive = t.status === 'active';

    return (
      <div key={t.id} className="bg-gray-700/50 rounded-lg overflow-hidden">
        {/* Collapsed header — always visible */}
        <button
          onClick={() => toggleExpand(t.id)}
          className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-700/80 transition-colors"
        >
          <span className={`text-gray-400 text-xs transition-transform ${isExpanded ? 'rotate-90' : ''}`}>
            &#9654;
          </span>
          <span className="text-white text-sm font-medium flex-1 truncate">{t.name}</span>
          {t.packageId && (
            <span className="px-2 py-0.5 text-[10px] rounded bg-blue-900/40 text-blue-400 border border-blue-500/30">
              {packageLabel(t.packageId)}
            </span>
          )}
          {!t.packageId && (
            <span className="px-2 py-0.5 text-[10px] rounded bg-gray-600 text-gray-400">
              Default
            </span>
          )}
          {isActive ? (
            <span className="px-2 py-0.5 text-xs rounded bg-green-900/40 text-green-400 border border-green-500/30">
              Active
            </span>
          ) : (
            <span className="px-2 py-0.5 text-xs rounded bg-yellow-900/40 text-yellow-400 border border-yellow-500/30">
              Draft
            </span>
          )}
          <span className="text-gray-500 text-xs">{t.steps.length} steps</span>
        </button>

        {/* Expanded content */}
        {isExpanded && (
          <div className="px-4 pb-4 space-y-4 border-t border-gray-600/50">
            {/* Template Name */}
            <div className="mt-3">
              <label className="text-gray-400 text-xs block mb-1">Template Name</label>
              {isEditing ? (
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full bg-gray-700 text-white text-sm rounded px-3 py-2 border border-gray-600 focus:border-red-400 outline-none"
                />
              ) : (
                <div className="text-white text-sm">{t.name}</div>
              )}
            </div>

            {/* Package Assignment */}
            <div>
              <label className="text-gray-400 text-xs block mb-1">Assigned Package</label>
              {isEditing ? (
                <select
                  value={editPackageId}
                  onChange={(e) => setEditPackageId(e.target.value)}
                  className="w-full bg-gray-700 text-white text-sm rounded px-3 py-2 border border-gray-600 focus:border-red-400 outline-none"
                >
                  <option value="">Default (all packages)</option>
                  {activePackages.map(pkg => (
                    <option key={pkg} value={pkg}>{packageLabel(pkg)}</option>
                  ))}
                </select>
              ) : (
                <div className="text-gray-300 text-sm">{packageLabel(t.packageId)}</div>
              )}
            </div>

            {/* Source file */}
            {t.sourceFile && (
              <div className="text-gray-500 text-xs">Source: {t.sourceFile.fileName}</div>
            )}

            {/* Steps */}
            <div>
              <div className="text-gray-400 text-xs mb-2">
                Steps ({isEditing ? editSteps.length : t.steps.length})
              </div>
              {(isEditing ? editSteps : t.steps).map((step, stepIdx) => (
                <div key={step.id || stepIdx} className="bg-gray-700 rounded-lg p-3 mb-2">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-red-400 text-xs font-bold w-6 h-6 rounded-full bg-red-900/40 flex items-center justify-center flex-shrink-0">
                      {stepIdx + 1}
                    </span>
                    {isEditing ? (
                      <input
                        type="text"
                        value={step.title}
                        onChange={(e) => updateStepTitle(stepIdx, e.target.value)}
                        placeholder="Step title"
                        className="flex-1 bg-gray-600 text-white text-sm rounded px-2 py-1 border border-gray-500 focus:border-red-400 outline-none"
                      />
                    ) : (
                      <span className="text-white text-sm font-medium flex-1">{step.title}</span>
                    )}
                    {isEditing && (
                      <div className="flex gap-1 flex-shrink-0">
                        <button onClick={() => moveStep(stepIdx, -1)} disabled={stepIdx === 0}
                          className="text-gray-400 hover:text-white text-xs px-1 disabled:opacity-30" title="Move up">&#9650;</button>
                        <button onClick={() => moveStep(stepIdx, 1)} disabled={stepIdx === editSteps.length - 1}
                          className="text-gray-400 hover:text-white text-xs px-1 disabled:opacity-30" title="Move down">&#9660;</button>
                        <button onClick={() => removeStep(stepIdx)}
                          className="text-red-500 hover:text-red-400 text-xs px-1 ml-1" title="Remove step">&#10005;</button>
                      </div>
                    )}
                  </div>

                  {step.items.map((item, itemIdx) => (
                    <div key={itemIdx} className="ml-8 mb-2 last:mb-0">
                      {isEditing ? (
                        <div className="space-y-1">
                          <div className="flex items-start gap-2">
                            <div className="flex-1">
                              <label className="text-gray-500 text-[10px] uppercase">Hazard</label>
                              <textarea value={item.hazard} onChange={(e) => updateHazard(stepIdx, itemIdx, 'hazard', e.target.value)}
                                rows={2} className="w-full bg-gray-600 text-white text-xs rounded px-2 py-1 border border-gray-500 focus:border-red-400 outline-none resize-none" />
                            </div>
                            <div className="flex-1">
                              <label className="text-gray-500 text-[10px] uppercase">Controls</label>
                              <textarea value={item.controls} onChange={(e) => updateHazard(stepIdx, itemIdx, 'controls', e.target.value)}
                                rows={2} className="w-full bg-gray-600 text-white text-xs rounded px-2 py-1 border border-gray-500 focus:border-red-400 outline-none resize-none" />
                            </div>
                            <button onClick={() => removeHazard(stepIdx, itemIdx)}
                              className="text-red-500 hover:text-red-400 text-xs mt-4 flex-shrink-0" title="Remove hazard">&#10005;</button>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-1">
                          <div className="text-xs">
                            <span className="text-yellow-400/80">Hazard:</span>{' '}
                            <span className="text-gray-300">{item.hazard}</span>
                          </div>
                          <div className="text-xs">
                            <span className="text-green-400/80">Controls:</span>{' '}
                            <span className="text-gray-300">{item.controls}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}

                  {isEditing && (
                    <button onClick={() => addHazard(stepIdx)}
                      className="ml-8 text-gray-500 hover:text-gray-300 text-xs mt-1">+ Add Hazard</button>
                  )}
                </div>
              ))}

              {isEditing && (
                <button onClick={addStep}
                  className="w-full border border-dashed border-gray-600 rounded-lg py-2 text-gray-500 hover:text-gray-300 hover:border-gray-400 text-xs transition-colors">+ Add Step</button>
              )}
            </div>

            {/* PPE Items */}
            <div>
              <div className="text-gray-400 text-xs mb-2">
                PPE Items ({isEditing ? editPpe.length : t.ppeItems.length})
              </div>
              <div className="bg-gray-700 rounded-lg p-3">
                {(isEditing ? editPpe : t.ppeItems).map((item, idx) => (
                  <div key={item.id || idx} className="flex items-center gap-2 mb-1 last:mb-0">
                    <span className="text-gray-500 text-xs w-4">{idx + 1}.</span>
                    {isEditing ? (
                      <>
                        <input type="text" value={item.label} onChange={(e) => updatePpeLabel(idx, e.target.value)}
                          placeholder="PPE item" className="flex-1 bg-gray-600 text-white text-xs rounded px-2 py-1 border border-gray-500 focus:border-red-400 outline-none" />
                        <button onClick={() => removePpeItem(idx)} className="text-red-500 hover:text-red-400 text-xs">&#10005;</button>
                      </>
                    ) : (
                      <span className="text-gray-300 text-xs">{item.label}</span>
                    )}
                  </div>
                ))}
                {isEditing && (
                  <button onClick={addPpeItem} className="text-gray-500 hover:text-gray-300 text-xs mt-2">+ Add PPE Item</button>
                )}
              </div>
            </div>

            {/* Prepared Items */}
            <div>
              <div className="text-gray-400 text-xs mb-2">
                Pre-Job Checklist ({isEditing ? editPrepared.length : t.preparedItems.length})
              </div>
              <div className="bg-gray-700 rounded-lg p-3">
                {(isEditing ? editPrepared : t.preparedItems).map((item, idx) => (
                  <div key={item.id || idx} className="flex items-center gap-2 mb-1 last:mb-0">
                    <span className="text-gray-500 text-xs">&#9745;</span>
                    {isEditing ? (
                      <>
                        <input type="text" value={item.label} onChange={(e) => updatePreparedLabel(idx, e.target.value)}
                          placeholder="Checklist item" className="flex-1 bg-gray-600 text-white text-xs rounded px-2 py-1 border border-gray-500 focus:border-red-400 outline-none" />
                        <button onClick={() => removePreparedItem(idx)} className="text-red-500 hover:text-red-400 text-xs">&#10005;</button>
                      </>
                    ) : (
                      <span className="text-gray-300 text-xs">{item.label}</span>
                    )}
                  </div>
                ))}
                {isEditing && (
                  <button onClick={addPreparedItem} className="text-gray-500 hover:text-gray-300 text-xs mt-2">+ Add Checklist Item</button>
                )}
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex flex-wrap gap-2 pt-2">
              {isEditing ? (
                <>
                  <button onClick={handleSave} disabled={saving}
                    className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white text-sm rounded-lg transition-colors disabled:opacity-50">Save Draft</button>
                  <button onClick={() => handleActivate(t.id)} disabled={saving}
                    className="px-4 py-2 bg-green-700 hover:bg-green-600 text-white text-sm rounded-lg transition-colors disabled:opacity-50">Activate</button>
                  <button onClick={cancelEdit}
                    className="px-4 py-2 text-gray-400 hover:text-white text-sm transition-colors">Cancel</button>
                </>
              ) : (
                <>
                  <button onClick={() => startEdit(t)} className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white text-sm rounded-lg transition-colors">Edit</button>
                  {isActive ? (
                    <button onClick={() => handleDeactivate(t.id)} disabled={saving}
                      className="px-4 py-2 bg-red-900/40 hover:bg-red-900/60 text-red-400 text-sm rounded-lg border border-red-500/30 transition-colors disabled:opacity-50">Deactivate</button>
                  ) : (
                    <>
                      <button onClick={() => handleActivate(t.id)} disabled={saving}
                        className="px-4 py-2 bg-green-700 hover:bg-green-600 text-white text-sm rounded-lg transition-colors disabled:opacity-50">Activate</button>
                      {confirmDeleteId === t.id ? (
                        <div className="flex items-center gap-2">
                          <span className="text-red-400 text-xs">Delete this template?</span>
                          <button onClick={() => handleDelete(t.id)} disabled={saving}
                            className="px-3 py-1 bg-red-700 hover:bg-red-600 text-white text-xs rounded transition-colors disabled:opacity-50">Yes, Delete</button>
                          <button onClick={() => setConfirmDeleteId(null)}
                            className="px-3 py-1 text-gray-400 hover:text-white text-xs transition-colors">No</button>
                        </div>
                      ) : (
                        <button onClick={() => setConfirmDeleteId(t.id)}
                          className="px-4 py-2 text-red-500 hover:text-red-400 text-sm transition-colors">Delete</button>
                      )}
                    </>
                  )}
                </>
              )}
              <label className="px-4 py-2 text-gray-400 hover:text-white text-sm cursor-pointer transition-colors ml-auto">
                Re-upload PDF
                <input type="file" accept=".pdf" onChange={(e) => handleReupload(t.id, e)} className="hidden" />
              </label>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="bg-gray-800 rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-red-500/30 bg-red-900/20">
        <h3 className="text-red-400 font-medium text-sm">Job Safety Analysis (JSA)</h3>
      </div>

      {/* Section A: JSA Mode */}
      <div className="p-4 space-y-3 border-b border-gray-700">
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
                currentMode === mode.value ? 'border-red-400' : 'border-gray-600'
              }`}>
                {currentMode === mode.value && <div className="w-2 h-2 rounded-full bg-red-400" />}
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

      {/* Section B: JSA Contacts */}
      <div className="p-4 space-y-4 border-b border-gray-700">
        <div className="text-gray-300 text-sm font-medium">JSA Contacts</div>
        <div className="text-gray-500 text-xs">
          Contacts displayed on the JSA sign-off screen. Drivers see these when completing a JSA.
        </div>

        {/* Emergency Contacts */}
        <div className="space-y-2">
          <div className="text-gray-400 text-xs font-medium uppercase tracking-wide">Emergency Contacts</div>
          {emergencyContacts.map((c, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="text"
                placeholder="Name / Label"
                value={c.label}
                onChange={e => updateContact('emergency', i, 'label', e.target.value)}
                className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-white placeholder-gray-600 focus:border-red-500 outline-none"
              />
              <input
                type="text"
                placeholder="Phone"
                value={c.phone}
                onChange={e => updateContact('emergency', i, 'phone', e.target.value)}
                className="w-36 bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-white placeholder-gray-600 focus:border-red-500 outline-none"
              />
              <button onClick={() => removeContact('emergency', i)} className="text-gray-600 hover:text-red-400 text-lg px-1">×</button>
            </div>
          ))}
          <button onClick={() => addContact('emergency')} className="text-red-400 text-xs hover:underline">
            + Add Emergency Contact
          </button>
        </div>

        {/* Company Contacts */}
        <div className="space-y-2">
          <div className="text-gray-400 text-xs font-medium uppercase tracking-wide">Company Contacts</div>
          {companyContacts.map((c, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="text"
                placeholder="Name / Label"
                value={c.label}
                onChange={e => updateContact('company', i, 'label', e.target.value)}
                className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-white placeholder-gray-600 focus:border-red-500 outline-none"
              />
              <input
                type="text"
                placeholder="Phone"
                value={c.phone}
                onChange={e => updateContact('company', i, 'phone', e.target.value)}
                className="w-36 bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-white placeholder-gray-600 focus:border-red-500 outline-none"
              />
              <button onClick={() => removeContact('company', i)} className="text-gray-600 hover:text-red-400 text-lg px-1">×</button>
            </div>
          ))}
          <button onClick={() => addContact('company')} className="text-red-400 text-xs hover:underline">
            + Add Company Contact
          </button>
        </div>

        {/* Save button */}
        {contactsDirty && (
          <button
            onClick={saveContacts}
            disabled={saving}
            className="bg-red-600 hover:bg-red-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save Contacts'}
          </button>
        )}
      </div>

      {/* Section C: Custom JSA Templates */}
      <div className="p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-gray-300 text-sm font-medium">Custom JSA Templates</div>
          <span className="text-gray-500 text-xs">{templates.length} template{templates.length !== 1 ? 's' : ''}</span>
        </div>

        {templateLoading && (
          <div className="text-gray-500 text-xs py-4 text-center">Loading templates...</div>
        )}

        {/* Upload/Parse progress */}
        {(uploadState === 'uploading' || uploadState === 'parsing') && (
          <div className="py-8 text-center space-y-3">
            <div className="inline-block w-6 h-6 border-2 border-red-400 border-t-transparent rounded-full animate-spin" />
            <div className="text-gray-300 text-sm">
              {uploadState === 'uploading' ? 'Uploading PDF...' : 'Analyzing with AI... This may take up to 30 seconds'}
            </div>
          </div>
        )}

        {/* Error */}
        {uploadState === 'error' && errorMessage && (
          <div className="bg-red-900/20 border border-red-500/30 rounded-lg p-3 text-red-400 text-xs">
            {errorMessage}
            <button onClick={() => { setUploadState('idle'); setErrorMessage(null); }}
              className="ml-2 underline">Dismiss</button>
          </div>
        )}

        {/* Template list */}
        {!templateLoading && uploadState === 'idle' && (
          <div className="space-y-2">
            {templates.map(renderTemplate)}
          </div>
        )}

        {/* Upload new JSA button — always visible */}
        {!templateLoading && uploadState === 'idle' && (
          <label className="block w-full border-2 border-dashed border-gray-600 rounded-lg py-4 text-center cursor-pointer hover:border-gray-400 transition-colors">
            <span className="text-gray-400 text-sm">
              {templates.length === 0
                ? 'Upload your JSA document and we\'ll extract the steps, hazards, and controls automatically.'
                : '+ Upload Another JSA PDF'}
            </span>
            <input type="file" accept=".pdf" onChange={handleFileUpload} className="hidden" />
          </label>
        )}
      </div>
    </div>
  );
}
