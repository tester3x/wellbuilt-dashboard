// JSA Template types, Firestore CRUD, and Firebase Storage upload
// for the BYOJSA feature in Settings.
import { getFirestoreDb, getFirebaseFunctions } from './firebase';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';

// ── Types ──────────────────────────────────────────────────────────────────

export interface JsaHazardControl {
  hazard: string;
  controls: string;
}

export interface JsaTemplateStep {
  id: string;
  title: string;
  items: JsaHazardControl[];
}

export interface JsaPpeItem {
  id: string;
  label: string;
}

export interface JsaPreparedItem {
  id: string;
  label: string;
}

export interface JsaTemplate {
  companyId: string;
  name: string;
  steps: JsaTemplateStep[];
  ppeItems: JsaPpeItem[];
  preparedItems: JsaPreparedItem[];
  sourceFile?: {
    storageUrl: string;
    storagePath: string;
    fileName: string;
  };
  version: number;
  status: 'draft' | 'active';
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

// ── Cloud Function (upload + parse in one call) ───────────────────────────

export interface ParsedJsaResult {
  name: string;
  steps: JsaTemplateStep[];
  ppeItems: JsaPpeItem[];
  preparedItems: JsaPreparedItem[];
  storagePath: string;
  storageUrl: string;
}

/**
 * Convert a File to base64, send to Cloud Function which handles
 * both Storage upload and Claude AI parsing in one call.
 */
export async function uploadAndParseJsaPdf(
  companyId: string,
  file: File,
): Promise<ParsedJsaResult> {
  // Convert file to base64
  const buffer = await file.arrayBuffer();
  const base64 = btoa(
    new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
  );

  const fn = httpsCallable<
    { pdfBase64: string; fileName: string; companyId: string },
    ParsedJsaResult
  >(getFirebaseFunctions(), 'parseJsaPdf');
  const result = await fn({ pdfBase64: base64, fileName: file.name, companyId });
  return result.data;
}

// ── Firestore CRUD ─────────────────────────────────────────────────────────

const COLLECTION = 'jsa_templates';

export async function loadJsaTemplate(companyId: string): Promise<JsaTemplate | null> {
  const docRef = doc(getFirestoreDb(), COLLECTION, companyId);
  const snap = await getDoc(docRef);
  if (!snap.exists()) return null;
  return { ...snap.data(), companyId } as JsaTemplate;
}

export async function saveJsaTemplate(
  companyId: string,
  template: Partial<JsaTemplate>,
  userId: string,
): Promise<void> {
  const docRef = doc(getFirestoreDb(), COLLECTION, companyId);
  const now = new Date().toISOString();

  // Check if doc exists to set createdAt only on first save
  const existing = await getDoc(docRef);

  await setDoc(docRef, {
    ...template,
    companyId,
    updatedAt: now,
    updatedBy: userId,
    ...(existing.exists() ? {} : { createdAt: now, version: 1, status: 'draft' }),
  }, { merge: true });
}

export async function activateJsaTemplate(
  companyId: string,
  userId: string,
): Promise<void> {
  const docRef = doc(getFirestoreDb(), COLLECTION, companyId);
  const snap = await getDoc(docRef);
  const currentVersion = snap.exists() ? (snap.data().version || 0) : 0;

  await setDoc(docRef, {
    status: 'active',
    version: currentVersion + 1,
    updatedAt: new Date().toISOString(),
    updatedBy: userId,
  }, { merge: true });
}

export async function deactivateJsaTemplate(companyId: string): Promise<void> {
  const docRef = doc(getFirestoreDb(), COLLECTION, companyId);
  await setDoc(docRef, {
    status: 'draft',
    updatedAt: new Date().toISOString(),
  }, { merge: true });
}
