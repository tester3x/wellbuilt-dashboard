'use client';

// SWD Directory Card — Manage disposal site names for the company.
// Two capabilities:
// 1. ALIAS: Rename existing NDIC disposal sites (e.g., "NYGAARD SWD 1" → "Aqua Terra Nygaard")
// 2. CUSTOM: Add entirely new entries (e.g., "WO WATFORD (PW)" pointing to same GPS as WO WATFORD SWD 1)
//
// Stored in Firestore: companies/{companyId}/swd_directory/{docId}
// WB T loads these on startup and merges with NDIC disposals in the search.

import { useState, useEffect } from 'react';
import { collection, getDocs, doc, setDoc, deleteDoc, addDoc } from 'firebase/firestore';
import { getFirestoreDb } from '@/lib/firebase';
import { type CompanyConfig } from '@/lib/companySettings';

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
  createdAt: string;
  updatedAt?: string;
}

interface Props {
  company: CompanyConfig;
  onSave: () => void;
}

export function SWDDirectoryCard({ company, onSave }: Props) {
  const [entries, setEntries] = useState<SWDEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Add/Edit form state
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formMode, setFormMode] = useState<'alias' | 'custom'>('custom');
  const [formDisplayName, setFormDisplayName] = useState('');
  const [formNdicName, setFormNdicName] = useState('');
  const [formOperator, setFormOperator] = useState('');
  const [formApiNo, setFormApiNo] = useState('');
  const [formLatitude, setFormLatitude] = useState('');
  const [formLongitude, setFormLongitude] = useState('');
  const [formCounty, setFormCounty] = useState('');

  // Load existing entries
  useEffect(() => {
    loadEntries();
  }, [company.id]);

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
  };

  const startEdit = (entry: SWDEntry) => {
    setEditingId(entry.id);
    setFormMode(entry.isCustom ? 'custom' : 'alias');
    setFormDisplayName(entry.displayName);
    setFormNdicName(entry.ndicWellName || '');
    setFormOperator(entry.operator || '');
    setFormApiNo(entry.apiNo || '');
    setFormLatitude(entry.latitude?.toString() || '');
    setFormLongitude(entry.longitude?.toString() || '');
    setFormCounty(entry.county || '');
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!formDisplayName.trim()) return;

    setSaving('form');
    try {
      const firestore = getFirestoreDb();
      const colRef = collection(firestore, 'companies', company.id, 'swd_directory');

      const data: Omit<SWDEntry, 'id'> = {
        displayName: formDisplayName.trim(),
        ndicWellName: formMode === 'alias' ? formNdicName.trim() || undefined : undefined,
        apiNo: formApiNo.trim() || undefined,
        operator: formOperator.trim() || undefined,
        latitude: formLatitude ? parseFloat(formLatitude) : undefined,
        longitude: formLongitude ? parseFloat(formLongitude) : undefined,
        county: formCounty.trim() || undefined,
        isCustom: formMode === 'custom',
        createdAt: editingId
          ? entries.find(e => e.id === editingId)?.createdAt || new Date().toISOString()
          : new Date().toISOString(),
        updatedAt: editingId ? new Date().toISOString() : undefined,
      };

      if (editingId) {
        await setDoc(doc(colRef, editingId), data);
      } else {
        await addDoc(colRef, data);
      }

      resetForm();
      await loadEntries();
      onSave();
    } catch (err) {
      console.error('Failed to save SWD entry:', err);
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

  const aliases = entries.filter(e => !e.isCustom);
  const customs = entries.filter(e => e.isCustom);

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
              that changed owners, or <strong className="text-gray-400">add custom</strong> locations your operators use.
              Drivers see these names in the pickup and drop-off search.
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

                {/* Mode toggle */}
                <div className="flex rounded-md overflow-hidden border border-gray-600 mb-3">
                  <button
                    onClick={() => setFormMode('alias')}
                    className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors ${
                      formMode === 'alias'
                        ? 'bg-violet-500 text-white'
                        : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                    }`}
                  >
                    Rename Existing NDIC
                  </button>
                  <button
                    onClick={() => setFormMode('custom')}
                    className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors ${
                      formMode === 'custom'
                        ? 'bg-violet-500 text-white'
                        : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                    }`}
                  >
                    Add Custom Location
                  </button>
                </div>

                {/* NDIC Name (alias mode only) */}
                {formMode === 'alias' && (
                  <div className="mb-2">
                    <label className="text-gray-400 text-xs block mb-1">NDIC Well Name (original)</label>
                    <input
                      type="text"
                      value={formNdicName}
                      onChange={e => setFormNdicName(e.target.value)}
                      placeholder="e.g., NYGAARD SWD 1"
                      className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm placeholder-gray-500"
                    />
                  </div>
                )}

                {/* Display Name */}
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

                {/* Operator */}
                <div className="mb-2">
                  <label className="text-gray-400 text-xs block mb-1">Operator / Owner</label>
                  <input
                    type="text"
                    value={formOperator}
                    onChange={e => setFormOperator(e.target.value)}
                    placeholder="e.g., Aqua Terra Water Management"
                    className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm placeholder-gray-500"
                  />
                </div>

                {/* API # */}
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

                {/* GPS coords row */}
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

                {/* County */}
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

                {/* Save button */}
                <button
                  onClick={handleSave}
                  disabled={!formDisplayName.trim() || saving === 'form'}
                  className={`w-full py-2 rounded text-sm font-medium transition-colors ${
                    formDisplayName.trim() && saving !== 'form'
                      ? 'bg-violet-500 text-white hover:bg-violet-600'
                      : 'bg-gray-700 text-gray-500 cursor-not-allowed'
                  }`}
                >
                  {saving === 'form' ? 'Saving...' : editingId ? 'Update Entry' : 'Add Entry'}
                </button>
              </div>
            )}

            {/* Entries list */}
            {entries.length === 0 && !showForm ? (
              <div className="text-gray-500 text-sm text-center py-4">
                No custom SWD entries yet. NDIC names with operator will show by default.
              </div>
            ) : (
              <div className="space-y-1.5">
                {/* Aliases section */}
                {aliases.length > 0 && (
                  <>
                    <div className="text-gray-500 text-[10px] uppercase tracking-wider mt-2 mb-1">
                      Renamed ({aliases.length})
                    </div>
                    {aliases.map(entry => (
                      <EntryRow
                        key={entry.id}
                        entry={entry}
                        saving={saving}
                        onEdit={() => startEdit(entry)}
                        onDelete={() => handleDelete(entry.id)}
                      />
                    ))}
                  </>
                )}

                {/* Custom section */}
                {customs.length > 0 && (
                  <>
                    <div className="text-gray-500 text-[10px] uppercase tracking-wider mt-3 mb-1">
                      Custom ({customs.length})
                    </div>
                    {customs.map(entry => (
                      <EntryRow
                        key={entry.id}
                        entry={entry}
                        saving={saving}
                        onEdit={() => startEdit(entry)}
                        onDelete={() => handleDelete(entry.id)}
                      />
                    ))}
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
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
    <div className="flex items-start gap-3 p-3 rounded-lg border border-gray-700 bg-gray-900/40 group">
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
