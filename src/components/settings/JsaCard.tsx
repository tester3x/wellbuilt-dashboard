'use client';

import { useState, useEffect, useCallback } from 'react';
import { type CompanyConfig, updateCompanyFields } from '@/lib/companySettings';
import {
  type JsaTemplate,
  type JsaTemplateStep,
  type JsaPpeItem,
  type JsaPreparedItem,
  uploadJsaPdf,
  callParseJsaPdf,
  saveJsaTemplate,
  loadJsaTemplate,
  activateJsaTemplate,
  deactivateJsaTemplate,
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

  // Template state
  const [template, setTemplate] = useState<JsaTemplate | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [uploadState, setUploadState] = useState<UploadState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [templateLoading, setTemplateLoading] = useState(true);

  // Editing state (local copy for edits before save)
  const [editName, setEditName] = useState('');
  const [editSteps, setEditSteps] = useState<JsaTemplateStep[]>([]);
  const [editPpe, setEditPpe] = useState<JsaPpeItem[]>([]);
  const [editPrepared, setEditPrepared] = useState<JsaPreparedItem[]>([]);

  // Load existing template on mount
  useEffect(() => {
    setTemplateLoading(true);
    loadJsaTemplate(company.id).then((t) => {
      setTemplate(t);
      if (t) {
        setEditName(t.name);
        setEditSteps(t.steps);
        setEditPpe(t.ppeItems);
        setEditPrepared(t.preparedItems);
      }
    }).catch(console.error).finally(() => setTemplateLoading(false));
  }, [company.id]);

  // Populate edit fields from template
  const populateEdit = useCallback((data: { name: string; steps: JsaTemplateStep[]; ppeItems: JsaPpeItem[]; preparedItems: JsaPreparedItem[] }) => {
    setEditName(data.name);
    setEditSteps(JSON.parse(JSON.stringify(data.steps)));
    setEditPpe(JSON.parse(JSON.stringify(data.ppeItems)));
    setEditPrepared(JSON.parse(JSON.stringify(data.preparedItems)));
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

  // PDF Upload + Parse handler
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setErrorMessage('Please upload a PDF file');
      return;
    }

    setErrorMessage(null);
    setUploadState('uploading');

    try {
      const { storagePath, storageUrl } = await uploadJsaPdf(company.id, file);
      setUploadState('parsing');

      const parsed = await callParseJsaPdf(storagePath, company.id);
      populateEdit(parsed);

      // Save as draft immediately with source file info
      await saveJsaTemplate(company.id, {
        name: parsed.name,
        steps: parsed.steps,
        ppeItems: parsed.ppeItems,
        preparedItems: parsed.preparedItems,
        sourceFile: { storagePath, storageUrl, fileName: file.name },
        status: 'draft',
      }, 'admin');

      const fresh = await loadJsaTemplate(company.id);
      setTemplate(fresh);
      setEditMode(true);
      setUploadState('idle');
    } catch (err: any) {
      console.error('JSA parse failed:', err);
      setErrorMessage(err?.message || 'Failed to process PDF');
      setUploadState('error');
    }
  };

  // Save edits
  const handleSave = async () => {
    setSaving(true);
    try {
      await saveJsaTemplate(company.id, {
        name: editName,
        steps: editSteps,
        ppeItems: editPpe,
        preparedItems: editPrepared,
      }, 'admin');
      const fresh = await loadJsaTemplate(company.id);
      setTemplate(fresh);
      setEditMode(false);
    } catch (err) {
      console.error('Failed to save template:', err);
    } finally {
      setSaving(false);
    }
  };

  // Activate
  const handleActivate = async () => {
    setSaving(true);
    try {
      // Save current edits first
      await saveJsaTemplate(company.id, {
        name: editName,
        steps: editSteps,
        ppeItems: editPpe,
        preparedItems: editPrepared,
      }, 'admin');
      await activateJsaTemplate(company.id, 'admin');
      const fresh = await loadJsaTemplate(company.id);
      setTemplate(fresh);
      setEditMode(false);
      onSave();
    } catch (err) {
      console.error('Failed to activate template:', err);
    } finally {
      setSaving(false);
    }
  };

  // Deactivate
  const handleDeactivate = async () => {
    setSaving(true);
    try {
      await deactivateJsaTemplate(company.id);
      const fresh = await loadJsaTemplate(company.id);
      setTemplate(fresh);
      if (fresh) populateEdit(fresh);
      onSave();
    } catch (err) {
      console.error('Failed to deactivate template:', err);
    } finally {
      setSaving(false);
    }
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

  // Is template active?
  const isActive = template?.status === 'active';
  // Are we viewing (not editing)?
  const isViewing = template && !editMode;

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

      {/* Section B: Custom JSA Template */}
      <div className="p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-gray-300 text-sm font-medium">Custom JSA Template</div>
          {isActive && (
            <span className="px-2 py-0.5 text-xs rounded bg-green-900/40 text-green-400 border border-green-500/30">
              Active v{template.version}
            </span>
          )}
          {template && template.status === 'draft' && (
            <span className="px-2 py-0.5 text-xs rounded bg-yellow-900/40 text-yellow-400 border border-yellow-500/30">
              Draft
            </span>
          )}
        </div>

        {templateLoading && (
          <div className="text-gray-500 text-xs py-4 text-center">Loading template...</div>
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
            <button
              onClick={() => { setUploadState('idle'); setErrorMessage(null); }}
              className="ml-2 underline"
            >Dismiss</button>
          </div>
        )}

        {/* No template yet — upload prompt */}
        {!templateLoading && !template && uploadState === 'idle' && (
          <div className="border-2 border-dashed border-gray-600 rounded-lg p-6 text-center">
            <div className="text-gray-400 text-sm mb-3">
              Upload your existing JSA document and we'll extract the steps, hazards, and controls automatically.
            </div>
            <label className="inline-block px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm rounded-lg cursor-pointer transition-colors">
              Upload JSA PDF
              <input
                type="file"
                accept=".pdf"
                onChange={handleFileUpload}
                className="hidden"
              />
            </label>
          </div>
        )}

        {/* Template viewing/editing */}
        {!templateLoading && template && uploadState === 'idle' && (
          <>
            {/* Template Name */}
            <div>
              <label className="text-gray-400 text-xs block mb-1">Template Name</label>
              {editMode ? (
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full bg-gray-700 text-white text-sm rounded px-3 py-2 border border-gray-600 focus:border-red-400 outline-none"
                />
              ) : (
                <div className="text-white text-sm">{template.name}</div>
              )}
            </div>

            {/* Source file */}
            {template.sourceFile && (
              <div className="text-gray-500 text-xs">
                Source: {template.sourceFile.fileName}
              </div>
            )}

            {/* Steps */}
            <div>
              <div className="text-gray-400 text-xs mb-2">
                Steps ({editMode ? editSteps.length : template.steps.length})
              </div>
              {(editMode ? editSteps : template.steps).map((step, stepIdx) => (
                <div key={step.id || stepIdx} className="bg-gray-700 rounded-lg p-3 mb-2">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-red-400 text-xs font-bold w-6 h-6 rounded-full bg-red-900/40 flex items-center justify-center flex-shrink-0">
                      {stepIdx + 1}
                    </span>
                    {editMode ? (
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
                    {editMode && (
                      <div className="flex gap-1 flex-shrink-0">
                        <button
                          onClick={() => moveStep(stepIdx, -1)}
                          disabled={stepIdx === 0}
                          className="text-gray-400 hover:text-white text-xs px-1 disabled:opacity-30"
                          title="Move up"
                        >&#9650;</button>
                        <button
                          onClick={() => moveStep(stepIdx, 1)}
                          disabled={stepIdx === editSteps.length - 1}
                          className="text-gray-400 hover:text-white text-xs px-1 disabled:opacity-30"
                          title="Move down"
                        >&#9660;</button>
                        <button
                          onClick={() => removeStep(stepIdx)}
                          className="text-red-500 hover:text-red-400 text-xs px-1 ml-1"
                          title="Remove step"
                        >&#10005;</button>
                      </div>
                    )}
                  </div>

                  {step.items.map((item, itemIdx) => (
                    <div key={itemIdx} className="ml-8 mb-2 last:mb-0">
                      {editMode ? (
                        <div className="space-y-1">
                          <div className="flex items-start gap-2">
                            <div className="flex-1">
                              <label className="text-gray-500 text-[10px] uppercase">Hazard</label>
                              <textarea
                                value={item.hazard}
                                onChange={(e) => updateHazard(stepIdx, itemIdx, 'hazard', e.target.value)}
                                rows={2}
                                className="w-full bg-gray-600 text-white text-xs rounded px-2 py-1 border border-gray-500 focus:border-red-400 outline-none resize-none"
                              />
                            </div>
                            <div className="flex-1">
                              <label className="text-gray-500 text-[10px] uppercase">Controls</label>
                              <textarea
                                value={item.controls}
                                onChange={(e) => updateHazard(stepIdx, itemIdx, 'controls', e.target.value)}
                                rows={2}
                                className="w-full bg-gray-600 text-white text-xs rounded px-2 py-1 border border-gray-500 focus:border-red-400 outline-none resize-none"
                              />
                            </div>
                            <button
                              onClick={() => removeHazard(stepIdx, itemIdx)}
                              className="text-red-500 hover:text-red-400 text-xs mt-4 flex-shrink-0"
                              title="Remove hazard"
                            >&#10005;</button>
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

                  {editMode && (
                    <button
                      onClick={() => addHazard(stepIdx)}
                      className="ml-8 text-gray-500 hover:text-gray-300 text-xs mt-1"
                    >+ Add Hazard</button>
                  )}
                </div>
              ))}

              {editMode && (
                <button
                  onClick={addStep}
                  className="w-full border border-dashed border-gray-600 rounded-lg py-2 text-gray-500 hover:text-gray-300 hover:border-gray-400 text-xs transition-colors"
                >+ Add Step</button>
              )}
            </div>

            {/* PPE Items */}
            <div>
              <div className="text-gray-400 text-xs mb-2">
                PPE Items ({editMode ? editPpe.length : template.ppeItems.length})
              </div>
              <div className="bg-gray-700 rounded-lg p-3">
                {(editMode ? editPpe : template.ppeItems).map((item, idx) => (
                  <div key={item.id || idx} className="flex items-center gap-2 mb-1 last:mb-0">
                    <span className="text-gray-500 text-xs w-4">{idx + 1}.</span>
                    {editMode ? (
                      <>
                        <input
                          type="text"
                          value={item.label}
                          onChange={(e) => updatePpeLabel(idx, e.target.value)}
                          placeholder="PPE item"
                          className="flex-1 bg-gray-600 text-white text-xs rounded px-2 py-1 border border-gray-500 focus:border-red-400 outline-none"
                        />
                        <button
                          onClick={() => removePpeItem(idx)}
                          className="text-red-500 hover:text-red-400 text-xs"
                        >&#10005;</button>
                      </>
                    ) : (
                      <span className="text-gray-300 text-xs">{item.label}</span>
                    )}
                  </div>
                ))}
                {editMode && (
                  <button
                    onClick={addPpeItem}
                    className="text-gray-500 hover:text-gray-300 text-xs mt-2"
                  >+ Add PPE Item</button>
                )}
              </div>
            </div>

            {/* Prepared Items */}
            <div>
              <div className="text-gray-400 text-xs mb-2">
                Pre-Job Checklist ({editMode ? editPrepared.length : template.preparedItems.length})
              </div>
              <div className="bg-gray-700 rounded-lg p-3">
                {(editMode ? editPrepared : template.preparedItems).map((item, idx) => (
                  <div key={item.id || idx} className="flex items-center gap-2 mb-1 last:mb-0">
                    <span className="text-gray-500 text-xs">&#9745;</span>
                    {editMode ? (
                      <>
                        <input
                          type="text"
                          value={item.label}
                          onChange={(e) => updatePreparedLabel(idx, e.target.value)}
                          placeholder="Checklist item"
                          className="flex-1 bg-gray-600 text-white text-xs rounded px-2 py-1 border border-gray-500 focus:border-red-400 outline-none"
                        />
                        <button
                          onClick={() => removePreparedItem(idx)}
                          className="text-red-500 hover:text-red-400 text-xs"
                        >&#10005;</button>
                      </>
                    ) : (
                      <span className="text-gray-300 text-xs">{item.label}</span>
                    )}
                  </div>
                ))}
                {editMode && (
                  <button
                    onClick={addPreparedItem}
                    className="text-gray-500 hover:text-gray-300 text-xs mt-2"
                  >+ Add Checklist Item</button>
                )}
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex flex-wrap gap-2 pt-2">
              {editMode ? (
                <>
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
                  >Save Draft</button>
                  <button
                    onClick={handleActivate}
                    disabled={saving}
                    className="px-4 py-2 bg-green-700 hover:bg-green-600 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
                  >Activate</button>
                  <button
                    onClick={() => {
                      if (template) populateEdit(template);
                      setEditMode(false);
                    }}
                    className="px-4 py-2 text-gray-400 hover:text-white text-sm transition-colors"
                  >Cancel</button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => {
                      if (template) populateEdit(template);
                      setEditMode(true);
                    }}
                    className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white text-sm rounded-lg transition-colors"
                  >Edit</button>
                  {isActive ? (
                    <button
                      onClick={handleDeactivate}
                      disabled={saving}
                      className="px-4 py-2 bg-red-900/40 hover:bg-red-900/60 text-red-400 text-sm rounded-lg border border-red-500/30 transition-colors disabled:opacity-50"
                    >Deactivate</button>
                  ) : (
                    <button
                      onClick={handleActivate}
                      disabled={saving}
                      className="px-4 py-2 bg-green-700 hover:bg-green-600 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
                    >Activate</button>
                  )}
                </>
              )}

              {/* Re-upload always available */}
              <label className="px-4 py-2 text-gray-400 hover:text-white text-sm cursor-pointer transition-colors ml-auto">
                Re-upload PDF
                <input
                  type="file"
                  accept=".pdf"
                  onChange={handleFileUpload}
                  className="hidden"
                />
              </label>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
