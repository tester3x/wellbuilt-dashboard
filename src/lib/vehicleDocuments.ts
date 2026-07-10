// Vehicle document types, Firestore read, and eQuipmentDocuments write path
// for the Equipment tab in Admin.
import { getFirestoreDb, getFirebaseFunctions } from './firebase';
import {
  collection, query, where, getDocs, doc, orderBy, setDoc,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';

// ── Types ──────────────────────────────────────────────────────────────────

export interface VehicleDocument {
  id: string;
  companyId: string;
  equipmentType: 'truck' | 'trailer';
  equipmentNumber: string;
  type: VehicleDocType;
  label: string;
  storageUrl: string;
  expirationDate?: string;
  issuedDate?: string;
  documentNumber?: string;
  state?: string;
  notes?: string;
  uploadedBy: string;
  createdAt: string;
  updatedAt: string;
}

export type VehicleDocType =
  | 'registration'
  | 'insurance'
  | 'dot_inspection'
  | 'ifta_permit'
  | 'other';

export const VEHICLE_DOC_TYPES: VehicleDocType[] = [
  'registration', 'insurance', 'dot_inspection', 'ifta_permit', 'other',
];

export const VEHICLE_DOC_TYPE_LABELS: Record<VehicleDocType, string> = {
  registration: 'Registration',
  insurance: 'Insurance',
  dot_inspection: 'DOT Inspection',
  ifta_permit: 'IFTA Permit',
  other: 'Other',
};

export const VEHICLE_DOC_TYPE_ICONS: Record<VehicleDocType, string> = {
  registration: '📄',
  insurance: '🛡️',
  dot_inspection: '🔍',
  ifta_permit: '📋',
  other: '📎',
};

// ── Helpers ────────────────────────────────────────────────────────────────

function parseTimestamp(val: any): string {
  if (!val) return '';
  if (val.toDate) return val.toDate().toISOString();
  if (typeof val === 'string') return val;
  return '';
}

// ── Firestore CRUD ─────────────────────────────────────────────────────────

/** Fetch all vehicle documents for a company. */
export async function fetchVehicleDocuments(companyId: string): Promise<VehicleDocument[]> {
  const db = getFirestoreDb();
  const q = query(
    collection(db, 'vehicle_documents'),
    where('companyId', '==', companyId),
    orderBy('updatedAt', 'desc'),
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => {
    const data = d.data();
    return {
      id: d.id,
      companyId: data.companyId,
      equipmentType: data.equipmentType,
      equipmentNumber: data.equipmentNumber,
      type: data.type,
      label: data.label || '',
      storageUrl: data.storageUrl || '',
      expirationDate: data.expirationDate || undefined,
      issuedDate: data.issuedDate || undefined,
      documentNumber: data.documentNumber || undefined,
      state: data.state || undefined,
      notes: data.notes || undefined,
      uploadedBy: data.uploadedBy || '',
      createdAt: parseTimestamp(data.createdAt),
      updatedAt: parseTimestamp(data.updatedAt),
    };
  });
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

async function callEquipmentDocuments(action: string, payload: Record<string, unknown>) {
  const fn = httpsCallable(getFirebaseFunctions(), 'eQuipmentDocuments');
  const result = await fn({ action, payload });
  return result.data as Record<string, unknown>;
}

/** Upload equipment document via eQuipmentDocuments (protected write path). */
export async function uploadVehicleDocument(
  companyId: string,
  equipmentType: 'truck' | 'trailer',
  equipmentNumber: string,
  file: File,
  metadata: {
    type: VehicleDocType;
    label: string;
    expirationDate?: string;
    issuedDate?: string;
    documentNumber?: string;
    state?: string;
    notes?: string;
    uploadedBy: string;
  },
): Promise<VehicleDocument> {
  const imageBase64 = await fileToBase64(file);
  const res = await callEquipmentDocuments('equipment.uploadDocument', {
    companyId,
    equipmentType,
    equipmentNumber,
    imageBase64,
    contentType: file.type || 'image/jpeg',
    metadata: {
      type: metadata.type,
      label: metadata.label || VEHICLE_DOC_TYPE_LABELS[metadata.type],
      expirationDate: metadata.expirationDate,
      issuedDate: metadata.issuedDate,
      documentNumber: metadata.documentNumber,
      state: metadata.state,
      notes: metadata.notes,
      uploadedBy: metadata.uploadedBy,
    },
  });

  const document = res.document as VehicleDocument;
  if (!document?.id) {
    throw new Error('Upload succeeded but no document returned');
  }
  return document;
}

/** Remove equipment document via eQuipmentDocuments (protected write path). */
export async function deleteVehicleDocument(
  docId: string,
  companyId: string,
): Promise<void> {
  await callEquipmentDocuments('equipment.removeDocument', { companyId, docId });
}

// ── Expiration helpers ─────────────────────────────────────────────────────

export function isDocExpired(expirationDate?: string): boolean {
  if (!expirationDate) return false;
  return new Date(expirationDate) < new Date();
}

export function daysUntilExpiration(expirationDate?: string): number | null {
  if (!expirationDate) return null;
  const diff = new Date(expirationDate).getTime() - Date.now();
  return Math.ceil(diff / 86400000);
}

export function getExpirationStatus(expirationDate?: string): 'expired' | 'expiring' | 'valid' | 'none' {
  if (!expirationDate) return 'none';
  const days = daysUntilExpiration(expirationDate);
  if (days === null) return 'none';
  if (days < 0) return 'expired';
  if (days <= 30) return 'expiring';
  return 'valid';
}

// ── Equipment grouping ─────────────────────────────────────────────────────

export interface EquipmentGroup {
  equipmentType: 'truck' | 'trailer';
  equipmentNumber: string;
  documents: VehicleDocument[];
  worstExpiration: 'expired' | 'expiring' | 'valid' | 'none';
}

/** Group documents by equipment, compute worst expiration per group. */
export function groupByEquipment(docs: VehicleDocument[]): EquipmentGroup[] {
  const map = new Map<string, VehicleDocument[]>();
  for (const d of docs) {
    const key = `${d.equipmentType}_${d.equipmentNumber}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(d);
  }

  const groups: EquipmentGroup[] = [];
  for (const [, groupDocs] of map) {
    const statuses = groupDocs.map(d => getExpirationStatus(d.expirationDate));
    let worst: 'expired' | 'expiring' | 'valid' | 'none' = 'none';
    if (statuses.includes('expired')) worst = 'expired';
    else if (statuses.includes('expiring')) worst = 'expiring';
    else if (statuses.includes('valid')) worst = 'valid';

    groups.push({
      equipmentType: groupDocs[0].equipmentType,
      equipmentNumber: groupDocs[0].equipmentNumber,
      documents: groupDocs,
      worstExpiration: worst,
    });
  }

  // Sort: trucks first, then by number
  groups.sort((a, b) => {
    if (a.equipmentType !== b.equipmentType) return a.equipmentType === 'truck' ? -1 : 1;
    return a.equipmentNumber.localeCompare(b.equipmentNumber);
  });

  return groups;
}

// ── Equipment Specs ─────────────────────────────────────────────────────────
// Physical specs for trucks and trailers (tare weight, capacity, etc.)
// Stored in Firestore: companies/{companyId}/equipment_specs/{type}_{number}

export interface EquipmentSpecs {
  equipmentType: 'truck' | 'trailer';
  equipmentNumber: string;
  tareWeight?: number;       // lbs, empty vehicle weight
  bblCapacity?: number;      // trailer only: max BBLs
  make?: string;             // e.g. "Peterbilt", "Heil"
  model?: string;            // e.g. "389"
  year?: string;             // e.g. "2022"
  // Trailer-specific
  material?: 'aluminum' | 'steel' | 'fiberglass';
  axles?: 2 | 3 | 4;
}

/** Fetch equipment specs for a company. Returns a map keyed by "type_number". */
export async function fetchEquipmentSpecs(companyId: string): Promise<Map<string, EquipmentSpecs>> {
  const db = getFirestoreDb();
  const snap = await getDocs(collection(db, 'companies', companyId, 'equipment_specs'));
  const map = new Map<string, EquipmentSpecs>();
  snap.forEach(d => {
    const data = d.data() as EquipmentSpecs;
    map.set(d.id, data);
  });
  return map;
}

/** Save equipment specs. */
export async function saveEquipmentSpecs(companyId: string, specs: EquipmentSpecs): Promise<void> {
  const db = getFirestoreDb();
  const key = `${specs.equipmentType}_${specs.equipmentNumber}`;
  await setDoc(doc(db, 'companies', companyId, 'equipment_specs', key), specs, { merge: true });
}
