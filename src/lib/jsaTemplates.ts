// JSA Template types, Firestore CRUD, and Firebase Storage upload
// for the BYOJSA feature in Settings.
// Supports multiple templates per company with package assignment.
import { getFirestoreDb, getFirebaseFunctions } from './firebase';
import {
  doc, getDoc, setDoc,
  collection, getDocs, runTransaction,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import {assignActiveJsaTemplate, normalizeJsaTasks, type ActiveJsaTaskTemplate} from './jsaTaskTemplates';

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
  packageId?: string | null;   // assigned job package (e.g. 'water-hauling'), undefined = default/unassigned
  tasks?: string[]; // empty = default assessment; otherwise applicable task names
  recordType?: 'revision';
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
  let templates = snap.docs.filter(d => d.data().recordType !== 'revision').map(d => ({ ...d.data(), id: d.id, companyId } as JsaTemplate));

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


  await runTransaction(getFirestoreDb(), async tx => {
    const current = await tx.get(ref);
    if (current.exists() && (current.data().status === 'active' || current.data().recordType === 'revision')) {
      throw new Error('Deactivate this template before editing. Published versions remain preserved.');
    }
    const {id: ignoredId, companyId: ignoredCompany, recordType: ignoredType, version: ignoredVersion, status: ignoredStatus, ...fields} = data;
    tx.set(ref, {
      ...fields, companyId,
      ...(data.packageId !== undefined || !current.exists() ? {packageId: data.packageId || null} : {}),
      ...(data.tasks !== undefined || !current.exists() ? {tasks: normalizeJsaTasks(data.tasks)} : {}),
      updatedAt: now, updatedBy: userId,
      ...(current.exists() ? {} : {createdAt: now, version: 0, status: 'draft'}),
    }, {merge: true});
  });

  return id;
}

/** Delete only an unpublished draft. Published source remains available for audit. */
export async function deleteJsaTemplate(companyId: string, templateId: string): Promise<void> {
  await runTransaction(getFirestoreDb(), async tx => {
    const ref = templateDoc(companyId, templateId), current = await tx.get(ref);
    if (!current.exists()) return;
    if (current.data().status === 'active' || current.data().recordType === 'revision' || current.data().version > 0)
      throw new Error('Published templates cannot be deleted. Deactivate them instead.');
    tx.delete(ref);
  });
}

/** Migrate the current active set on the first catalog write, under the mirror transaction lock. */
async function initialActive(companyId: string): Promise<ActiveJsaTaskTemplate[]> {
  return (await loadJsaTemplates(companyId)).filter(t => t.status === 'active').map(t => ({
    id:t.id, name:t.name, version:t.version, packageId:t.packageId || null, tasks:normalizeJsaTasks(t.tasks),
  }));
}

/** Publish a task template without disabling unrelated task assessments. */
export async function activateJsaTemplate(companyId: string, templateId: string, userId: string): Promise<void> {
  const initial = await initialActive(companyId);
  await runTransaction(getFirestoreDb(), async tx => {
    const mirrorRef = mirrorDoc(companyId), targetRef = templateDoc(companyId, templateId);
    const mirror = await tx.get(mirrorRef), target = await tx.get(targetRef);
    if (!target.exists() || target.data().recordType === 'revision') throw new Error('Template not found.');
    if (target.data().status === 'active') return;
    const source = target.data();
    if (!source.steps?.length) throw new Error('Review the parsed assessment before activating it.');
    const version = (source.version || 0) + 1;
    const published = {...source, tasks:normalizeJsaTasks(source.tasks), version, status:'active', updatedBy:userId, updatedAt:new Date().toISOString()};
    const active: ActiveJsaTaskTemplate[] = mirror.data()?.activeTemplates || initial;
    const next = assignActiveJsaTemplate(active, {id:templateId,name:source.name,version,packageId:source.packageId || null,tasks:published.tasks});
    // Snapshot each publication separately; edits to the draft never replace it.
    const revisionRef = templateDoc(companyId, templateId + '--published-v' + version);
    const existingRevision = await tx.get(revisionRef);
    if (existingRevision.exists()) throw new Error('Published version already exists. Reload templates.');
    tx.set(revisionRef, {...published, recordType:'revision', templateId});
    tx.set(targetRef,published);
    // Keep the legacy mirror on its explicit default. A task-specific activation
    // must not silently replace the assessment used by installed older apps.
    const useDefault = !published.tasks.length;
    tx.set(mirrorRef, {
      ...(mirror.exists() ? mirror.data() : {status:'draft'}),
      ...(useDefault ? published : {}),
      schemaVersion:2, activeTemplates:next,
      legacyTemplateId:useDefault ? templateId : (mirror.data()?.legacyTemplateId || initial.find(t=>!t.tasks.length)?.id || null),
      catalogUpdatedAt:published.updatedAt,
    });
  });
}

export async function deactivateJsaTemplate(companyId: string, templateId: string): Promise<void> {
  const initial = await initialActive(companyId);
  await runTransaction(getFirestoreDb(), async tx => {
    const mirrorRef = mirrorDoc(companyId), targetRef = templateDoc(companyId,templateId);
    const mirror = await tx.get(mirrorRef), target = await tx.get(targetRef);
    if (!target.exists() || target.data().recordType === 'revision') throw new Error('Template not found.');
    const active: ActiveJsaTaskTemplate[] = mirror.data()?.activeTemplates || initial;
    const legacyId = mirror.data()?.legacyTemplateId || initial.find(t=>!t.tasks.length)?.id;
    tx.update(targetRef,{status:'draft',updatedAt:new Date().toISOString()});
    tx.set(mirrorRef, {
      ...(mirror.data() || {}), schemaVersion:2,
      activeTemplates:active.filter(t=>t.id!==templateId),
      ...(legacyId===templateId ? {status:'draft',legacyTemplateId:null} : {}),
      catalogUpdatedAt:new Date().toISOString(),
    });
  });
}

// ── Legacy compat: load single template (old API) ────────────────────────

/** @deprecated Use loadJsaTemplates() instead. Kept for migration. */
export async function loadJsaTemplate(companyId: string): Promise<JsaTemplate | null> {
  const docRef = mirrorDoc(companyId);
  const snap = await getDoc(docRef);
  if (!snap.exists()) return null;
  return { ...snap.data(), id: 'legacy', companyId } as JsaTemplate;
}
