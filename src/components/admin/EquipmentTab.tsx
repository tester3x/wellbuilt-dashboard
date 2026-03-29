'use client';

import { useEffect, useState, useRef, useMemo } from 'react';
import { useAuth } from '@/contexts/AuthContext';

// ── Common oilfield vehicle specs (hardcoded quick-lookup) ──────────────
// Tare weights are approximate mid-range for typical water hauler configs.
// Admin can always override after selecting.

interface VehiclePreset {
  make: string;
  model: string;
  tareWeight: number; // lbs
  bblCapacity?: number; // trailers only
}

const TRUCK_PRESETS: VehiclePreset[] = [
  { make: 'Peterbilt', model: '389', tareWeight: 18500 },
  { make: 'Peterbilt', model: '367', tareWeight: 19000 },
  { make: 'Peterbilt', model: '567', tareWeight: 19000 },
  { make: 'Peterbilt', model: '579', tareWeight: 18000 },
  { make: 'Kenworth', model: 'T800', tareWeight: 19500 },
  { make: 'Kenworth', model: 'W900', tareWeight: 18000 },
  { make: 'Kenworth', model: 'T880', tareWeight: 19500 },
  { make: 'Kenworth', model: 'C500', tareWeight: 21000 },
  { make: 'Freightliner', model: '122SD', tareWeight: 19500 },
  { make: 'Freightliner', model: 'Cascadia', tareWeight: 17500 },
  { make: 'Mack', model: 'Granite', tareWeight: 20000 },
  { make: 'Mack', model: 'Pinnacle', tareWeight: 19000 },
  { make: 'Western Star', model: '4900', tareWeight: 19500 },
  { make: 'Western Star', model: '4700', tareWeight: 18500 },
  { make: 'International', model: 'HX', tareWeight: 19000 },
  { make: 'Volvo', model: 'VNX', tareWeight: 18500 },
];

const TRAILER_PRESETS: VehiclePreset[] = [
  { make: 'Heil', model: '9400 gal Aluminum', tareWeight: 6500, bblCapacity: 130 },
  { make: 'Heil', model: '7000 gal Aluminum', tareWeight: 5500, bblCapacity: 100 },
  { make: 'Heil', model: '5500 gal Steel', tareWeight: 8500, bblCapacity: 80 },
  { make: 'Polar', model: '9500 gal Aluminum', tareWeight: 7000, bblCapacity: 135 },
  { make: 'Polar', model: '7000 gal Aluminum', tareWeight: 5800, bblCapacity: 100 },
  { make: 'Tremcar', model: '9400 gal Aluminum', tareWeight: 6800, bblCapacity: 130 },
  { make: 'Tremcar', model: '7000 gal Aluminum', tareWeight: 5600, bblCapacity: 100 },
  { make: 'Dragon', model: '130 BBL Steel', tareWeight: 9500, bblCapacity: 130 },
  { make: 'Dragon', model: '100 BBL Steel', tareWeight: 8000, bblCapacity: 100 },
  { make: 'Stephens', model: '130 BBL', tareWeight: 7500, bblCapacity: 130 },
  { make: 'Tiger', model: 'DOT 412', tareWeight: 8500, bblCapacity: 130 },
  { make: 'Brenner', model: '9000 gal Aluminum', tareWeight: 6500, bblCapacity: 128 },
  { make: 'LBT', model: '130 BBL', tareWeight: 7000, bblCapacity: 130 },
  { make: 'Custom', model: 'Vacuum Trailer', tareWeight: 9000, bblCapacity: 120 },
];
import { loadAllCompanies, type CompanyConfig } from '@/lib/companySettings';
import {
  fetchVehicleDocuments, uploadVehicleDocument, deleteVehicleDocument,
  groupByEquipment, getExpirationStatus, daysUntilExpiration,
  fetchEquipmentSpecs, saveEquipmentSpecs,
  VEHICLE_DOC_TYPES, VEHICLE_DOC_TYPE_LABELS,
  type VehicleDocument, type VehicleDocType, type EquipmentGroup, type EquipmentSpecs,
} from '@/lib/vehicleDocuments';

interface Props {
  scopeCompanyId?: string;
  isWbAdmin: boolean;
}

export function EquipmentTab({ scopeCompanyId, isWbAdmin }: Props) {
  const { user } = useAuth();

  // Company selection (WB admin can pick any company)
  const [companies, setCompanies] = useState<CompanyConfig[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState(scopeCompanyId || '');
  const effectiveCompanyId = scopeCompanyId || selectedCompanyId;

  // Data
  const [groups, setGroups] = useState<EquipmentGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  // Equipment specs (tare weight, capacity, make/model)
  const [specsMap, setSpecsMap] = useState<Map<string, EquipmentSpecs>>(new Map());
  const [editingSpecs, setEditingSpecs] = useState<string | null>(null); // key of group being edited
  const [specsDraft, setSpecsDraft] = useState<Partial<EquipmentSpecs>>({});
  const [savingSpecs, setSavingSpecs] = useState(false);

  // Filter
  const [typeFilter, setTypeFilter] = useState<'all' | 'truck' | 'trailer'>('all');
  const [search, setSearch] = useState('');

  // Add equipment form
  const [showAddForm, setShowAddForm] = useState(false);
  const [addType, setAddType] = useState<'truck' | 'trailer'>('truck');
  const [addNumber, setAddNumber] = useState('');

  // Upload form
  const [uploadTarget, setUploadTarget] = useState<{ type: 'truck' | 'trailer'; number: string } | null>(null);
  const [uploadDocType, setUploadDocType] = useState<VehicleDocType>('registration');
  const [uploadLabel, setUploadLabel] = useState('');
  const [uploadExpiration, setUploadExpiration] = useState('');
  const [uploadIssuedDate, setUploadIssuedDate] = useState('');
  const [uploadDocNumber, setUploadDocNumber] = useState('');
  const [uploadState, setUploadState] = useState('');
  const [uploadNotes, setUploadNotes] = useState('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadPreview, setUploadPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Message
  const [message, setMessage] = useState('');

  // Load companies for WB admin picker
  useEffect(() => {
    if (isWbAdmin) {
      loadAllCompanies().then(c => {
        setCompanies(c);
        if (!selectedCompanyId && c.length > 0) setSelectedCompanyId(c[0].id);
      });
    }
  }, [isWbAdmin]);

  // Load documents when company changes
  useEffect(() => {
    if (!effectiveCompanyId) return;
    loadDocs();
  }, [effectiveCompanyId]);

  const loadDocs = async () => {
    if (!effectiveCompanyId) return;
    setLoading(true);
    try {
      const [docs, specs] = await Promise.all([
        fetchVehicleDocuments(effectiveCompanyId),
        fetchEquipmentSpecs(effectiveCompanyId),
      ]);
      const docGroups = groupByEquipment(docs);

      // Merge specs-only equipment (no documents yet) into the groups list
      for (const [key, spec] of specs) {
        const exists = docGroups.some(g => `${g.equipmentType}_${g.equipmentNumber}` === key);
        if (!exists) {
          docGroups.push({
            equipmentType: spec.equipmentType,
            equipmentNumber: spec.equipmentNumber,
            documents: [],
            worstExpiration: 'none',
          });
        }
      }
      // Re-sort: trucks first, then by number
      docGroups.sort((a, b) => {
        if (a.equipmentType !== b.equipmentType) return a.equipmentType === 'truck' ? -1 : 1;
        return a.equipmentNumber.localeCompare(b.equipmentNumber);
      });

      setGroups(docGroups);
      setSpecsMap(specs);
    } catch (err) {
      console.error('[EquipmentTab] Failed to load:', err);
    } finally {
      setLoading(false);
    }
  };

  // Filtered groups
  const filtered = groups.filter(g => {
    if (typeFilter !== 'all' && g.equipmentType !== typeFilter) return false;
    if (search && !g.equipmentNumber.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  // Expiration summary
  const expiredCount = groups.filter(g => g.worstExpiration === 'expired').length;
  const expiringCount = groups.filter(g => g.worstExpiration === 'expiring').length;

  // Handle file selection
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadFile(file);
    setUploadPreview(URL.createObjectURL(file));
  };

  // Reset upload form
  const resetUploadForm = () => {
    setUploadTarget(null);
    setUploadDocType('registration');
    setUploadLabel('');
    setUploadExpiration('');
    setUploadIssuedDate('');
    setUploadDocNumber('');
    setUploadState('');
    setUploadNotes('');
    setUploadFile(null);
    if (uploadPreview) URL.revokeObjectURL(uploadPreview);
    setUploadPreview(null);
  };

  // Upload document
  const handleUpload = async () => {
    if (!uploadTarget || !uploadFile || !effectiveCompanyId) return;
    setUploading(true);
    try {
      await uploadVehicleDocument(
        effectiveCompanyId,
        uploadTarget.type,
        uploadTarget.number,
        uploadFile,
        {
          type: uploadDocType,
          label: uploadLabel || VEHICLE_DOC_TYPE_LABELS[uploadDocType],
          expirationDate: uploadExpiration || undefined,
          issuedDate: uploadIssuedDate || undefined,
          documentNumber: uploadDocNumber || undefined,
          state: uploadState || undefined,
          notes: uploadNotes || undefined,
          uploadedBy: user?.displayName || 'Admin',
        },
      );
      setMessage('Document uploaded successfully');
      resetUploadForm();
      await loadDocs();
    } catch (err) {
      console.error('[EquipmentTab] Upload failed:', err);
      setMessage('Upload failed. Please try again.');
    } finally {
      setUploading(false);
    }
  };

  // Delete document
  const handleDelete = async (doc: VehicleDocument) => {
    if (!confirm(`Delete "${doc.label}" from ${doc.equipmentType} ${doc.equipmentNumber}?`)) return;
    try {
      await deleteVehicleDocument(doc.id, (doc as any).storagePath);
      setMessage('Document deleted');
      await loadDocs();
    } catch (err) {
      console.error('[EquipmentTab] Delete failed:', err);
      setMessage('Delete failed');
    }
  };

  // Add equipment — create specs entry so it appears in the list (no doc required)
  const handleAddEquipment = async () => {
    if (!addNumber.trim() || !effectiveCompanyId) return;
    const number = addNumber.trim().toUpperCase();
    try {
      await saveEquipmentSpecs(effectiveCompanyId, {
        equipmentType: addType,
        equipmentNumber: number,
      });
      setMessage(`${addType === 'truck' ? 'Truck' : 'Trailer'} ${number} added`);
      setShowAddForm(false);
      setAddNumber('');
      await loadDocs();
    } catch (err) {
      console.error('[EquipmentTab] Add failed:', err);
      setMessage('Failed to add equipment');
    }
  };

  const handleSaveSpecs = async (group: EquipmentGroup) => {
    if (!effectiveCompanyId) return;
    setSavingSpecs(true);
    try {
      const specs: EquipmentSpecs = {
        equipmentType: group.equipmentType,
        equipmentNumber: group.equipmentNumber,
        tareWeight: specsDraft.tareWeight ? Number(specsDraft.tareWeight) : undefined,
        bblCapacity: specsDraft.bblCapacity ? Number(specsDraft.bblCapacity) : undefined,
        make: specsDraft.make || undefined,
        model: specsDraft.model || undefined,
        year: specsDraft.year || undefined,
      };
      await saveEquipmentSpecs(effectiveCompanyId, specs);
      const key = `${group.equipmentType}_${group.equipmentNumber}`;
      setSpecsMap(prev => new Map(prev).set(key, specs));
      setEditingSpecs(null);
      setMessage('Equipment specs saved');
    } catch (err) {
      console.error('[EquipmentTab] Save specs failed:', err);
      setMessage('Failed to save specs');
    } finally {
      setSavingSpecs(false);
    }
  };

  const startEditSpecs = (group: EquipmentGroup) => {
    const key = `${group.equipmentType}_${group.equipmentNumber}`;
    const existing = specsMap.get(key);
    setSpecsDraft({
      tareWeight: existing?.tareWeight,
      bblCapacity: existing?.bblCapacity,
      make: existing?.make || '',
      model: existing?.model || '',
      year: existing?.year || '',
    });
    setEditingSpecs(key);
  };

  const expirationBadge = (expDate?: string) => {
    const status = getExpirationStatus(expDate);
    const days = daysUntilExpiration(expDate);
    if (status === 'expired') return <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-red-900/50 text-red-400">EXPIRED</span>;
    if (status === 'expiring') return <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-yellow-900/50 text-yellow-400">Exp in {days}d</span>;
    if (status === 'valid') return <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-green-900/50 text-green-400">Valid</span>;
    return <span className="px-2 py-0.5 rounded-full text-xs text-gray-500">No exp</span>;
  };

  return (
    <div>
      {/* Company picker for WB admin */}
      {isWbAdmin && companies.length > 0 && (
        <div className="mb-4">
          <select
            value={selectedCompanyId}
            onChange={e => setSelectedCompanyId(e.target.value)}
            className="px-3 py-2 bg-gray-700 text-white rounded"
          >
            {companies.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* Alert banner */}
      {(expiredCount > 0 || expiringCount > 0) && (
        <div className={`mb-4 p-3 rounded-lg ${expiredCount > 0 ? 'bg-red-900/30 border border-red-700' : 'bg-yellow-900/30 border border-yellow-700'}`}>
          {expiredCount > 0 && <span className="text-red-400 font-bold mr-4">{expiredCount} equipment with expired docs</span>}
          {expiringCount > 0 && <span className="text-yellow-400 font-bold">{expiringCount} expiring within 30 days</span>}
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="flex gap-1">
          {(['all', 'truck', 'trailer'] as const).map(f => (
            <button
              key={f}
              onClick={() => setTypeFilter(f)}
              className={`px-3 py-1.5 rounded text-sm ${typeFilter === f ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300'}`}
            >
              {f === 'all' ? 'All' : f === 'truck' ? 'Trucks' : 'Trailers'}
            </button>
          ))}
        </div>
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search equipment #..."
          className="px-3 py-1.5 bg-gray-700 text-white rounded text-sm w-48"
        />
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="px-3 py-1.5 bg-green-700 text-white rounded text-sm hover:bg-green-600"
        >
          + Add Equipment
        </button>
      </div>

      {/* Add equipment inline form */}
      {showAddForm && (
        <div className="mb-4 p-4 bg-gray-800 rounded-lg border border-gray-600">
          <h3 className="text-white font-semibold mb-3">Add Equipment</h3>
          <div className="flex gap-3 items-end">
            <div>
              <label className="text-gray-400 text-xs block mb-1">Type</label>
              <select
                value={addType}
                onChange={e => setAddType(e.target.value as 'truck' | 'trailer')}
                className="px-3 py-2 bg-gray-700 text-white rounded"
              >
                <option value="truck">Truck</option>
                <option value="trailer">Trailer</option>
              </select>
            </div>
            <div>
              <label className="text-gray-400 text-xs block mb-1">Number</label>
              <input
                type="text"
                value={addNumber}
                onChange={e => setAddNumber(e.target.value)}
                placeholder="e.g. 4608"
                className="px-3 py-2 bg-gray-700 text-white rounded w-40"
                autoCapitalize="characters"
              />
            </div>
            <button
              onClick={handleAddEquipment}
              disabled={!addNumber.trim()}
              className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-500 disabled:opacity-40"
            >
              Upload First Document
            </button>
            <button onClick={() => setShowAddForm(false)} className="px-3 py-2 text-gray-400 hover:text-white">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Message */}
      {message && (
        <div className="mb-4 p-2 bg-gray-700 text-green-400 rounded text-sm">
          {message}
          <button onClick={() => setMessage('')} className="ml-3 text-gray-400 hover:text-white">×</button>
        </div>
      )}

      {/* Loading */}
      {loading && <p className="text-gray-400">Loading equipment...</p>}

      {/* Equipment cards */}
      {!loading && filtered.length === 0 && (
        <p className="text-gray-500 text-center py-8">
          {groups.length === 0 ? 'No equipment documents yet. Upload your first document above.' : 'No equipment matches your filter.'}
        </p>
      )}

      <div className="space-y-3">
        {filtered.map(group => {
          const key = `${group.equipmentType}_${group.equipmentNumber}`;
          const isExpanded = expandedKey === key;
          const icon = group.equipmentType === 'truck' ? '🚛' : '🚜';
          const statusDot = group.worstExpiration === 'expired' ? 'bg-red-500' :
                            group.worstExpiration === 'expiring' ? 'bg-yellow-500' :
                            group.worstExpiration === 'valid' ? 'bg-green-500' : 'bg-gray-600';

          return (
            <div key={key} className="bg-gray-800 rounded-lg border border-gray-700">
              {/* Card header */}
              <button
                onClick={() => setExpandedKey(isExpanded ? null : key)}
                className="w-full flex items-center gap-3 p-4 text-left hover:bg-gray-750"
              >
                <span className="text-2xl">{icon}</span>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-white font-semibold text-lg">
                      {group.equipmentType === 'truck' ? 'Truck' : 'Trailer'} {group.equipmentNumber}
                    </span>
                    <span className={`w-2.5 h-2.5 rounded-full ${statusDot}`} />
                  </div>
                  <span className="text-gray-400 text-sm">
                    {group.documents.length} document{group.documents.length !== 1 ? 's' : ''}
                    {(() => {
                      const s = specsMap.get(`${group.equipmentType}_${group.equipmentNumber}`);
                      if (!s) return null;
                      const parts = [];
                      if (s.make) parts.push(`${s.year ? s.year + ' ' : ''}${s.make}`);
                      if (s.tareWeight) parts.push(`${(s.tareWeight / 1000).toFixed(1)}k lbs`);
                      if (s.bblCapacity) parts.push(`${s.bblCapacity} BBL`);
                      return parts.length > 0 ? <span className="text-gray-500 ml-2">· {parts.join(' · ')}</span> : null;
                    })()}
                  </span>
                </div>
                <span className="text-gray-400 text-xl">{isExpanded ? '▾' : '▸'}</span>
              </button>

              {/* Expanded: specs + document list + upload button */}
              {isExpanded && (
                <div className="border-t border-gray-700 p-4">
                  {/* Equipment specs */}
                  {(() => {
                    const specsKey = `${group.equipmentType}_${group.equipmentNumber}`;
                    const specs = specsMap.get(specsKey);
                    const isEditing = editingSpecs === specsKey;

                    return (
                      <div className="mb-4 pb-4 border-b border-gray-700/50">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-gray-400 text-xs font-bold uppercase tracking-wider">Vehicle Specs</span>
                          {!isEditing && (
                            <button
                              onClick={() => startEditSpecs(group)}
                              className="text-xs text-blue-400 hover:text-blue-300"
                            >
                              {specs ? 'Edit' : '+ Add Specs'}
                            </button>
                          )}
                        </div>

                        {isEditing ? (
                          <div className="space-y-2">
                            {/* Quick-select from common oilfield vehicles */}
                            {(() => {
                              const presets = group.equipmentType === 'truck' ? TRUCK_PRESETS : TRAILER_PRESETS;
                              const searchVal = `${specsDraft.make || ''} ${specsDraft.model || ''}`.trim().toLowerCase();
                              const filtered = searchVal.length >= 1
                                ? presets.filter(p => `${p.make} ${p.model}`.toLowerCase().includes(searchVal))
                                : presets;
                              const hasExactMatch = presets.some(p => p.make === specsDraft.make && p.model === specsDraft.model);
                              return !hasExactMatch && filtered.length > 0 ? (
                                <div className="flex flex-wrap gap-1">
                                  {filtered.slice(0, 8).map((p, i) => (
                                    <button
                                      key={i}
                                      className="px-2 py-1 bg-gray-700 hover:bg-gray-600 text-xs text-gray-300 rounded border border-gray-600"
                                      onClick={() => setSpecsDraft(d => ({
                                        ...d,
                                        make: p.make,
                                        model: p.model,
                                        tareWeight: p.tareWeight,
                                        ...(p.bblCapacity ? { bblCapacity: p.bblCapacity } : {}),
                                      }))}
                                    >
                                      {p.make} {p.model} <span className="text-gray-500">~{(p.tareWeight/1000).toFixed(1)}k{p.bblCapacity ? ` ${p.bblCapacity}BBL` : ''}</span>
                                    </button>
                                  ))}
                                </div>
                              ) : null;
                            })()}
                            <div className="grid grid-cols-3 gap-2">
                              <div>
                                <label className="text-gray-500 text-xs">Make</label>
                                <input
                                  type="text"
                                  value={specsDraft.make || ''}
                                  onChange={e => setSpecsDraft(d => ({ ...d, make: e.target.value }))}
                                  placeholder="e.g. Peterbilt"
                                  className="w-full px-2 py-1.5 bg-gray-700 text-white rounded text-sm"
                                />
                              </div>
                              <div>
                                <label className="text-gray-500 text-xs">Model</label>
                                <input
                                  type="text"
                                  value={specsDraft.model || ''}
                                  onChange={e => setSpecsDraft(d => ({ ...d, model: e.target.value }))}
                                  placeholder="e.g. 389"
                                  className="w-full px-2 py-1.5 bg-gray-700 text-white rounded text-sm"
                                />
                              </div>
                              <div>
                                <label className="text-gray-500 text-xs">Year</label>
                                <input
                                  type="text"
                                  value={specsDraft.year || ''}
                                  onChange={e => setSpecsDraft(d => ({ ...d, year: e.target.value }))}
                                  placeholder="e.g. 2022"
                                  className="w-full px-2 py-1.5 bg-gray-700 text-white rounded text-sm"
                                />
                              </div>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <div>
                                <label className="text-gray-500 text-xs">Tare Weight (lbs)</label>
                                <input
                                  type="number"
                                  value={specsDraft.tareWeight || ''}
                                  onChange={e => setSpecsDraft(d => ({ ...d, tareWeight: e.target.value ? Number(e.target.value) : undefined }))}
                                  placeholder={group.equipmentType === 'truck' ? 'e.g. 18000' : 'e.g. 6500'}
                                  className="w-full px-2 py-1.5 bg-gray-700 text-white rounded text-sm"
                                />
                              </div>
                              {group.equipmentType === 'trailer' && (
                                <div>
                                  <label className="text-gray-500 text-xs">BBL Capacity</label>
                                  <input
                                    type="number"
                                    value={specsDraft.bblCapacity || ''}
                                    onChange={e => setSpecsDraft(d => ({ ...d, bblCapacity: e.target.value ? Number(e.target.value) : undefined }))}
                                    placeholder="e.g. 130"
                                    className="w-full px-2 py-1.5 bg-gray-700 text-white rounded text-sm"
                                  />
                                </div>
                              )}
                            </div>
                            <div className="flex gap-2 mt-1">
                              <button
                                onClick={() => handleSaveSpecs(group)}
                                disabled={savingSpecs}
                                className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm disabled:opacity-50"
                              >
                                {savingSpecs ? 'Saving...' : 'Save'}
                              </button>
                              <button
                                onClick={() => setEditingSpecs(null)}
                                className="px-3 py-1 bg-gray-600 hover:bg-gray-500 text-white rounded text-sm"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : specs ? (
                          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                            {specs.make && <span className="text-gray-300">{specs.year ? `${specs.year} ` : ''}{specs.make}{specs.model ? ` ${specs.model}` : ''}</span>}
                            {specs.tareWeight && <span className="text-gray-400">Tare: <span className="text-white font-mono">{specs.tareWeight.toLocaleString()} lbs</span></span>}
                            {specs.bblCapacity && <span className="text-gray-400">Capacity: <span className="text-white font-mono">{specs.bblCapacity} BBL</span></span>}
                          </div>
                        ) : (
                          <span className="text-gray-600 text-xs">No specs entered</span>
                        )}
                      </div>
                    );
                  })()}

                  {/* Document list */}
                  {group.documents.map(d => (
                    <div key={d.id} className="flex items-center gap-3 py-3 border-b border-gray-700/50 last:border-0">
                      {d.storageUrl && (
                        <img src={d.storageUrl} alt="" className="w-16 h-12 object-cover rounded bg-gray-700" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-white font-medium truncate">{d.label}</div>
                        <div className="text-gray-400 text-xs">
                          {VEHICLE_DOC_TYPE_LABELS[d.type] || d.type}
                          {d.documentNumber && <span className="ml-2">#{d.documentNumber}</span>}
                          {d.state && <span className="ml-2">{d.state}</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {expirationBadge(d.expirationDate)}
                        <a href={d.storageUrl} target="_blank" rel="noopener" className="text-blue-400 hover:text-blue-300 text-sm">View</a>
                        <button onClick={() => handleDelete(d)} className="text-red-400 hover:text-red-300 text-sm">Delete</button>
                      </div>
                    </div>
                  ))}

                  {/* Upload button */}
                  <button
                    onClick={() => setUploadTarget({ type: group.equipmentType, number: group.equipmentNumber })}
                    className="mt-3 w-full py-2 border border-dashed border-gray-600 rounded text-gray-400 hover:text-white hover:border-gray-400 text-sm"
                  >
                    + Upload Document
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Upload modal */}
      {uploadTarget && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-gray-800 rounded-lg w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              <h3 className="text-white text-lg font-semibold mb-1">
                Upload Document
              </h3>
              <p className="text-gray-400 text-sm mb-4">
                {uploadTarget.type === 'truck' ? 'Truck' : 'Trailer'} {uploadTarget.number}
              </p>

              {/* File picker */}
              <div className="mb-4">
                <label className="text-gray-400 text-xs font-bold block mb-1">Document Image</label>
                {uploadPreview ? (
                  <div className="relative">
                    <img src={uploadPreview} alt="" className="w-full h-48 object-contain bg-gray-900 rounded" />
                    <button
                      onClick={() => { setUploadFile(null); if (uploadPreview) URL.revokeObjectURL(uploadPreview); setUploadPreview(null); }}
                      className="absolute top-2 right-2 bg-gray-700 text-white w-6 h-6 rounded-full text-sm hover:bg-red-600"
                    >×</button>
                  </div>
                ) : (
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full py-8 border-2 border-dashed border-gray-600 rounded-lg text-gray-400 hover:text-white hover:border-gray-400"
                  >
                    Click to select image
                  </button>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={handleFileSelect}
                  className="hidden"
                />
              </div>

              {/* Document type */}
              <div className="mb-3">
                <label className="text-gray-400 text-xs font-bold block mb-1">Type</label>
                <select
                  value={uploadDocType}
                  onChange={e => { setUploadDocType(e.target.value as VehicleDocType); if (!uploadLabel) setUploadLabel(''); }}
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded"
                >
                  {VEHICLE_DOC_TYPES.map(t => (
                    <option key={t} value={t}>{VEHICLE_DOC_TYPE_LABELS[t]}</option>
                  ))}
                </select>
              </div>

              {/* Label */}
              <div className="mb-3">
                <label className="text-gray-400 text-xs font-bold block mb-1">Label</label>
                <input
                  type="text"
                  value={uploadLabel}
                  onChange={e => setUploadLabel(e.target.value)}
                  placeholder={VEHICLE_DOC_TYPE_LABELS[uploadDocType]}
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded"
                />
              </div>

              {/* Row: Expiration + Issued */}
              <div className="flex gap-3 mb-3">
                <div className="flex-1">
                  <label className="text-gray-400 text-xs font-bold block mb-1">Expiration Date</label>
                  <input
                    type="date"
                    value={uploadExpiration}
                    onChange={e => setUploadExpiration(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-700 text-white rounded"
                  />
                </div>
                <div className="flex-1">
                  <label className="text-gray-400 text-xs font-bold block mb-1">Issued Date</label>
                  <input
                    type="date"
                    value={uploadIssuedDate}
                    onChange={e => setUploadIssuedDate(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-700 text-white rounded"
                  />
                </div>
              </div>

              {/* Row: Doc # + State */}
              <div className="flex gap-3 mb-3">
                <div className="flex-1">
                  <label className="text-gray-400 text-xs font-bold block mb-1">Document #</label>
                  <input
                    type="text"
                    value={uploadDocNumber}
                    onChange={e => setUploadDocNumber(e.target.value)}
                    placeholder="Optional"
                    className="w-full px-3 py-2 bg-gray-700 text-white rounded"
                  />
                </div>
                <div className="w-24">
                  <label className="text-gray-400 text-xs font-bold block mb-1">State</label>
                  <input
                    type="text"
                    value={uploadState}
                    onChange={e => setUploadState(e.target.value.toUpperCase())}
                    placeholder="ND"
                    maxLength={2}
                    className="w-full px-3 py-2 bg-gray-700 text-white rounded"
                  />
                </div>
              </div>

              {/* Notes */}
              <div className="mb-4">
                <label className="text-gray-400 text-xs font-bold block mb-1">Notes</label>
                <textarea
                  value={uploadNotes}
                  onChange={e => setUploadNotes(e.target.value)}
                  placeholder="Optional"
                  rows={2}
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded resize-none"
                />
              </div>

              {/* Actions */}
              <div className="flex gap-3">
                <button
                  onClick={handleUpload}
                  disabled={!uploadFile || uploading}
                  className="flex-1 py-2 bg-blue-600 text-white rounded font-semibold hover:bg-blue-500 disabled:opacity-40"
                >
                  {uploading ? 'Uploading...' : 'Upload'}
                </button>
                <button
                  onClick={resetUploadForm}
                  className="px-4 py-2 bg-gray-700 text-gray-300 rounded hover:bg-gray-600"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
