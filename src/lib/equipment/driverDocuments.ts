/**
 * WB eQuipment — Driver documents client (eQuipmentDocuments callable).
 */

import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from '../firebase';

export interface DriverDocumentCapture {
  captureId: string;
  kind: string;
  cloudUri?: string;
  storagePath?: string;
}

export interface DriverDocumentRecord {
  id: string;
  driverHash: string;
  companyId?: string;
  type: string;
  label: string;
  cloudUri?: string;
  storagePath?: string;
  captures?: DriverDocumentCapture[];
  documentStatus?: string;
  typeClaim?: string;
  expirationDate?: string;
  issuedDate?: string;
  documentNumber?: string;
  state?: string;
  notes?: string;
  personal?: boolean;
  syncedAt?: string;
  createdAt: string;
  updatedAt: string;
}

type DocumentDashboardAction = 'dashboard.listDocuments' | 'dashboard.getDocument';

async function callDocuments<T = Record<string, unknown>>(
  action: DocumentDashboardAction,
  payload: Record<string, unknown>,
): Promise<T> {
  const fn = httpsCallable(getFirebaseFunctions(), 'eQuipmentDocuments');
  const result = await fn({ action, payload });
  return result.data as T;
}

export async function listDriverDocumentsForCompany(
  companyId: string,
  limit = 200,
): Promise<DriverDocumentRecord[]> {
  const res = await callDocuments<{ documents?: DriverDocumentRecord[] }>(
    'dashboard.listDocuments',
    { companyId, limit },
  );
  return res.documents || [];
}

export async function getDriverDocument(
  companyId: string,
  documentId: string,
): Promise<DriverDocumentRecord | null> {
  const res = await callDocuments<{ document?: DriverDocumentRecord }>(
    'dashboard.getDocument',
    { companyId, documentId },
  );
  return res.document || null;
}

export function documentPresentationStatus(doc: DriverDocumentRecord): string {
  if (doc.expirationDate && new Date(doc.expirationDate) < new Date()) return 'Expired';
  if (doc.documentStatus === 'needs_review') return 'Needs Review';
  if (doc.type === 'cdl') {
    const kinds = new Set((doc.captures || []).map((c) => c.kind));
    if (!kinds.has('front') || !kinds.has('back')) return 'Missing Capture';
  }
  if (doc.documentStatus === 'captured' || doc.documentStatus === 'processing') return 'Submitted';
  return 'Submitted';
}

export function orderedCaptures(doc: DriverDocumentRecord): DriverDocumentCapture[] {
  const captures = [...(doc.captures || [])];
  if (captures.length === 0 && doc.cloudUri) {
    return [{ captureId: `${doc.id}_attachment`, kind: 'attachment', cloudUri: doc.cloudUri, storagePath: doc.storagePath }];
  }
  const order = ['front', 'back', 'page', 'attachment'];
  return captures.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}