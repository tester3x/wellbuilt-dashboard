import { createHash } from 'crypto';
import { validateAssessment } from './jsaTemplateManagement';

export interface JsaTemplateReader { readTemplate(path: string): Promise<Record<string, unknown> | null> }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const idOk = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(v);

/** Caller supplies company from the verified principal, never a request field. */
export async function readJsaTaskCatalog(store: JsaTemplateReader, companyId: string) {
  if (!idOk(companyId)) throw new Error('Invalid company');
  const mirror = await store.readTemplate(`jsa_templates/${companyId}`);
  if (!mirror || mirror.schemaVersion !== 2) return {schemaVersion: 1, templates: []};
  if (!Array.isArray(mirror.activeTemplates) || mirror.activeTemplates.length > 20) throw new Error('Invalid template catalog');
  const templates = [];
  const seen = new Set<string>();
  for (const entry of mirror.activeTemplates) {
    if (!object(entry) || !idOk(entry.id) || !Number.isSafeInteger(entry.version) || Number(entry.version) < 1 || seen.has(entry.id)) throw new Error('Invalid template reference');
    seen.add(entry.id);
    const raw = await store.readTemplate(`jsa_templates/${companyId}/templates/${entry.id}--published-v${entry.version}`);
    if (!raw || raw.companyId !== companyId || raw.templateId !== entry.id || raw.version !== entry.version || raw.recordType !== 'revision') throw new Error('Published template unavailable');
    validateAssessment(raw);
    if (!Array.isArray(raw.steps) || !raw.steps.length || raw.steps.length > 40 || !Array.isArray(raw.ppeItems) || !Array.isArray(raw.preparedItems) || !Array.isArray(raw.tasks)) throw new Error('Malformed published template');
    if (typeof raw.name !== 'string' || raw.tasks.some(t => typeof t !== 'string' || !t.trim()) || JSON.stringify(raw.steps).length > 100000) throw new Error('Malformed template content');
    const content = {name:raw.name,tasks:raw.tasks,packageId:raw.packageId || null,steps:raw.steps,ppeItems:raw.ppeItems,preparedItems:raw.preparedItems,
      ...(raw.locationLayout?{locationLayout:raw.locationLayout}:{})};
    templates.push({id:entry.id,version:entry.version,contentHash:createHash('sha256').update(JSON.stringify(content)).digest('hex'),...content});
  }
  return {schemaVersion:2,templates};
}

export function selectJsaTaskTemplates(catalog: Awaited<ReturnType<typeof readJsaTaskCatalog>>, refs: unknown) {
  if (!Array.isArray(refs) || !refs.length || refs.length > 20) throw new Error('Select applicable task assessments');
  const ids = new Set<string>();
  const selected = refs.map(ref => {
    if (!object(ref) || Object.keys(ref).some(k=>!['id','version','contentHash'].includes(k)) || !idOk(ref.id) || ids.has(ref.id)) throw new Error('Invalid assessment selection');
    ids.add(ref.id);
    const match = catalog.templates.find(t=>t.id===ref.id && t.version===ref.version && t.contentHash===ref.contentHash);
    if (!match) throw new Error('Assessment changed. Read the current task assessment.');
    return match;
  }).sort((a,b)=>a.id.localeCompare(b.id));
  const steps = selected.flatMap(t=>t.steps.map((s:any,i:number)=>({...s,id:`${t.contentHash.slice(0,12)}_s${i}`})));
  const ppeItems = selected.flatMap(t=>t.ppeItems.map((p:any,i:number)=>({...p,id:`${t.contentHash.slice(0,12)}_p${i}`})));
  const preparedItems = selected.flatMap(t=>t.preparedItems.map((p:any,i:number)=>({...p,id:`${t.contentHash.slice(0,12)}_r${i}`})));
  if (steps.length>40 || JSON.stringify(steps).length>100000) throw new Error('Too many assessment steps in one JSA');
  const layouts=selected.map(t=>t.locationLayout).filter(Boolean);
  const locationLayout=layouts.length===selected.length&&layouts.every(layout=>JSON.stringify(layout)===JSON.stringify(layouts[0]))?layouts[0]:undefined;
  return {steps,ppeItems,preparedItems,...(locationLayout?{locationLayout}:{}),templates:selected.map(({id,version,contentHash,name,tasks})=>({id,version,contentHash,name,tasks}))};
}
