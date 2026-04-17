// JSA Template types, Firestore CRUD, and Firebase Storage upload
// for the BYOJSA feature in Settings.
// Supports multiple templates per company with package assignment.
import { getFirestoreDb, getFirebaseFunctions } from './firebase';
import {
  doc, getDoc, setDoc, deleteDoc,
  collection, getDocs, query, where, writeBatch,
} from 'firebase/firestore';
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
  id: string;           // Firestore doc ID
  companyId: string;
  name: string;
  packageId?: string;   // assigned job package (e.g. 'water-hauling'), undefined = default/unassigned
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

// ── Firestore paths ───────────────────────────────────────────────────────

const COLLECTION = 'jsa_templates';

/** Subcollection: jsa_templates/{companyId}/templates/{templateId} */
function templatesCol(companyId: string) {
  return collection(getFirestoreDb(), COLLECTION, companyId, 'templates');
}

function templateDoc(companyId: string, templateId: string) {
  return doc(getFirestoreDb(), COLLECTION, companyId, 'templates', templateId);
}

/** Top-level mirror doc read by the JSA phone app */
function mirrorDoc(companyId: string) {
  return doc(getFirestoreDb(), COLLECTION, companyId);
}

// ── CRUD ──────────────────────────────────────────────────────────────────

/** Load ALL templates for a company. Auto-migrates legacy single-doc format. */
export async function loadJsaTemplates(companyId: string): Promise<JsaTemplate[]> {
  const snap = await getDocs(templatesCol(companyId));
  let templates = snap.docs.map(d => ({ ...d.data(), id: d.id, companyId } as JsaTemplate));

  // Migrate legacy single-doc if subcollection is empty
  if (templates.length === 0) {
    const legacySnap = await getDoc(mirrorDoc(companyId));
    if (legacySnap.exists()) {
      const legacy = legacySnap.data();
      if (legacy.steps?.length) {
        const migratedId = `jsa-migrated`;
        const ref = templateDoc(companyId, migratedId);
        await setDoc(ref, {
          ...legacy,
          companyId,
          id: migratedId,
        });
        templates = [{ ...legacy, id: migratedId, companyId } as JsaTemplate];
      }
    }
  }

  return templates;
}

/** Load a single template by ID */
export async function loadJsaTemplateById(companyId: string, templateId: string): Promise<JsaTemplate | null> {
  const snap = await getDoc(templateDoc(companyId, templateId));
  if (!snap.exists()) return null;
  return { ...snap.data(), id: snap.id, companyId } as JsaTemplate;
}

/** Save (create or update) a template in the subcollection */
export async function saveJsaTemplate(
  companyId: string,
  templateId: string | null,
  data: Partial<JsaTemplate>,
  userId: string,
): Promise<string> {
  const now = new Date().toISOString();
  const id = templateId || `jsa-${Date.now()}`;
  const ref = templateDoc(companyId, id);
  const existing = templateId ? await getDoc(ref) : null;

  await setDoc(ref, {
    ...data,
    companyId,
    packageId: data.packageId || null,  // explicit null for "default/all packages"
    updatedAt: now,
    updatedBy: userId,
    ...(existing?.exists() ? {} : { createdAt: now, version: 1, status: data.status || 'draft' }),
  }, { merge: true });

  return id;
}

/** Delete a template (must be draft, not active) */
export async function deleteJsaTemplate(companyId: string, templateId: string): Promise<void> {
  await deleteDoc(templateDoc(companyId, templateId));
}

/**
 * Activate a template. Deactivates all others first.
 * Mirrors the active template to the top-level doc for JSA app compatibility.
 */
export async function activateJsaTemplate(
  companyId: string,
  templateId: string,
  userId: string,
): Promise<void> {
  const db = getFirestoreDb();
  const now = new Date().toISOString();

  // Deactivate all others
  const allSnap = await getDocs(templatesCol(companyId));
  const batch = writeBatch(db);
  for (const d of allSnap.docs) {
    if (d.id !== templateId && d.data().status === 'active') {
      batch.update(d.ref, { status: 'draft', updatedAt: now });
    }
  }

  // Activate target
  const targetRef = templateDoc(companyId, templateId);
  const targetSnap = await getDoc(targetRef);
  const currentVersion = targetSnap.exists() ? (targetSnap.data().version || 0) : 0;
  batch.update(targetRef, {
    status: 'active',
    version: currentVersion + 1,
    updatedAt: now,
    updatedBy: userId,
  });
  await batch.commit();

  // Mirror to top-level doc for JSA phone app
  const fresh = await getDoc(targetRef);
  if (fresh.exists()) {
    const mirrorData = { ...fresh.data(), status: 'active' };
    delete (mirrorData as any).id; // don't duplicate id field
    await setDoc(mirrorDoc(companyId), mirrorData);
  }
}

/** Deactivate a template. Clears the mirror doc. */
export async function deactivateJsaTemplate(
  companyId: string,
  templateId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await setDoc(templateDoc(companyId, templateId), {
    status: 'draft',
    updatedAt: now,
  }, { merge: true });

  // Check if any other template is active — if not, clear mirror
  const allSnap = await getDocs(templatesCol(companyId));
  const anyActive = allSnap.docs.some(d => d.id !== templateId && d.data().status === 'active');
  if (!anyActive) {
    await deleteDoc(mirrorDoc(companyId));
  }
}

// ── Legacy compat: load single template (old API) ────────────────────────

/** @deprecated Use loadJsaTemplates() instead. Kept for migration. */
export async function loadJsaTemplate(companyId: string): Promise<JsaTemplate | null> {
  const docRef = mirrorDoc(companyId);
  const snap = await getDoc(docRef);
  if (!snap.exists()) return null;
  return { ...snap.data(), id: 'legacy', companyId } as JsaTemplate;
}
