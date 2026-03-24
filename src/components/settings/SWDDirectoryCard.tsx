'use client';

// SWD Directory Card — Manage disposal site names + blacklist for the company.
// Three capabilities:
// 1. ALIAS: Rename existing NDIC disposal sites (e.g., "NYGAARD SWD 1" → "Aqua Terra Nygaard")
// 2. CUSTOM: Add entirely new entries (e.g., "WO WATFORD (PW)" pointing to same GPS as WO WATFORD SWD 1)
// 3. BLACKLIST: Block SWDs the company can't/won't use (bad terms, banned, etc.)
//
// Stored in Firestore: companies/{companyId}/swd_directory/{docId}
// WB T loads these on startup and merges with NDIC disposals in the search.

import { useState, useEffect } from 'react';
import { collection, getDocs, doc, setDoc, deleteDoc, addDoc } from 'firebase/firestore';
import { getFirestoreDb } from '@/lib/firebase';
import { type CompanyConfig } from '@/lib/companySettings';
import { loadOperators, searchOperators, loadDisposals, searchDisposals, type NdicOperator, type NdicWell } from '@/lib/firestoreWells';

export interface SWDEntry {
  id: string;
  displayName: string;         // What drivers see in dropdown + on invoice
  ndicWellName?: string;       // Original NDIC name (if alias of existing)
  apiNo?: string;              // NDIC API number (if linked)
  operator?: string;           // Operator/owner name
  latitude?: number;           // GPS coords
  longitude?: number;
  county?: string;
  isCustom: boolean;           // true = new entry, false = rename of existing
  isBlacklisted?: boolean;     // true = blocked SWD
  reason?: string;             // Why blacklisted
  createdAt: string;
  updatedAt?: string;
}

interface Props {
  company: CompanyConfig;
  onSave: () => void;
}

type SectionKey = 'renamed' | 'custom' | 'blacklisted';
type FormMode = 'alias' | 'custom' | 'blacklist';

export function SWDDirectoryCard({ company, onSave }: Props) {
  const [entries, setEntries] = useState<SWDEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedSection, setExpandedSection] = useState<SectionKey | null>(null);

  // Autocomplete state
  const [allOperators, setAllOperators] = useState<NdicOperator[]>([]);
  const [operatorSuggestions, setOperatorSuggestions] = useState<NdicOperator[]>([]);
  const [allDisposals, setAllDisposals] = useState<NdicWell[]>([]);
  const [disposalSuggestions, setDisposalSuggestions] = useState<NdicWell[]>([]);

  // Add/Edit form state
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formMode, setFormMode] = useState<FormMode>('custom');
  const [formDisplayName, setFormDisplayName] = useState('');
  const [formNdicName, setFormNdicName] = useState('');
  const [formOperator, setFormOperator] = useState('');
  const [formApiNo, setFormApiNo] = useState('');
  const [formLatitude, setFormLatitude] = useState('');
  const [formLongitude, setFormLongitude] = useState('');
  const [formCounty, setFormCounty] = useState('');
  const [formReason, setFormReason] = useState('');

  // Load existing entries
  useEffect(() => {
    loadEntries();
  }, [company.id]);

  // Load operators + disposals for autocomplete
  useEffect(() => {
    loadOperators().then(setAllOperators).catch(console.error);
    loadDisposals().then(setAllDisposals).catch(console.error);
  }, []);

  const loadEntries = async () => {
    setLoading(true);
    setError(null);
    try {
      const firestore = getFirestoreDb();
      const snap = await getDocs(
        collection(firestore, 'companies', company.id, 'swd_directory')
      );
      const list: SWDEntry[] = [];
      snap.forEach(d => {
        list.push({ id: d.id, ...d.data() } as SWDEntry);
      });
      list.sort((a, b) => a.displayName.localeCompare(b.displayName));
      setEntries(list);
    } catch (err) {
      console.error('Failed to load SWD directory:', err);
      setError('Failed to load SWD directory');
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setShowForm(false);
    setEditingId(null);
    setFormMode('custom');
    setFormDisplayName('');
    setFormNdicName('');
    setFormOperator('');
    setFormApiNo('');
    setFormLatitude('');
    setFormLongitude('');
    setFormCounty('');
    setFormReason('');
    setOperatorSuggestions([]);
    setDisposalSuggestions([]);
  };

  const startEdit = (entry: SWDEntry) => {
    setEditingId(entry.id);
    setFormMode(entry.isBlacklisted ? 'blacklist' : entry.isCustom ? 'custom' : 'alias');
    setFormDisplayName(entry.displayName);
    setFormNdicName(entry.ndicWellName || '');
    setFormOperator(entry.operator || '');
    setFormApiNo(entry.apiNo || '');
    setFormLatitude(entry.latitude?.toString() || '');
    setFormLongitude(entry.longitude?.toString() || '');
    setFormCounty(entry.county || '');
    setFormReason(entry.reason || '');
    setShowForm(true);
  };

  const handleSave = async () => {
    if (formMode === 'blacklist') {
      if (!formNdicName.trim() && !formDisplayName.trim()) return;
    } else {
      if (!formDisplayName.trim()) return;
    }

    setSaving('form');
    setError(null);
    try {
      const firestore = getFirestoreDb();
      const colRef = collection(firestore, 'companies', company.id, 'swd_directory');

      // Build data object — omit empty fields (Firestore rejects undefined values)
      const data: Record<string, any> = {
        displayName: formDisplayName.trim() || formNdicName.trim(),
        isCustom: formMode === 'custom',
        isBlacklisted: formMode === 'blacklist',
        createdAt: editingId
          ? entries.find(e => e.id === editingId)?.createdAt || new Date().toISOString()
          : new Date().toISOString(),
      };
      if ((formMode === 'alias' || formMode === 'blacklist') && formNdicName.trim()) data.ndicWellName = formNdicName.trim();
      if (formApiNo.trim()) data.apiNo = formApiNo.trim();
      if (formOperator.trim()) data.operator = formOperator.trim();
      if (formLatitude) data.latitude = parseFloat(formLatitude);
      if (formLongitude) data.longitude = parseFloat(formLongitude);
      if (formCounty.trim()) data.county = formCounty.trim();
      if (formMode === 'blacklist' && formReason.trim()) data.reason = formReason.trim();
      if (editingId) data.updatedAt = new Date().toISOString();

      if (editingId) {
        await setDoc(doc(colRef, editingId), data);
      } else {
        await addDoc(colRef, data);
      }

      // Auto-expand the section we just added to
      const section: SectionKey = formMode === 'blacklist' ? 'blacklisted' : formMode === 'custom' ? 'custom' : 'renamed';
      setExpandedSection(section);

      resetForm();
      await loadEntries();
      onSave();
    } catch (err) {
      console.error('Failed to save SWD entry:', err);
      setError('Failed to save entry. Please try again.');
    } finally {
      setSaving(null);
    }
  };

  const handleDelete = async (entryId: string) => {
    if (!confirm('Remove this SWD entry?')) return;
    setSaving(entryId);
    try {
      const firestore = getFirestoreDb();
      await deleteDoc(doc(firestore, 'companies', company.id, 'swd_directory', entryId));
      await loadEntries();
      onSave();
    } catch (err) {
      console.error('Failed to delete SWD entry:', err);
    } finally {
      setSaving(null);
    }
  };

  const aliases = entries.filter(e => !e.isCustom && !e.isBlacklisted);
  const customs = entries.filter(e => e.isCustom && !e.isBlacklisted);
  const blacklisted = entries.filter(e => e.isBlacklisted);

  const toggleSection = (key: SectionKey) => {
    setExpandedSection(prev => prev === key ? null : key);
  };

  return (
    <div className="bg-gray-800 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-violet-500/30 bg-violet-900/20">
        <div className="flex items-center justify-between">
          <h3 className="text-violet-400 font-medium text-sm">SWD Directory</h3>
          <span className="text-[11px] text-gray-500">
            {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
          </span>
        </div>
      </div>

      <div className="p-4">
        {loading ? (
          <div className="text-gray-500 text-sm text-center py-4">Loading...</div>
        ) : error ? (
          <div className="text-red-400 text-sm text-center py-4">{error}</div>
        ) : (
          <>
            {/* Explanation */}
            <p className="text-gray-500 text-xs mb-4">
              Customize SWD names for your drivers. <strong className="text-gray-400">Rename</strong> NDIC entries
              that changed owners, <strong className="text-gray-400">add custom</strong> locations your operators use,
              or <strong className="text-red-400">blacklist</strong> SWDs your company can&apos;t use.
            </p>

            {/* Add button */}
            {!showForm && (
              <button
                onClick={() => { resetForm(); setShowForm(true); }}
                className="w-full py-2 mb-4 rounded border border-dashed border-violet-500/40 text-violet-400 text-sm hover:bg-violet-900/20 transition-colors"
              >
                + Add SWD Entry
              </button>
            )}

            {/* Add/Edit Form */}
            {showForm && (
              <div className="mb-4 p-4 rounded-lg border border-violet-500/30 bg-violet-900/10">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-violet-400 text-sm font-medium">
                    {editingId ? 'Edit Entry' : 'New Entry'}
                  </span>
                  <button onClick={resetForm} className="text-gray-500 text-xs hover:text-gray-300">
                    Cancel
                  </button>
                </div>

                {/* Mode toggle — 3 options */}
                <div className="flex rounded-md overflow-hidden border border-gray-600 mb-3">
                  <button
                    onClick={() => setFormMode('alias')}
                    className={`flex-1 px-2 py-1.5 text-xs font-medium transition-colors ${
                      formMode === 'alias'
                        ? 'bg-violet-500 text-white'
                        : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                    }`}
                  >
                    Rename NDIC
                  </button>
                  <button
                    onClick={() => setFormMode('custom')}
                    className={`flex-1 px-2 py-1.5 text-xs font-medium transition-colors ${
                      formMode === 'custom'
                        ? 'bg-violet-500 text-white'
                        : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                    }`}
                  >
                    Custom Location
                  </button>
                  <button
                    onClick={() => setFormMode('blacklist')}
                    className={`flex-1 px-2 py-1.5 text-xs font-medium transition-colors ${
                      formMode === 'blacklist'
                        ? 'bg-red-600 text-white'
                        : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                    }`}
                  >
                    Blacklist
                  </button>
                </div>

                {/* NDIC Name (alias + blacklist mode) — autocomplete from disposals */}
                {(formMode === 'alias' || formMode === 'blacklist') && (
                  <div className="mb-2">
                    <label className="text-gray-400 text-xs block mb-1">
                      {formMode === 'blacklist' ? 'SWD to Block' : 'NDIC Well Name (original)'}
                    </label>
                    <div className="relative">
                      <input
                        type="text"
                        value={formNdicName}
                        onChange={e => {
                          setFormNdicName(e.target.value);
                          setDisposalSuggestions(searchDisposals(e.target.value, allDisposals));
                        }}
                        placeholder="e.g., NYGAARD SWD 1"
                        className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm placeholder-gray-500"
                      />
                      {disposalSuggestions.length > 0 && (
                        <div className="absolute z-10 w-full bg-gray-800 border border-gray-600 rounded mt-0.5 max-h-40 overflow-y-auto">
                          {disposalSuggestions.map(d => (
                            <button
                              key={d.api_no || d.well_name}
                              onClick={() => {
                                setFormNdicName(d.well_name);
                                if (formMode === 'blacklist') {
                                  setFormDisplayName(d.well_name);
                                }
                                setFormOperator(d.operator || '');
                                setFormApiNo(d.api_no || '');
                                setFormLatitude(d.latitude?.toString() || '');
                                setFormLongitude(d.longitude?.toString() || '');
                                setFormCounty(d.county || '');
                                setDisposalSuggestions([]);
                              }}
                              className="w-full text-left px-3 py-1.5 hover:bg-gray-700 text-white text-xs border-b border-gray-700 last:border-0"
                            >
                              {d.well_name} <span className="text-gray-500">{d.operator}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Display Name (alias + custom only, not blacklist) */}
                {formMode !== 'blacklist' && (
                  <div className="mb-2">
                    <label className="text-gray-400 text-xs block mb-1">
                      {formMode === 'alias' ? 'Display Name (what drivers see)' : 'Location Name'}
                    </label>
                    <input
                      type="text"
                      value={formDisplayName}
                      onChange={e => setFormDisplayName(e.target.value)}
                      placeholder={formMode === 'alias' ? 'e.g., Aqua Terra Nygaard' : 'e.g., WO WATFORD (PW)'}
                      className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm placeholder-gray-500"
                    />
                  </div>
                )}

                {/* Reason (blacklist only) */}
                {formMode === 'blacklist' && (
                  <div className="mb-2">
                    <label className="text-gray-400 text-xs block mb-1">Reason (optional)</label>
                    <input
                      type="text"
                      value={formReason}
                      onChange={e => setFormReason(e.target.value)}
                      placeholder="e.g., Bad terms, banned, capacity issues"
                      className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm placeholder-gray-500"
                    />
                  </div>
                )}

                {/* Operator — autocomplete (alias + custom only) */}
                {formMode !== 'blacklist' && (
                  <div className="mb-2">
                    <label className="text-gray-400 text-xs block mb-1">Operator / Owner</label>
                    <div className="relative">
                      <input
                        type="text"
                        value={formOperator}
                        onChange={e => {
                          setFormOperator(e.target.value);
                          setOperatorSuggestions(searchOperators(e.target.value, allOperators));
                        }}
                        placeholder="e.g., Aqua Terra Water Management"
                        className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm placeholder-gray-500"
                      />
                      {operatorSuggestions.length > 0 && (
                        <div className="absolute z-10 w-full bg-gray-800 border border-gray-600 rounded mt-0.5 max-h-32 overflow-y-auto">
                          {operatorSuggestions.map(op => (
                            <button
                              key={op.name}
                              onClick={() => { setFormOperator(op.name); setOperatorSuggestions([]); }}
                              className="w-full text-left px-3 py-1.5 hover:bg-gray-700 text-white text-xs border-b border-gray-700 last:border-0"
                            >
                              {op.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* API # (alias + custom only) */}
                {formMode !== 'blacklist' && (
                  <div className="mb-2">
                    <label className="text-gray-400 text-xs block mb-1">API # (optional — links GPS coords)</label>
                    <input
                      type="text"
                      value={formApiNo}
                      onChange={e => setFormApiNo(e.target.value)}
                      placeholder="e.g., 33-025-12345"
                      className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm placeholder-gray-500"
                    />
                  </div>
                )}

                {/* GPS coords row (alias + custom only) */}
                {formMode !== 'blacklist' && (
                  <div className="flex gap-2 mb-2">
                    <div className="flex-1">
                      <label className="text-gray-400 text-xs block mb-1">Latitude</label>
                      <input
                        type="text"
                        value={formLatitude}
                        onChange={e => setFormLatitude(e.target.value)}
                        placeholder="e.g., 47.8023"
                        className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm placeholder-gray-500"
                      />
                    </div>
                    <div className="flex-1">
                      <label className="text-gray-400 text-xs block mb-1">Longitude</label>
                      <input
                        type="text"
                        value={formLongitude}
                        onChange={e => setFormLongitude(e.target.value)}
                        placeholder="e.g., -103.6145"
                        className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm placeholder-gray-500"
                      />
                    </div>
                  </div>
                )}

                {/* County (alias + custom only) */}
                {formMode !== 'blacklist' && (
                  <div className="mb-3">
                    <label className="text-gray-400 text-xs block mb-1">County</label>
                    <input
                      type="text"
                      value={formCounty}
                      onChange={e => setFormCounty(e.target.value)}
                      placeholder="e.g., Williams"
                      className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm placeholder-gray-500"
                    />
                  </div>
                )}

                {/* Save button */}
                <button
                  onClick={handleSave}
                  disabled={
                    (formMode === 'blacklist' ? !formNdicName.trim() && !formDisplayName.trim() : !formDisplayName.trim())
                    || saving === 'form'
                  }
                  className={`w-full py-2 rounded text-sm font-medium transition-colors ${
                    (formMode === 'blacklist'
                      ? (formNdicName.trim() || formDisplayName.trim()) && saving !== 'form'
                      : formDisplayName.trim() && saving !== 'form')
                      ? formMode === 'blacklist'
                        ? 'bg-red-600 text-white hover:bg-red-700'
                        : 'bg-violet-500 text-white hover:bg-violet-600'
                      : 'bg-gray-700 text-gray-500 cursor-not-allowed'
                  }`}
                >
                  {saving === 'form' ? 'Saving...' : editingId ? 'Update Entry'
                    : formMode === 'blacklist' ? 'Block SWD' : 'Add Entry'}
                </button>
              </div>
            )}

            {/* Collapsible Sections */}
            {entries.length === 0 && !showForm ? (
              <div className="text-gray-500 text-sm text-center py-4">
                No custom SWD entries yet. NDIC names with operator will show by default.
              </div>
            ) : (
              <div className="space-y-1">
                {/* Renamed section */}
                <SectionHeader
                  label="Renamed"
                  count={aliases.length}
                  expanded={expandedSection === 'renamed'}
                  onClick={() => toggleSection('renamed')}
                  color="violet"
                />
                {expandedSection === 'renamed' && aliases.map(entry => (
                  <EntryRow
                    key={entry.id}
                    entry={entry}
                    saving={saving}
                    onEdit={() => startEdit(entry)}
                    onDelete={() => handleDelete(entry.id)}
                  />
                ))}

                {/* Custom section */}
                <SectionHeader
                  label="Custom"
                  count={customs.length}
                  expanded={expandedSection === 'custom'}
                  onClick={() => toggleSection('custom')}
                  color="cyan"
                />
                {expandedSection === 'custom' && customs.map(entry => (
                  <EntryRow
                    key={entry.id}
                    entry={entry}
                    saving={saving}
                    onEdit={() => startEdit(entry)}
                    onDelete={() => handleDelete(entry.id)}
                  />
                ))}

                {/* Blacklisted section */}
                <SectionHeader
                  label="Blacklisted"
                  count={blacklisted.length}
                  expanded={expandedSection === 'blacklisted'}
                  onClick={() => toggleSection('blacklisted')}
                  color="red"
                />
                {expandedSection === 'blacklisted' && blacklisted.map(entry => (
                  <BlacklistRow
                    key={entry.id}
                    entry={entry}
                    saving={saving}
                    onDelete={() => handleDelete(entry.id)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Section Header (collapsible toggle) ───────────────────────────────────

function SectionHeader({
  label,
  count,
  expanded,
  onClick,
  color,
}: {
  label: string;
  count: number;
  expanded: boolean;
  onClick: () => void;
  color: 'violet' | 'cyan' | 'red';
}) {
  const colors = {
    violet: { text: 'text-violet-400', badge: 'bg-violet-900/50 text-violet-300 border-violet-700' },
    cyan: { text: 'text-cyan-400', badge: 'bg-cyan-900/50 text-cyan-300 border-cyan-700' },
    red: { text: 'text-red-400', badge: 'bg-red-900/50 text-red-300 border-red-700' },
  };
  const c = colors[color];

  return (
    <button
      onClick={onClick}
      className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-gray-900/40 hover:bg-gray-900/60 transition-colors"
    >
      <div className="flex items-center gap-2">
        <span className={`text-xs transition-transform ${expanded ? 'rotate-90' : ''} text-gray-500`}>
          ▶
        </span>
        <span className={`text-xs font-medium uppercase tracking-wider ${c.text}`}>
          {label}
        </span>
      </div>
      <span className={`text-[10px] px-1.5 py-0.5 rounded border ${c.badge}`}>
        {count}
      </span>
    </button>
  );
}

// ── Entry Row Component ────────────────────────────────────────────────────

function EntryRow({
  entry,
  saving,
  onEdit,
  onDelete,
}: {
  entry: SWDEntry;
  saving: string | null;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const isSaving = saving === entry.id;

  return (
    <div className="flex items-start gap-3 p-3 ml-5 rounded-lg border border-gray-700 bg-gray-900/40 group">
      <div className="flex-1 min-w-0">
        {/* Display name */}
        <div className="text-white text-sm font-medium truncate">{entry.displayName}</div>

        {/* Original NDIC name (alias only) */}
        {entry.ndicWellName && (
          <div className="text-gray-500 text-xs mt-0.5">
            NDIC: {entry.ndicWellName}
          </div>
        )}

        {/* Operator + County */}
        <div className="flex items-center gap-2 mt-0.5">
          {entry.operator && (
            <span className="text-violet-400/70 text-[11px]">{entry.operator}</span>
          )}
          {entry.county && (
            <span className="text-gray-600 text-[11px]">— {entry.county} Co.</span>
          )}
        </div>

        {/* API + GPS */}
        {(entry.apiNo || entry.latitude) && (
          <div className="flex items-center gap-3 mt-0.5">
            {entry.apiNo && (
              <span className="text-gray-600 text-[10px]">API: {entry.apiNo}</span>
            )}
            {entry.latitude && entry.longitude && (
              <span className="text-gray-600 text-[10px]">
                GPS: {entry.latitude.toFixed(4)}, {entry.longitude.toFixed(4)}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
        <button
          onClick={onEdit}
          disabled={isSaving}
          className="text-xs px-2 py-1 rounded text-gray-400 hover:text-violet-400 hover:bg-violet-900/20 transition-colors"
        >
          Edit
        </button>
        <button
          onClick={onDelete}
          disabled={isSaving}
          className="text-xs px-2 py-1 rounded text-gray-400 hover:text-red-400 hover:bg-red-900/20 transition-colors"
        >
          {isSaving ? '...' : '✕'}
        </button>
      </div>
    </div>
  );
}

// ── Blacklist Row Component ────────────────────────────────────────────────

function BlacklistRow({
  entry,
  saving,
  onDelete,
}: {
  entry: SWDEntry;
  saving: string | null;
  onDelete: () => void;
}) {
  const isSaving = saving === entry.id;

  return (
    <div className="flex items-center gap-3 p-3 ml-5 rounded-lg border border-red-900/50 bg-red-900/10 group">
      <div className="flex-1 min-w-0">
        <div className="text-red-300 text-sm font-medium truncate">
          {entry.ndicWellName || entry.displayName}
        </div>
        {entry.reason && (
          <div className="text-red-400/60 text-xs mt-0.5">{entry.reason}</div>
        )}
        {entry.operator && (
          <div className="text-gray-600 text-[11px] mt-0.5">{entry.operator}</div>
        )}
      </div>

      <button
        onClick={onDelete}
        disabled={isSaving}
        className="text-xs px-2 py-1 rounded text-gray-500 hover:text-red-400 hover:bg-red-900/20 transition-colors opacity-0 group-hover:opacity-100 flex-shrink-0"
      >
        {isSaving ? '...' : 'Remove'}
      </button>
    </div>
  );
}
