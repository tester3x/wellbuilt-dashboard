'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { AppHeader } from '@/components/AppHeader';
import {
  hasCapability,
  hasEQuipmentAccess,
  type Capability,
} from '@/lib/auth';
import { loadAllCompanies, type CompanyConfig } from '@/lib/companySettings';
import { isPlatformAdmin } from '@/lib/auth';
import { listEquipment } from '@/lib/equipment/registry';
import { listAssignmentsForCompany } from '@/lib/equipment/assignments';
import { listDvirInspectionsForCompany, getDvirInspection } from '@/lib/equipment/dvir';
import {
  listDriverDocumentsForCompany,
  getDriverDocument,
  documentPresentationStatus,
  orderedCaptures,
  type DriverDocumentRecord,
} from '@/lib/equipment/driverDocuments';
import { resolveDriverNames } from '@/lib/equipment/driverNames';
import {
  EQUIPMENT_STATUS_LABELS,
  type Equipment,
} from '@/lib/equipment/types';
import {
  ASSIGNMENT_ROLE_LABELS,
  type Assignment,
} from '@/lib/equipment/assignmentTypes';
import type { PreTripInspectionRecord } from '@/lib/equipment/dvirContracts';

type Section = 'overview' | 'equipment' | 'assignments' | 'dvir' | 'documents';

const SECTIONS: { id: Section; label: string; cap: Capability }[] = [
  { id: 'overview', label: 'Overview', cap: 'viewEQuipment' },
  { id: 'equipment', label: 'Equipment', cap: 'viewEQuipment' },
  { id: 'assignments', label: 'Assignments', cap: 'viewEQuipment' },
  { id: 'dvir', label: 'DVIR', cap: 'viewDVIR' },
  { id: 'documents', label: 'Documents', cap: 'viewEquipmentDocuments' },
];

function formatDateTime(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function resultBadge(result: string) {
  const pass = result === 'pass';
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-semibold ${pass ? 'bg-emerald-900/40 text-emerald-300' : 'bg-amber-900/40 text-amber-300'}`}>
      {pass ? 'Pass' : 'Needs Attention'}
    </span>
  );
}

export default function EquipmentPage() {
  const { user, userCompany, loading } = useAuth();
  const router = useRouter();
  const [section, setSection] = useState<Section>('overview');
  const [companies, setCompanies] = useState<CompanyConfig[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState('');
  const [dataLoading, setDataLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [inspections, setInspections] = useState<PreTripInspectionRecord[]>([]);
  const [needsAttentionCount, setNeedsAttentionCount] = useState(0);
  const [documents, setDocuments] = useState<DriverDocumentRecord[]>([]);
  const [driverNames, setDriverNames] = useState<Record<string, string>>({});

  const [selectedInspection, setSelectedInspection] = useState<PreTripInspectionRecord | null>(null);
  const [selectedDocument, setSelectedDocument] = useState<DriverDocumentRecord | null>(null);
  const [docPageIndex, setDocPageIndex] = useState(0);

  const effectiveCompanyId = selectedCompanyId || user?.companyId || '';

  const visibleSections = useMemo(() => {
    if (!hasEQuipmentAccess(user, userCompany)) return [];
    return SECTIONS.filter((s) => {
      if (s.id === 'overview' || s.id === 'equipment' || s.id === 'assignments') {
        return hasCapability(user, 'viewEQuipment', userCompany)
          || hasCapability(user, 'manageEquipment', userCompany)
          || hasCapability(user, 'manageEquipmentAssignments', userCompany);
      }
      if (s.id === 'dvir') {
        return hasCapability(user, 'viewDVIR', userCompany) || hasCapability(user, 'manageDVIR', userCompany);
      }
      if (s.id === 'documents') {
        return hasCapability(user, 'viewEquipmentDocuments', userCompany)
          || hasCapability(user, 'manageEquipmentDocuments', userCompany);
      }
      return true;
    });
  }, [user, userCompany]);

  useEffect(() => {
    if (!loading && !user) router.push('/login');
    if (!loading && user && !hasEQuipmentAccess(user, userCompany)) router.push('/');
  }, [user, loading, userCompany, router]);

  useEffect(() => {
    if (!user || !isPlatformAdmin(user)) return;
    loadAllCompanies().then(setCompanies).catch(() => {});
  }, [user]);

  useEffect(() => {
    if (user?.companyId) setSelectedCompanyId(user.companyId);
  }, [user?.companyId]);

  const loadData = useCallback(async () => {
    if (!effectiveCompanyId) return;
    setDataLoading(true);
    setError(null);
    try {
      const [equipRes, assignmentList, dvirRes, docList] = await Promise.all([
        hasCapability(user, 'viewEQuipment', userCompany) || hasCapability(user, 'manageEquipment', userCompany)
          ? listEquipment(effectiveCompanyId, { activeOnly: false })
          : Promise.resolve({ equipment: [], types: [] }),
        hasCapability(user, 'viewEQuipment', userCompany) || hasCapability(user, 'manageEquipmentAssignments', userCompany)
          ? listAssignmentsForCompany(effectiveCompanyId)
          : Promise.resolve([]),
        hasCapability(user, 'viewDVIR', userCompany) || hasCapability(user, 'manageDVIR', userCompany)
          ? listDvirInspectionsForCompany(effectiveCompanyId)
          : Promise.resolve({ inspections: [], needsAttentionCount: 0 }),
        hasCapability(user, 'viewEquipmentDocuments', userCompany) || hasCapability(user, 'manageEquipmentDocuments', userCompany)
          ? listDriverDocumentsForCompany(effectiveCompanyId)
          : Promise.resolve([]),
      ]);

      setEquipment(equipRes.equipment || []);
      setAssignments(assignmentList);
      setInspections(dvirRes.inspections);
      setNeedsAttentionCount(dvirRes.needsAttentionCount);
      setDocuments(docList);

      const hashes = [
        ...assignmentList.map((a) => a.driverHash),
        ...dvirRes.inspections.map((i) => i.driverHash),
        ...docList.map((d) => d.driverHash),
      ];
      setDriverNames(await resolveDriverNames(hashes));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load eQuipment data';
      setError(message);
    } finally {
      setDataLoading(false);
    }
  }, [effectiveCompanyId, user, userCompany]);

  useEffect(() => {
    if (user && effectiveCompanyId) loadData();
  }, [user, effectiveCompanyId, loadData]);

  const activeEquipmentCount = equipment.filter((e) => e.active).length;
  const expiringDocs = documents.filter((d) => {
    if (!d.expirationDate) return false;
    const days = (new Date(d.expirationDate).getTime() - Date.now()) / 86400000;
    return days >= 0 && days <= 60;
  }).length;

  const assignmentByEquipment = useMemo(() => {
    const map = new Map<string, Assignment>();
    for (const a of assignments) {
      if (a.active) map.set(a.equipmentId, a);
    }
    return map;
  }, [assignments]);

  const openInspection = async (inspectionId: string) => {
    const detail = await getDvirInspection(effectiveCompanyId, inspectionId);
    setSelectedInspection(detail);
  };

  const openDocument = async (documentId: string) => {
    const detail = await getDriverDocument(effectiveCompanyId, documentId);
    setSelectedDocument(detail);
    setDocPageIndex(0);
  };

  if (loading || !user) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-white">Loading...</div>
      </div>
    );
  }

  if (!hasEQuipmentAccess(user, userCompany)) return null;

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <AppHeader />
      <main className="max-w-7xl mx-auto px-4 py-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-bold">WB eQuipment</h1>
            <p className="text-gray-400 text-sm">Equipment, assignments, inspections, and driver documents</p>
          </div>
          {isPlatformAdmin(user) && companies.length > 0 && (
            <select
              value={effectiveCompanyId}
              onChange={(e) => setSelectedCompanyId(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
            >
              {companies.map((c) => (
                <option key={c.id} value={c.id}>{c.name || c.id}</option>
              ))}
            </select>
          )}
        </div>

        <nav className="flex gap-1 overflow-x-auto border-b border-gray-700 mb-6">
          {visibleSections.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setSection(tab.id)}
              className={`px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                section === tab.id
                  ? 'border-blue-500 text-white'
                  : 'border-transparent text-gray-400 hover:text-gray-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        {error && (
          <div className="mb-4 p-3 rounded bg-red-900/30 border border-red-700 text-red-200 text-sm">{error}</div>
        )}

        {dataLoading && <div className="text-gray-400 py-8 text-center">Loading platform data...</div>}

        {!dataLoading && section === 'overview' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[
              { label: 'Active Equipment', value: activeEquipmentCount, onClick: () => setSection('equipment') },
              { label: 'Active Assignments', value: assignments.filter((a) => a.active).length, onClick: () => setSection('assignments') },
              { label: 'Submitted Pre-Trip Inspections', value: inspections.length, onClick: () => setSection('dvir') },
              { label: 'Inspections Needing Attention', value: needsAttentionCount, onClick: () => setSection('dvir') },
              { label: 'Driver Documents', value: documents.length, onClick: () => setSection('documents') },
              { label: 'Expiring Documents (60d)', value: expiringDocs, onClick: () => setSection('documents') },
            ].map((card) => (
              <button
                key={card.label}
                type="button"
                onClick={card.onClick}
                className="text-left bg-gray-800 border border-gray-700 rounded-lg p-5 hover:border-blue-600 transition-colors"
              >
                <div className="text-3xl font-bold">{card.value}</div>
                <div className="text-gray-400 text-sm mt-1">{card.label}</div>
              </button>
            ))}
          </div>
        )}

        {!dataLoading && section === 'equipment' && (
          <div className="overflow-x-auto rounded-lg border border-gray-700">
            <table className="w-full text-sm">
              <thead className="bg-gray-800 text-gray-400">
                <tr>
                  <th className="text-left p-3">Unit</th>
                  <th className="text-left p-3">Type</th>
                  <th className="text-left p-3">Status</th>
                  <th className="text-left p-3">Active</th>
                  <th className="text-left p-3">Assignment</th>
                </tr>
              </thead>
              <tbody>
                {equipment.map((item) => {
                  const assignment = assignmentByEquipment.get(item.equipmentId);
                  return (
                    <tr key={item.equipmentId} className="border-t border-gray-700 hover:bg-gray-800/50">
                      <td className="p-3 font-medium">{item.unitNumber}</td>
                      <td className="p-3">{item.equipmentTypeId}</td>
                      <td className="p-3">{EQUIPMENT_STATUS_LABELS[item.status] || item.status}</td>
                      <td className="p-3">{item.active ? 'Active' : 'Retired'}</td>
                      <td className="p-3 text-gray-300">
                        {assignment
                          ? `${driverNames[assignment.driverHash] || assignment.driverHash.slice(0, 8)} · ${ASSIGNMENT_ROLE_LABELS[assignment.assignmentRole]}`
                          : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {!dataLoading && section === 'assignments' && (
          <div className="overflow-x-auto rounded-lg border border-gray-700">
            <table className="w-full text-sm">
              <thead className="bg-gray-800 text-gray-400">
                <tr>
                  <th className="text-left p-3">Equipment</th>
                  <th className="text-left p-3">Driver</th>
                  <th className="text-left p-3">Custody Role</th>
                  <th className="text-left p-3">Started</th>
                  <th className="text-left p-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {assignments.filter((a) => a.active).map((a) => {
                  const equip = equipment.find((e) => e.equipmentId === a.equipmentId);
                  return (
                    <tr key={a.assignmentId} className="border-t border-gray-700 hover:bg-gray-800/50">
                      <td className="p-3">{equip ? `${equip.equipmentTypeId} ${equip.unitNumber}` : a.equipmentId}</td>
                      <td className="p-3">{driverNames[a.driverHash] || a.driverHash.slice(0, 8)}</td>
                      <td className="p-3">{ASSIGNMENT_ROLE_LABELS[a.assignmentRole]}</td>
                      <td className="p-3">{formatDateTime(a.startedAt)}</td>
                      <td className="p-3">Canonical · Active</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {!dataLoading && section === 'dvir' && (
          <div className="overflow-x-auto rounded-lg border border-gray-700">
            <table className="w-full text-sm">
              <thead className="bg-gray-800 text-gray-400">
                <tr>
                  <th className="text-left p-3">Submitted</th>
                  <th className="text-left p-3">Equipment</th>
                  <th className="text-left p-3">Driver</th>
                  <th className="text-left p-3">Type</th>
                  <th className="text-left p-3">Result</th>
                </tr>
              </thead>
              <tbody>
                {inspections.map((insp) => (
                  <tr
                    key={insp.inspectionId}
                    className="border-t border-gray-700 hover:bg-gray-800/50 cursor-pointer"
                    onClick={() => openInspection(insp.inspectionId)}
                  >
                    <td className="p-3">{formatDateTime(insp.submittedAt)}</td>
                    <td className="p-3">{insp.equipmentLabel || insp.equipmentId}</td>
                    <td className="p-3">{insp.driverDisplayName || driverNames[insp.driverHash] || insp.driverHash.slice(0, 8)}</td>
                    <td className="p-3">Pre-Trip</td>
                    <td className="p-3">{resultBadge(insp.overallResult)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!dataLoading && section === 'documents' && (
          <div className="overflow-x-auto rounded-lg border border-gray-700">
            <table className="w-full text-sm">
              <thead className="bg-gray-800 text-gray-400">
                <tr>
                  <th className="text-left p-3">Type</th>
                  <th className="text-left p-3">Driver</th>
                  <th className="text-left p-3">Expiration</th>
                  <th className="text-left p-3">Captures</th>
                  <th className="text-left p-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((doc) => {
                  const captureKinds = (doc.captures || []).map((c) => c.kind).join(', ') || 'single';
                  return (
                    <tr
                      key={doc.id}
                      className="border-t border-gray-700 hover:bg-gray-800/50 cursor-pointer"
                      onClick={() => openDocument(doc.id)}
                    >
                      <td className="p-3">{doc.label || doc.type}</td>
                      <td className="p-3">{driverNames[doc.driverHash] || doc.driverHash.slice(0, 8)}</td>
                      <td className="p-3">{doc.expirationDate ? new Date(doc.expirationDate).toLocaleDateString() : '—'}</td>
                      <td className="p-3 capitalize">{captureKinds}</td>
                      <td className="p-3">{documentPresentationStatus(doc)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {selectedInspection && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={() => setSelectedInspection(null)}>
          <div className="bg-gray-900 border border-gray-700 rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-start mb-4">
              <h2 className="text-xl font-bold">Pre-Trip Inspection</h2>
              <button type="button" onClick={() => setSelectedInspection(null)} className="text-gray-400 hover:text-white">✕</button>
            </div>
            <div className="space-y-3 text-sm">
              <div className="flex justify-between"><span className="text-gray-400">Overall</span>{resultBadge(selectedInspection.overallResult)}</div>
              <div className="flex justify-between"><span className="text-gray-400">Equipment</span><span>{selectedInspection.equipmentLabel || selectedInspection.equipmentId}</span></div>
              <div className="flex justify-between"><span className="text-gray-400">Driver</span><span>{selectedInspection.driverDisplayName || driverNames[selectedInspection.driverHash]}</span></div>
              <div className="flex justify-between"><span className="text-gray-400">Signature</span><span>{selectedInspection.driverSignature || '—'}</span></div>
              <div className="flex justify-between"><span className="text-gray-400">Started</span><span>{formatDateTime(selectedInspection.startedAt)}</span></div>
              <div className="flex justify-between"><span className="text-gray-400">Submitted</span><span>{formatDateTime(selectedInspection.submittedAt)}</span></div>
              <div className="flex justify-between"><span className="text-gray-400">Assignment</span><span>{selectedInspection.assignmentRole || '—'} · {selectedInspection.assignmentSource || 'canonical'}</span></div>
            </div>
            <h3 className="font-semibold mt-6 mb-2">Categories</h3>
            <div className="space-y-2">
              {(selectedInspection.categories || []).map((cat) => (
                <div key={cat.categoryId} className="flex justify-between items-center py-1 border-b border-gray-800">
                  <span>{cat.categoryLabel}</span>
                  {resultBadge(cat.result)}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {selectedDocument && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={() => setSelectedDocument(null)}>
          <div className="bg-gray-900 border border-gray-700 rounded-lg max-w-3xl w-full max-h-[90vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-start mb-4">
              <h2 className="text-xl font-bold">{selectedDocument.label || selectedDocument.type}</h2>
              <button type="button" onClick={() => setSelectedDocument(null)} className="text-gray-400 hover:text-white">✕</button>
            </div>
            {(() => {
              const pages = orderedCaptures(selectedDocument);
              const page = pages[docPageIndex];
              return (
                <>
                  {page?.cloudUri && (
                    <img src={page.cloudUri} alt={page.kind} className="w-full max-h-96 object-contain bg-black rounded mb-3" />
                  )}
                  {pages.length > 1 && (
                    <div className="flex items-center justify-between mb-4">
                      <button type="button" disabled={docPageIndex <= 0} onClick={() => setDocPageIndex((i) => i - 1)} className="px-3 py-1 bg-gray-800 rounded disabled:opacity-40">←</button>
                      <span className="text-sm text-gray-400 capitalize">{page?.kind} {docPageIndex + 1} of {pages.length}</span>
                      <button type="button" disabled={docPageIndex >= pages.length - 1} onClick={() => setDocPageIndex((i) => i + 1)} className="px-3 py-1 bg-gray-800 rounded disabled:opacity-40">→</button>
                    </div>
                  )}
                </>
              );
            })()}
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div><span className="text-gray-400">Driver</span><div>{driverNames[selectedDocument.driverHash]}</div></div>
              <div><span className="text-gray-400">Status</span><div>{documentPresentationStatus(selectedDocument)}</div></div>
              <div><span className="text-gray-400">Expiration</span><div>{selectedDocument.expirationDate ? new Date(selectedDocument.expirationDate).toLocaleDateString() : '—'}</div></div>
              <div><span className="text-gray-400">License #</span><div>{selectedDocument.documentNumber || '—'}</div></div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}