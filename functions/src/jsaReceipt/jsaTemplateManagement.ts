import { HttpsError } from 'firebase-functions/v2/https';

type Row = Record<string, any>;
export interface TemplateTransaction {
  get(path:string):Promise<Row|null>;
  list(path:string):Promise<Array<{id:string;data:Row}>>;
  set(path:string,data:Row):void;
  delete(path:string):void;
}
export function validateAssessment(raw:Row) {
  const text=(v:unknown,max:number)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw new HttpsError('invalid-argument','Invalid assessment text');};
  text(raw.name,300);
  if(!Array.isArray(raw.steps)||!raw.steps.length||raw.steps.length>40)throw new HttpsError('invalid-argument','Assessment needs 1–40 steps');
  const ids=new Set<string>();
  for(const s of raw.steps){
    text(s?.id,64);text(s?.title,300);
    if(ids.has(s.id)||!Array.isArray(s.items)||s.items.length>30)throw new HttpsError('invalid-argument','Invalid assessment steps');ids.add(s.id);
    for(const i of s.items){text(i?.hazard,2000);text(i?.controls,4000);}
  }
  for(const list of [raw.ppeItems,raw.preparedItems]){
    if(!Array.isArray(list)||list.length>40)throw new HttpsError('invalid-argument','Invalid checklist');
    const seen=new Set<string>();for(const p of list){text(p?.id,64);text(p?.label,300);if(seen.has(p.id))throw new HttpsError('invalid-argument','Duplicate checklist item');seen.add(p.id);}
  }
  if(JSON.stringify({steps:raw.steps,ppeItems:raw.ppeItems,preparedItems:raw.preparedItems}).length>100000)throw new HttpsError('invalid-argument','Assessment too large');
}
const idOk=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(v);
function tasks(v:unknown):string[]{
  if(v===undefined)return [];
  if(!Array.isArray(v)||v.length>20||v.some(x=>typeof x!=='string'||!x.trim()||x.length>120))throw new HttpsError('invalid-argument','Invalid tasks');
  return [...new Set(v.map(x=>x.trim().toLowerCase()))].sort();
}
/** Invoked only inside the same transaction that verifies staff membership. */
export async function manageJsaTemplate(tx:TemplateTransaction,raw:Row,uid:string,now:string){
  if(!raw||!idOk(raw.companyId)||!idOk(raw.templateId)||raw.templateId.includes('--published-v')||!['save','publish','deactivate','delete'].includes(raw.operation))throw new HttpsError('invalid-argument','Invalid template operation');
  if(Object.keys(raw).some(k=>!['companyId','templateId','operation','data'].includes(k)))throw new HttpsError('invalid-argument','Unexpected field');
  const root=`jsa_templates/${raw.companyId}`,path=`${root}/templates/${raw.templateId}`;
  const mirror=await tx.get(root),stored=await tx.get(path);
  // The Dashboard's single-template legacy row has a stable virtual ID.
  // Materialize it only on an explicit user mutation, never while listing.
  const old=stored || (raw.templateId==='legacy'&&mirror?.steps?.length?mirror:null);
  if(old?.recordType==='revision')throw new HttpsError('failed-precondition','Published revisions are immutable');
  if(raw.operation==='save'){
    if(old?.status==='active')throw new HttpsError('failed-precondition','Deactivate before editing');
    const d=raw.data;
    if(!d||typeof d!=='object'||Array.isArray(d)||Object.keys(d).some(k=>!['name','tasks','packageId','steps','ppeItems','preparedItems','sourceFile'].includes(k)))throw new HttpsError('invalid-argument','Invalid template fields');
    if(d.packageId!==undefined&&d.packageId!==null&&!idOk(d.packageId))throw new HttpsError('invalid-argument','Invalid package');
    if(d.sourceFile && (typeof d.sourceFile!=='object'||Object.keys(d.sourceFile).some(k=>!['storageUrl','storagePath','fileName'].includes(k))||Object.values(d.sourceFile).some(v=>typeof v!=='string'||v.length>2048)))throw new HttpsError('invalid-argument','Invalid source file');
    const next={...old,...d,companyId:raw.companyId,packageId:d.packageId===undefined?(old?.packageId||null):d.packageId,tasks:tasks(d.tasks===undefined?old?.tasks:d.tasks),version:old?.version||0,status:'draft',createdAt:old?.createdAt||now,updatedAt:now,updatedBy:uid};
    validateAssessment(next);tx.set(path,next);return {id:raw.templateId};
  }
  if(!old)throw new HttpsError('not-found','Template not found');
  if(raw.operation==='delete'){
    if(old.status==='active'||old.version>0)throw new HttpsError('failed-precondition','Deactivate published templates instead');
    tx.delete(path);return {id:raw.templateId};
  }
  // Catalog and legacy sources are read transactionally; no query outside the lock.
  const sources=await tx.list(`${root}/templates`);
  if(!stored&&old) sources.push({id:raw.templateId,data:old});
  const active= sources.filter(s=>s.data.status==='active'&&s.data.recordType!=='revision').map(s=>({id:s.id,name:s.data.name,version:s.data.version,packageId:s.data.packageId||null,tasks:tasks(s.data.tasks)}));
  if(active.length>20)throw new HttpsError('failed-precondition','Too many active templates');
  const archives:Array<{path:string;data:Row}>=[];
  for(const t of active){
    const source=sources.find(s=>s.id===t.id)!.data;validateAssessment(source);
    if(!Number.isSafeInteger(t.version)||t.version<1)throw new HttpsError('failed-precondition','Invalid active version');
    const revisionPath=`${root}/templates/${t.id}--published-v${t.version}`;
    if(!await tx.get(revisionPath))archives.push({path:revisionPath,data:{...source,tasks:t.tasks,packageId:t.packageId,companyId:raw.companyId,templateId:t.id,recordType:'revision'}});
  }
  let next=active.filter(t=>t.id!==raw.templateId),published:Row|null=null;
  if(raw.operation==='publish'){
    if(old.status==='active')return {id:raw.templateId};
    validateAssessment(old);
    const assigned=tasks(old.tasks),packageId=old.packageId||null;
    if(next.some(t=>t.packageId===packageId&&((!assigned.length&&!t.tasks.length)||assigned.some(a=>t.tasks.includes(a)))))throw new HttpsError('failed-precondition','Task assignment conflicts with an active template');
    if(next.length>=20)throw new HttpsError('failed-precondition','Too many active templates');
    const version=(old.version||0)+1;
    if(!Number.isSafeInteger(version)||version<1)throw new HttpsError('failed-precondition','Invalid version');
    const revisionPath=`${root}/templates/${raw.templateId}--published-v${version}`;
    if(await tx.get(revisionPath))throw new HttpsError('already-exists','Published version exists');
    published={...old,tasks:assigned,packageId,version,status:'active',updatedBy:uid,updatedAt:now};
    archives.push({path:revisionPath,data:{...published,templateId:raw.templateId,recordType:'revision'}});
    next.push({id:raw.templateId,name:old.name,version,packageId,tasks:assigned});
  }
  const legacyId=mirror?.legacyTemplateId||active.find(t=>!t.tasks.length)?.id||null;
  const isDefault=published && !published.tasks.length && !published.packageId;
  for(const a of archives)tx.set(a.path,a.data);
  tx.set(path,published||{...old,status:'draft',updatedBy:uid,updatedAt:now});
  tx.set(root,{...(mirror||{status:'draft'}),...(isDefault?published:{}),schemaVersion:2,activeTemplates:next,
    ...(raw.operation==='deactivate'&&legacyId===raw.templateId?{status:'draft'}:{}),
    legacyTemplateId:isDefault?raw.templateId:(raw.operation==='deactivate'&&legacyId===raw.templateId?null:legacyId),catalogUpdatedAt:now});
  return {id:raw.templateId};
}
