import {jsaNumber,signedReadJsaNumber} from './jsaNumber';
import { parseAuthPrincipal, requireAudience, JSA_APP_JSA } from './jsaReceiptCore';
import { JSA_JOB_ACK_METHOD } from '@tester3x/wellbuilt-contracts';

type Row = Record<string, any>;
export type WeeklyJsaDeps = {
  list(collection: string, companyId: string, driverId: string): Promise<Row[]>;
  artifact(requestId: string): Promise<Row | null>;
};
/** Historical read only. An ended shift never becomes a new current shift. */
export async function readWeeklyJsaForms(deps: WeeklyJsaDeps, auth: {uid?:string|null;claims?:Record<string,unknown>}, body: unknown) {
  const principal = parseAuthPrincipal(auth);
  if (!principal.ok || !requireAudience(principal.value,JSA_APP_JSA).ok) throw new Error('not_authorized');
  const p = principal.value;
  const b = body as Row;
  const civil = (s:unknown):s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s+'T00:00:00Z')) && new Date(s+'T00:00:00Z').toISOString().slice(0,10) === s;
  if (!b || Object.keys(b).some(k=>!['startDate','endDate','timezone'].includes(k)) || !civil(b.startDate) || !civil(b.endDate) || b.startDate>b.endDate || Date.parse(b.endDate)-Date.parse(b.startDate)>31*86400000 || typeof b.timezone!=='string') throw new Error('invalid_period');
  const formatter = new Intl.DateTimeFormat('en-CA',{timeZone:b.timezone,year:'numeric',month:'2-digit',day:'2-digit'});
  const dateOf = (ms:number) => { const parts=formatter.formatToParts(ms),part=(t:string)=>parts.find(p=>p.type===t)?.value;return `${part('year')}-${part('month')}-${part('day')}`; };
  const owned = (r:Row) => r.companyId===p.companyId && r.driverId===p.driverId;
  const inside = (ms:unknown):ms is number => typeof ms==='number' && Number.isFinite(ms) && dateOf(ms)>=b.startDate && dateOf(ms)<=b.endDate;
  const collections = ['jsa_governed_requests','jsas','jsa_job_acknowledgments',`jsa_standalone_companies/${p.companyId}/drivers/${p.driverId}/records`];
  const batches = await Promise.all(collections.map(c=>deps.list(c,p.companyId,p.driverId)));
  if (batches.some(rows=>rows.length>2000 || rows.some(r=>!owned(r)))) throw new Error('scope_or_size');
  const records: Row[] = [], missing: string[] = [];
  for (const r of batches[0]) {
    if(r.state!=='completed'||!inside(r.completedAtMs)||!['read_completed','read_and_acknowledged','acknowledged'].includes(r.action))continue;
    const artifact = await deps.artifact(r.requestId);
    if (!artifact || !owned(artifact) || artifact.requestId!==r.requestId || artifact.jobRef!==r.jobRef || artifact.action!==r.action || !artifact.snapshot?.signature?.data) { missing.push(`${dateOf(r.completedAtMs)}: signed artifact unavailable for ${r.requestId}`);continue; }
    records.push({id:r.requestId,kind:r.action==='acknowledged'?'jsa_ack':'jsa_read',date:dateOf(r.completedAtMs),completedAt:new Date(r.completedAtMs).toISOString(),shiftId:r.binding?.periodId||r.binding?.associatedPeriodId||null,jobRef:r.jobRef,record:{...artifact.snapshot,jsaNumber:jsaNumber('JSA-'+r.requestId,r.completedAtMs,r.jsaNumber),id:r.requestId,driverName:artifact.snapshot.printedName,timestamp:new Date(r.completedAtMs).toISOString(),date:dateOf(r.completedAtMs),signatureImage:'data:image/png;base64,'+artifact.snapshot.signature.data},source:'governed'});
  }
  for (const r of batches[1]) {
    const ms = Date.parse(r.timestamp);
    if (!inside(ms)||!r.signatureImage||!r.signature||!r.id||r.governedRequestRef)continue;
    // Only signed document content is exported; credentials and device metadata never leave this API.
    const keys = ['id','driverName','driverLegalName','truckNumber','jobActivityName','date','timestamp','signature','signatureImage','notes','pusher','otherInfo','wells','locations','locationAcks','ppeSelected','ppeOtherItems','prepared','stepsAcknowledged','stepAcks','assessmentSteps','assessmentTemplates','assessmentPpeItems','assessmentPreparedItems','operator','additions','locationLayout'];
    const record:Row={jsaNumber:jsaNumber('JSA-'+String(r.id).toUpperCase(),ms,r.jsaNumber)};for(const k of keys)if(r[k]!==undefined)record[k]=r[k];
    records.push({id:r.id,kind:'jsa_read',date:dateOf(ms),completedAt:new Date(ms).toISOString(),shiftId:r.shiftId||null,jobRef:r.jobRef||null,record,source:'signed_document'});
  }
  for (const r of batches[2]) if(inside(r.recordedAtMs)&&r.method===JSA_JOB_ACK_METHOD&&r.jobRef&&(r.periodId||r.policyDay)) {
    const firstRead=batches[0].filter(read=>read.state==='completed'&&['read_completed','read_and_acknowledged'].includes(read.action)&&(r.fullReadId?read.requestId===r.fullReadId:r.policyDay?read.binding?.shiftState==='independent'&&read.binding?.policyDay===r.policyDay:read.binding?.periodId===r.periodId)&&typeof read.completedAtMs==='number'&&read.completedAtMs<=r.recordedAtMs).sort((a,b)=>a.completedAtMs-b.completedAtMs||String(a.requestId).localeCompare(String(b.requestId)))[0];
    if(!firstRead)missing.push(`${dateOf(r.recordedAtMs)}: first full JSA reference unavailable for acknowledgement ${r.id}`);
    records.push({id:r.id,kind:'jsa_ack',date:dateOf(r.recordedAtMs),completedAt:new Date(r.recordedAtMs).toISOString(),shiftId:r.periodId||null,jobRef:r.jobRef,fullReadId:firstRead?.requestId||null,record:{jsaNumber:firstRead?signedReadJsaNumber(firstRead):null,job:r.job||null,method:r.method,recordedAtMs:r.recordedAtMs,originLocalDate:r.originLocalDate||null,policyDay:r.policyDay||null},source:'job_acknowledgment'});
  }
  for (const r of batches[3]) if(inside(r.signedAtMs)&&r.snapshot?.signature?.data)
    records.push({id:r.id,kind:'jsa_read',date:dateOf(r.signedAtMs),completedAt:new Date(r.signedAtMs).toISOString(),shiftId:null,jobRef:null,record:{jsaNumber:jsaNumber('JSA-'+String(r.id).toUpperCase(),r.signedAtMs,r.jsaNumber),snapshot:r.snapshot,job:r.job,additions:r.additions||[],signedAtMs:r.signedAtMs,id:r.id},source:'standalone'});
  const out={schemaVersion:1,driverId:p.driverId,companyId:p.companyId,startDate:b.startDate,endDate:b.endDate,timezone:b.timezone,records,missing};
  if(Buffer.byteLength(JSON.stringify(out))>10_000_000)throw new Error('too_large');
  return out;
}
