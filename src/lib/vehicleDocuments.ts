// Vehicle document types, Firestore CRUD, and Firebase Storage upload
// for the Equipment tab in Admin.
import { getFirestoreDb, getFirebaseStorage } from './firebase';
import {
  collection, query, where, getDocs, addDoc, deleteDoc, doc,
  Timestamp, orderBy, getDoc, setDoc,
} from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';

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

function storagePath(companyId: string, equipmentType: string, equipmentNumber: string, docId: string): string {
  return `vehicle_documents/${companyId}/${equipmentType}_${equipmentNumber}/${docId}.jpg`;
}

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

/** Upload image to Storage, create Firestore doc. */
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
  const db = getFirestoreDb();
  const storage = getFirebaseStorage();

  // Generate a doc ID first so we can use it in the storage path
  const tempRef = doc(collection(db, 'vehicle_documents'));
  const docId = tempRef.id;

  // Upload to Storage
  const path = storagePath(companyId, equipmentType, equipmentNumber, docId);
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, file, { contentType: file.type || 'image/jpeg' });
  const storageUrl = await getDownloadURL(storageRef);

  // Create Firestore doc
  const now = Timestamp.now();
  const docData = {
    companyId,
    equipmentType,
    equipmentNumber: equipmentNumber.trim().toUpperCase(),
    type: metadata.type,
    label: metadata.label || VEHICLE_DOC_TYPE_LABELS[metadata.type],
    storageUrl,
    storagePath: path,
    expirationDate: metadata.expirationDate || null,
    issuedDate: metadata.issuedDate || null,
    documentNumber: metadata.documentNumber || null,
    state: metadata.state || null,
    notes: metadata.notes || null,
    uploadedBy: metadata.uploadedBy,
    createdAt: now,
    updatedAt: now,
  };

  // Use the pre-generated doc ref
  const { setDoc } = await import('firebase/firestore');
  await setDoc(tempRef, docData);

  return {
    id: docId,
    ...docData,
    expirationDate: docData.expirationDate || undefined,
    issuedDate: docData.issuedDate || undefined,
    documentNumber: docData.documentNumber || undefined,
    state: docData.state || undefined,
    notes: docData.notes || undefined,
    createdAt: now.toDate().toISOString(),
    updatedAt: now.toDate().toISOString(),
  };
}

/** Delete vehicle document from Firestore + Storage. */
export async function deleteVehicleDocument(docId: string, docStoragePath?: string): Promise<void> {
  const db = getFirestoreDb();
  const storage = getFirebaseStorage();

  // Delete Firestore doc
  await deleteDoc(doc(db, 'vehicle_documents', docId));

  // Delete Storage file (best effort)
  if (docStoragePath) {
    try {
      await deleteObject(ref(storage, docStoragePath));
    } catch (err) {
      console.warn('[vehicleDocuments] Failed to delete storage file:', err);
    }
  }
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
