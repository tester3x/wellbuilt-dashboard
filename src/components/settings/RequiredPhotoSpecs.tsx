'use client';

import { useEffect, useState, useCallback } from 'react';
import { type CompanyConfig } from '@/lib/companySettings';
import {
  type PhotoRequirement,
  type PhotoPhase,
  customerIdForOperator,
  loadPhotoRequirementSpec,
  savePhotoRequirementSpec,
  uploadRequirementSample,
  suggestPhotoCriteria,
} from '@/lib/photoRequirements';

interface Props {
  company: CompanyConfig;
}

function genId(): string {
  return 'r' + Math.random().toString(36).slice(2, 9);
}

function blankReq(): PhotoRequirement {
  return { id: genId(), label: '', description: '', threshold: 80, requiredCount: 1, phase: 'any', active: true };
}

/**
 * Per-customer (operator) required-photo specs. Writes photo_requirements/{cid}
 * — the same doc the validatePhotoCompliance CF + WB T read. Replaces the seed
 * script for day-to-day configuration.
 */
export function RequiredPhotoSpecs({ company }: Props) {
  const operators = company.assignedOperators || [];
  const [operator, setOperator] = useState<string>(operators[0] || '');
  const [enabled, setEnabled] = useState(true);
  const [reqs, setReqs] = useState<PhotoRequirement[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const [suggestingId, setSuggestingId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [savedMsg, setSavedMsg] = useState('');

  const customerId = customerIdForOperator(operator);

  const load = useCallback(async () => {
    if (!customerId) { setReqs([]); setEnabled(true); return; }
    setLoading(true);
    try {
      const spec = await loadPhotoRequirementSpec(customerId);
      setReqs(spec?.requirements || []);
      setEnabled(spec?.enabled !== false);
      setDirty(false);
      setSavedMsg('');
    } catch (e) {
      console.error('[RequiredPhotoSpecs] load failed:', e);
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  useEffect(() => { void load(); }, [load]);

  const patchReq = (id: string, patch: Partial<PhotoRequirement>) => {
    setReqs(rs => rs.map(r => (r.id === id ? { ...r, ...patch } : r)));
    setDirty(true);
    setSavedMsg('');
  };

  const addReq = () => { setReqs(rs => [...rs, blankReq()]); setDirty(true); setSavedMsg(''); };
  const removeReq = (id: string) => { setReqs(rs => rs.filter(r => r.id !== id)); setDirty(true); setSavedMsg(''); };

  const onPickSample = async (req: PhotoRequirement, file: File | null) => {
    if (!file || !customerId) return;
    setUploadingId(req.id);
    try {
      const { sampleStoragePath, sampleUrl } = await uploadRequirementSample(customerId, req.id, file);
      patchReq(req.id, { sampleStoragePath, sampleUrl });
    } catch (e: any) {
      console.error('[RequiredPhotoSpecs] sample upload failed:', e);
      alert('Sample upload failed: ' + (e?.message || 'unknown error'));
    } finally {
      setUploadingId(null);
    }
  };

  const onSuggest = async (req: PhotoRequirement) => {
    if (!req.sampleStoragePath && !req.sampleUrl) return;
    setSuggestingId(req.id);
    try {
      const out = await suggestPhotoCriteria({
        customerId,
        requirementId: req.id,
        sampleStoragePath: req.sampleStoragePath,
        sampleUrl: req.sampleUrl,
        label: req.label,
        phase: req.phase,
      });
      if (out?.criteria) patchReq(req.id, { description: out.criteria });
    } catch (e: any) {
      console.error('[RequiredPhotoSpecs] suggest criteria failed:', e);
      alert('Suggest criteria failed: ' + (e?.message || 'unknown error'));
    } finally {
      setSuggestingId(null);
    }
  };

  const save = async () => {
    if (!customerId) return;
    // Light validation — label required; description strongly recommended.
    const bad = reqs.find(r => !r.label.trim());
    if (bad) { alert('Every requirement needs a label.'); return; }
    setSaving(true);
    try {
      const v = await savePhotoRequirementSpec(customerId, reqs, enabled);
      setDirty(false);
      setSavedMsg(`Saved (v${v}) — drivers refresh on next job load.`);
    } catch (e: any) {
      console.error('[RequiredPhotoSpecs] save failed:', e);
      alert('Save failed: ' + (e?.message || 'unknown error'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-t border-gray-700 pt-3 mt-1">
      <div className="flex items-center justify-between mb-1">
        <div>
          <div className="text-white text-sm">Required Photo Specs</div>
          <div className="text-gray-500 text-xs">AI-checked photos a customer requires (per operator)</div>
        </div>
      </div>

      {operators.length === 0 ? (
        <div className="text-gray-500 text-xs italic mt-2">
          No operators assigned to this company yet. Assign operators in Admin → Companies to configure their required photos.
        </div>
      ) : (
        <>
          {/* Operator (customer) picker */}
          <div className="flex items-center gap-2 mt-2">
            <span className="text-gray-400 text-xs w-20">Customer</span>
            <select
              value={operator}
              onChange={(e) => setOperator(e.target.value)}
              className="flex-1 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-sm"
            >
              {operators.map(op => <option key={op} value={op}>{op}</option>)}
            </select>
          </div>

          {/* Master enable */}
          <div className="flex items-center justify-between mt-3">
            <div className="text-gray-300 text-xs">Required photos enabled for this customer</div>
            <button
              onClick={() => { setEnabled(v => !v); setDirty(true); setSavedMsg(''); }}
              className={`relative w-10 h-5 rounded-full transition-colors ${enabled ? 'bg-orange-500' : 'bg-gray-600'}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${enabled ? 'translate-x-5' : 'translate-x-0'}`} />
            </button>
          </div>

          {loading ? (
            <div className="text-gray-500 text-xs mt-3">Loading…</div>
          ) : (
            <div className="space-y-3 mt-3">
              {reqs.length === 0 && (
                <div className="text-gray-500 text-xs italic">No required photos yet. Add one below.</div>
              )}

              {reqs.map((r) => (
                <div key={r.id} className="border border-gray-700 rounded-lg p-3 bg-gray-900/40">
                  <div className="flex items-start gap-3">
                    {/* Sample thumbnail + upload */}
                    <div className="flex-shrink-0">
                      <label className="cursor-pointer block">
                        {r.sampleUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={r.sampleUrl} alt="sample" className="w-16 h-16 rounded object-cover border border-gray-600" />
                        ) : (
                          <div className="w-16 h-16 rounded border-2 border-dashed border-gray-600 flex items-center justify-center text-gray-500 text-[10px] text-center px-1">
                            {uploadingId === r.id ? 'Uploading…' : 'Add sample'}
                          </div>
                        )}
                        <input type="file" accept="image/*" className="hidden"
                          onChange={(e) => onPickSample(r, e.target.files?.[0] || null)} />
                      </label>
                      {r.sampleUrl && (
                        <label className="cursor-pointer block text-center text-orange-400 text-[10px] mt-1">
                          Replace
                          <input type="file" accept="image/*" className="hidden"
                            onChange={(e) => onPickSample(r, e.target.files?.[0] || null)} />
                        </label>
                      )}
                    </div>

                    {/* Fields */}
                    <div className="flex-1 space-y-2">
                      <div className="flex items-center gap-2">
                        <input
                          value={r.label}
                          onChange={(e) => patchReq(r.id, { label: e.target.value })}
                          placeholder="Label (e.g. Hose On)"
                          className="flex-1 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-sm"
                        />
                        <button
                          onClick={() => patchReq(r.id, { active: !r.active })}
                          title={r.active ? 'Active' : 'Inactive'}
                          className={`relative w-9 h-5 rounded-full transition-colors flex-shrink-0 ${r.active ? 'bg-green-600' : 'bg-gray-600'}`}
                        >
                          <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${r.active ? 'translate-x-4' : 'translate-x-0'}`} />
                        </button>
                        <button
                          onClick={() => removeReq(r.id)}
                          className="text-red-400/70 hover:text-red-300 text-sm flex-shrink-0 px-1"
                          title="Remove requirement"
                        >✕</button>
                      </div>

                      <textarea
                        value={r.description}
                        onChange={(e) => patchReq(r.id, { description: e.target.value })}
                        placeholder="Criteria — what must be visible (e.g. Hose visibly connected to the Getty box inlet)"
                        rows={2}
                        className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-xs resize-none"
                      />

                      {/* AI criteria drafting — only when a sample exists. Fills the
                          field; admin reviews/edits before Save. */}
                      {(r.sampleStoragePath || r.sampleUrl) && (
                        <button
                          onClick={() => onSuggest(r)}
                          disabled={suggestingId === r.id}
                          className={`text-xs font-medium ${suggestingId === r.id ? 'text-gray-500 cursor-wait' : 'text-purple-300 hover:text-purple-200'}`}
                          title="Draft criteria from the sample photo (you can edit before saving)"
                        >
                          {suggestingId === r.id ? 'Drafting…' : '✨ Suggest Criteria'}
                        </button>
                      )}

                      <div className="flex items-center gap-3 flex-wrap">
                        <label className="flex items-center gap-1 text-gray-400 text-xs">
                          Threshold
                          <input type="number" min={0} max={100} value={r.threshold}
                            onChange={(e) => patchReq(r.id, { threshold: Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0)) })}
                            className="w-14 px-1 py-0.5 bg-gray-700 border border-gray-600 rounded text-white text-xs text-center" />
                        </label>
                        <label className="flex items-center gap-1 text-gray-400 text-xs">
                          Count
                          <input type="number" min={1} max={10} value={r.requiredCount}
                            onChange={(e) => patchReq(r.id, { requiredCount: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                            className="w-12 px-1 py-0.5 bg-gray-700 border border-gray-600 rounded text-white text-xs text-center" />
                        </label>
                        <label className="flex items-center gap-1 text-gray-400 text-xs">
                          Phase
                          <select value={r.phase}
                            onChange={(e) => patchReq(r.id, { phase: e.target.value as PhotoPhase })}
                            className="px-1 py-0.5 bg-gray-700 border border-gray-600 rounded text-white text-xs">
                            <option value="any">Any</option>
                            <option value="pickup">Pickup</option>
                            <option value="dropoff">Drop-off</option>
                          </select>
                        </label>
                      </div>
                    </div>
                  </div>
                </div>
              ))}

              <div className="flex items-center justify-between">
                <button onClick={addReq} className="text-orange-400 hover:text-orange-300 text-xs font-medium">+ Add Required Photo</button>
                <div className="flex items-center gap-2">
                  {savedMsg && <span className="text-green-400 text-xs">{savedMsg}</span>}
                  <button
                    onClick={save}
                    disabled={!dirty || saving}
                    className={`px-3 py-1 rounded text-xs font-medium transition-colors ${dirty && !saving ? 'bg-orange-600 hover:bg-orange-500 text-white' : 'bg-gray-700 text-gray-500 cursor-not-allowed'}`}
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
