// JSA Template types, Firestore CRUD, and Firebase Storage upload
// for the BYOJSA feature in Settings.
// Supports multiple templates per company with package assignment.
import { getFirestoreDb, getFirebaseFunctions } from './firebase';
import {
  doc, getDoc, collection, getDocs,
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

export type JsaLocationsCoveredPlacement = 'after-job-details' | 'after-assessment' | 'after-signature';
export type JsaLocationDifferencesPlacement = 'after-assessment' | 'after-signature';

/**
 * Repeatable, data-backed blocks in the customer's published JSA layout.
 * They control presentation only; location evidence remains structured.
 */
export interface JsaLocationLayout {
  schemaVersion: 1;
  locationsCoveredPlacement: JsaLocationsCoveredPlacement;
  locationDifferencesPlacement: JsaLocationDifferencesPlacement;
}

export const DEFAULT_JSA_LOCATION_LAYOUT: JsaLocationLayout = {
  schemaVersion: 1,
  locationsCoveredPlacement: 'after-job-details',
  locationDifferencesPlacement: 'after-assessment',
};

export function normalizeJsaLocationLayout(value: unknown): JsaLocationLayout {
  const candidate = value as Partial<JsaLocationLayout> | null;
  const covered = candidate?.locationsCoveredPlacement;
  const differences = candidate?.locationDifferencesPlacement;
  return {
    schemaVersion: 1,
    locationsCoveredPlacement: covered === 'after-job-details' || covered === 'after-assessment' || covered === 'after-signature'
      ? covered
      : DEFAULT_JSA_LOCATION_LAYOUT.locationsCoveredPlacement,
    locationDifferencesPlacement: differences === 'after-assessment' || differences === 'after-signature'
      ? differences
      : DEFAULT_JSA_LOCATION_LAYOUT.locationDifferencesPlacement,
  };
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
  locationLayout?: JsaLocationLayout;
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

  // Legacy reads are side-effect free. Import explicitly through the callable.
  if (!templates.length) {
    const legacy = await getDoc(mirrorDoc(companyId));
    if (legacy.exists() && legacy.data().steps?.length)
      templates = [{...legacy.data(), id:'legacy', companyId} as JsaTemplate];
  }

  return templates;
}

/** Load a single template by ID */
export async function loadJsaTemplateById(companyId: string, templateId: string): Promise<JsaTemplate | null> {
  const snap = await getDoc(templateDoc(companyId, templateId));
  if (!snap.exists()) return null;
  return { ...snap.data(), id: snap.id, companyId } as JsaTemplate;
}

/** All mutations run under server-verified company staff membership. */
async function manage(companyId:string, templateId:string, operation:string, data?:Partial<JsaTemplate>) {
  const fn=httpsCallable<{companyId:string;templateId:string;operation:string;data?:Partial<JsaTemplate>},{id:string}>(getFirebaseFunctions(),'jsaManageTemplate');
  return (await fn({companyId,templateId,operation,...(data?{data}:{})})).data;
}
export async function saveJsaTemplate(companyId:string,templateId:string|null,data:Partial<JsaTemplate>,_userId:string):Promise<string> {
  const id=!templateId?'jsa-'+crypto.randomUUID():templateId;
  const fields:Partial<JsaTemplate>={};
  for(const key of ['name','packageId','tasks','steps','ppeItems','preparedItems','locationLayout','sourceFile'] as const)
    if(data[key]!==undefined) Object.assign(fields,{[key]:data[key]});
  return (await manage(companyId,id,'save',fields)).id;
}
export async function deleteJsaTemplate(companyId:string,templateId:string):Promise<void> {await manage(companyId,templateId,'delete');}
export async function activateJsaTemplate(companyId:string,templateId:string,_userId:string):Promise<void> {await manage(companyId,templateId,'publish');}
export async function deactivateJsaTemplate(companyId:string,templateId:string):Promise<void> {await manage(companyId,templateId,'deactivate');}

// ── Legacy compat: load single template (old API) ────────────────────────

/** @deprecated Use loadJsaTemplates() instead. Kept for migration. */
export async function loadJsaTemplate(companyId: string): Promise<JsaTemplate | null> {
  const docRef = mirrorDoc(companyId);
  const snap = await getDoc(docRef);
  if (!snap.exists()) return null;
  return { ...snap.data(), id: 'legacy', companyId } as JsaTemplate;
}
