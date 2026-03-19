'use client';

import { useEffect, useState, useRef } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { loadAllCompanies, type CompanyConfig } from '@/lib/companySettings';
import {
  fetchVehicleDocuments, uploadVehicleDocument, deleteVehicleDocument,
  groupByEquipment, getExpirationStatus, daysUntilExpiration,
  VEHICLE_DOC_TYPES, VEHICLE_DOC_TYPE_LABELS,
  type VehicleDocument, type VehicleDocType, type EquipmentGroup,
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
      const docs = await fetchVehicleDocuments(effectiveCompanyId);
      setGroups(groupByEquipment(docs));
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

  // Add equipment = just open upload form for that number
  const handleAddEquipment = () => {
    if (!addNumber.trim()) return;
    setUploadTarget({ type: addType, number: addNumber.trim().toUpperCase() });
    setShowAddForm(false);
    setAddNumber('');
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
                  <span className="text-gray-400 text-sm">{group.documents.length} document{group.documents.length !== 1 ? 's' : ''}</span>
                </div>
                <span className="text-gray-400 text-xl">{isExpanded ? '▾' : '▸'}</span>
              </button>

              {/* Expanded: document list + upload button */}
              {isExpanded && (
                <div className="border-t border-gray-700 p-4">
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
