'use client';

import { useEffect, useState, useCallback } from 'react';
import { type CompanyConfig } from '@/lib/companySettings';
import {
  type PhotoRequirement,
  type PhotoPhase,
  type PhotoAppliesTo,
  customerIdForOperator,
  loadPhotoRequirementSpec,
  savePhotoRequirementSpec,
  uploadRequirementSample,
  suggestPhotoCriteria,
} from '@/lib/photoRequirements';
import { getDefaultPhotoRequirements, defaultRequirementById } from '@/lib/defaultPhotoRequirements';

interface Props {
  company: CompanyConfig;
}

function genId(): string {
  return 'r' + Math.random().toString(36).slice(2, 9);
}

function blankReq(): PhotoRequirement {
  return { id: genId(), label: '', description: '', threshold: 80, requiredCount: 1, phase: 'any', appliesTo: 'any', active: true };
}

// Strictness slider labels (70–90, step 5). The AI acceptance gate (accepted=false)
// already rejects wrong-subject / blurry photos; the threshold only sets how strict
// we are on otherwise-valid photos. Audit data: no accepted photo scores <70, and 90
// retakes ~80% of valid field photos — so the slider is capped at 70–90 to stop the
// "higher = better" mistake.
const STRICTNESS: Record<number, { label: string; color: string }> = {
  70: { label: 'Lenient — trust AI subject detection', color: '#22c55e' },
  75: { label: 'Field-friendly', color: '#22c55e' },
  80: { label: 'Recommended default', color: '#60a5fa' },
  85: { label: 'Strict', color: '#f59e0b' },
  90: { label: 'Very strict — likely extra retakes', color: '#ef4444' },
};
function strictnessFor(threshold: number): { label: string; color: string } {
  const snapped = Math.round(Math.max(70, Math.min(90, threshold)) / 5) * 5;
  return STRICTNESS[snapped] || STRICTNESS[80];
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
  const [hintById, setHintById] = useState<Record<string, string>>({}); // transient drafting hint, not saved
  const [dirty, setDirty] = useState(false);
  const [savedMsg, setSavedMsg] = useState('');
  // True when the editor is showing WB defaults for an operator that has NO
  // saved doc yet. Nothing is written until the admin clicks Save.
  const [seeded, setSeeded] = useState(false);

  const customerId = customerIdForOperator(operator);

  const load = useCallback(async () => {
    if (!customerId) { setReqs([]); setEnabled(true); setSeeded(false); return; }
    setLoading(true);
    try {
      const spec = await loadPhotoRequirementSpec(customerId);
      if (spec) {
        // Existing customer/operator — load their saved config untouched.
        setReqs(spec.requirements || []);
        setEnabled(spec.enabled !== false);
        setSeeded(false);
      } else {
        // No doc yet → seed the editor from WB defaults so the admin never sees
        // a blank list. This is in-memory only; the real photo_requirements doc
        // is written only when the admin clicks Save.
        setReqs(getDefaultPhotoRequirements());
        setEnabled(true);
        setSeeded(true);
      }
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

  // Reset ONE requirement to its WB default. Only available when the id exists in
  // DEFAULT_PHOTO_REQUIREMENTS. Replaces the requirement in place (position kept).
  // Local editor state only — Save is still required to persist.
  const resetReq = (id: string) => {
    const def = defaultRequirementById(id);
    if (!def) return;
    if (!window.confirm('Reset this requirement to the WB default?')) return;
    setReqs(rs => rs.map(r => (r.id === id ? { ...def } : r)));
    setDirty(true);
    setSavedMsg('');
  };

  // Reset ALL matching WB defaults. Matching default ids are replaced by the
  // template (in place); customer-only requirements are KEPT; any default id not
  // currently present is added back (appended). Local editor state only — Save
  // is still required to persist.
  const resetAll = () => {
    if (!window.confirm(
      'Reset all matching WB default requirements? This will replace current editor values for matching default ids. '
      + 'Custom requirements are kept. Save is still required to persist.')) return;
    const defaults = getDefaultPhotoRequirements();
    const defaultIds = new Set(defaults.map(d => d.id));
    const replaced = reqs.map(r => (defaultIds.has(r.id) ? (defaultRequirementById(r.id) as PhotoRequirement) : r));
    const presentIds = new Set(reqs.map(r => r.id));
    const missing = defaults.filter(d => !presentIds.has(d.id));
    setReqs([...replaced, ...missing]);
    setDirty(true);
    setSavedMsg('');
  };

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
        hint: hintById[req.id]?.trim() || undefined,
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
      setSeeded(false);   // it's now a real saved doc, no longer just defaults
      setSavedMsg(`Saved (v${v}) — drivers refresh on next job load.`);
    } catch (e: any) {
      console.error('[RequiredPhotoSpecs] save failed:', e);
      alert('Save failed: ' + (e?.message || 'unknown error'));
    } finally {
      setSaving(false);
    }
  };

  // Discard local edits → reload last saved server state.
  const discard = () => { void load(); };

  // Switching customer with unsaved edits would silently drop them (load()
  // re-fetches). Confirm first.
  const onOperatorChange = (next: string) => {
    if (next === operator) return;
    if (dirty && !window.confirm('Unsaved photo requirement changes will be lost. Discard changes?')) return;
    setOperator(next);
  };

  // Warn on reload / tab close / external navigation while dirty.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

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
              onChange={(e) => onOperatorChange(e.target.value)}
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
              {seeded && (
                <div className="text-xs rounded-md border border-blue-700/60 bg-blue-900/20 text-blue-200 px-3 py-2">
                  Showing <span className="font-semibold">WB default</span> photo requirements for this operator
                  (no saved config yet). Edit if you like, then <span className="font-semibold">Save</span> to apply
                  them — nothing is saved until you do.
                </div>
              )}
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
                        {defaultRequirementById(r.id) && (
                          <button
                            onClick={() => resetReq(r.id)}
                            className="text-blue-300/70 hover:text-blue-200 text-xs flex-shrink-0 px-1"
                            title="Reset this requirement to the WB default"
                          >↺ default</button>
                        )}
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
                        rows={6}
                        className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded text-white text-xs resize-y min-h-[7rem] leading-relaxed"
                      />

                      {/* AI criteria drafting — always rendered for a consistent
                          card. The optional hint guides the draft; the label is the
                          main intent. Fills the field; admin reviews/edits before
                          Save. Suggest needs a sample photo to analyze, so it's
                          disabled (not hidden) until one is added. */}
                      {(() => {
                        const hasSample = !!(r.sampleStoragePath || r.sampleUrl);
                        const suggesting = suggestingId === r.id;
                        const suggestDisabled = suggesting || !hasSample;
                        return (
                          <div className="flex items-center gap-2">
                            <input
                              value={hintById[r.id] || ''}
                              onChange={(e) => setHintById(h => ({ ...h, [r.id]: e.target.value }))}
                              placeholder="What are you trying to prove? (optional)"
                              className="flex-1 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-xs placeholder-gray-500"
                            />
                            <button
                              onClick={() => onSuggest(r)}
                              disabled={suggestDisabled}
                              className={`text-xs font-medium flex-shrink-0 ${suggesting ? 'text-gray-500 cursor-wait' : !hasSample ? 'text-gray-600 cursor-not-allowed' : 'text-purple-300 hover:text-purple-200'}`}
                              title={hasSample ? 'Draft criteria from the sample photo + hint (you can edit before saving)' : 'Add a sample photo first to draft criteria from it.'}
                            >
                              {suggesting ? 'Drafting…' : '✨ Suggest Criteria'}
                            </button>
                          </div>
                        );
                      })()}

                      <div className="flex items-center gap-3 flex-wrap">
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
                        <label className="flex items-center gap-1 text-gray-400 text-xs">
                          Job type
                          <select value={r.appliesTo || 'any'}
                            onChange={(e) => patchReq(r.id, { appliesTo: e.target.value as PhotoAppliesTo })}
                            className="px-1 py-0.5 bg-gray-700 border border-gray-600 rounded text-white text-xs">
                            <option value="any">All jobs</option>
                            <option value="pw">PW only</option>
                            <option value="sw">SW only</option>
                          </select>
                        </label>
                      </div>

                      {/* Strictness — bounded 70–90 slider. The AI acceptance gate already
                          rejects wrong-subject / blurry photos; the threshold only tunes how
                          strict we are on otherwise-valid photos, so the range is capped to
                          avoid punishing good field photos. Legacy out-of-range values show
                          their real number and clamp the thumb, but are NOT rewritten until
                          the admin moves the slider. */}
                      {(() => {
                        const s = strictnessFor(r.threshold);
                        const outOfRange = r.threshold < 70 || r.threshold > 90;
                        return (
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              <span className="text-gray-400 text-xs w-16 flex-shrink-0">Strictness</span>
                              <input
                                type="range" min={70} max={90} step={5}
                                value={Math.max(70, Math.min(90, r.threshold))}
                                onChange={(e) => patchReq(r.id, { threshold: parseInt(e.target.value, 10) })}
                                className="flex-1 accent-orange-500"
                              />
                              <span className="text-white text-xs font-semibold w-7 text-right flex-shrink-0">{r.threshold}</span>
                            </div>
                            <div className="ml-[4.5rem] text-xs font-medium" style={{ color: s.color }}>{s.label}</div>
                            <div className="ml-[4.5rem] text-gray-500 text-[10px] leading-snug">
                              Threshold only judges photo clarity on valid photos — wrong-subject or blurry photos are already rejected automatically.
                              {outOfRange && <span className="text-amber-400"> Legacy value {r.threshold}; move the slider to bring it into 70–90.</span>}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                </div>
              ))}

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <button onClick={addReq} className="text-orange-400 hover:text-orange-300 text-xs font-medium">+ Add Required Photo</button>
                  <button onClick={resetAll} className="text-blue-300 hover:text-blue-200 text-xs font-medium" title="Replace matching WB-default requirements; keep custom ones; re-add missing defaults">↺ Reset All to WB Defaults</button>
                </div>
                {!dirty && savedMsg && <span className="text-green-400 text-xs">{savedMsg}</span>}
              </div>
            </div>
          )}

          {/* Scoped sticky save bar — pinned to the viewport bottom only while the
              Required Photo Specs section is on screen (position:sticky inside this
              card), and only when there are unsaved edits. -mx-4 spans the card's
              padding. */}
          {dirty && (
            <div className="sticky bottom-0 z-10 -mx-4 mt-3 px-4 py-2 bg-gray-800/95 backdrop-blur border-t border-orange-500/40 flex items-center justify-between">
              <span className="text-orange-300 text-xs font-medium">Unsaved changes</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={discard}
                  disabled={saving}
                  className="px-3 py-1 rounded text-xs font-medium bg-gray-700 hover:bg-gray-600 text-gray-200 disabled:opacity-50"
                >Discard</button>
                <button
                  onClick={save}
                  disabled={saving}
                  className="px-3 py-1 rounded text-xs font-medium bg-orange-600 hover:bg-orange-500 text-white disabled:opacity-50"
                >{saving ? 'Saving…' : 'Save'}</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
