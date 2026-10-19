import {decideInvoiceJobFields} from './jsaReceiptCore';
import {parseArtifactInput} from './jsaArtifactCore';
type Row=Record<string,any>;
export type HomeDeps={
  shift():Promise<{state:'none'|'open'|'unverifiable';periodId?:string}>;
  list(collection:string,shiftId:string,periodIds:string[]):Promise<Row[]>;
  artifact(id:string):Promise<Row|null>;
  job?(id:string):Promise<Row|null>;
  companyName?():Promise<string>;
};
/** No date-derived scope and no lifecycle mutations. Off shift always starts
 * with New JSA; historical/open standalone records remain in their own list. */
export async function readJsaHomeState(deps:HomeDeps,owner:{companyId:string;driverId:string},body:unknown){
 const b=body as Row;
 if(!b||Array.isArray(b)||Object.keys(b).some(k=>!['protocolVersion','operation'].includes(k))||b.protocolVersion!==1||!['status','read'].includes(b.operation))throw Error('invalid_input');
 const shift=await deps.shift();
 if(shift.state==='unverifiable')throw Error('shift_unavailable');
 const base={protocolVersion:1,...owner,shiftState:shift.state,shiftId:shift.periodId||null};
 if(shift.state==='none')return {...base,action:'new',active:null};
 if(!shift.periodId||!/^\d{4}-\d{2}-\d{2}_\d{6}$/.test(shift.periodId))throw Error('shift_unavailable');
 const owned=(r:Row)=>r.companyId===owner.companyId&&r.driverId===owner.driverId;
 const checked=(rows:Row[])=>{if(rows.length>2000||rows.some(r=>!owned(r)))throw Error('scope_or_size');return rows;};
 const periods=checked(await deps.list('jsa_work_periods',shift.periodId,[])).filter(r=>r.shiftId===shift.periodId&&r.state==='open');
 const ids=periods.map(r=>r.id);if(ids.length>20)throw Error('scope_or_size');
 const [requests,standalone]=await Promise.all(['jsa_governed_requests','standalone'].map(c=>deps.list(c,shift.periodId!,ids).then(checked)));
 const inScope=(r:Row)=>r.binding?.jsaPeriodId?ids.includes(r.binding.jsaPeriodId):r.binding?.associatedPeriodId===shift.periodId||r.binding?.periodId===shift.periodId;
 const reads=requests.filter(r=>inScope(r)&&r.state==='completed'&&['read_completed','read_and_acknowledged'].includes(r.action)&&Number.isFinite(r.completedAtMs)).sort((a,b)=>a.completedAtMs-b.completedAtMs||String(a.requestId).localeCompare(String(b.requestId)));
 if(reads.length){
  const r=reads[0],a=await deps.artifact(r.requestId);
  const parsed=a&&parseArtifactInput({requestId:r.requestId,snapshot:a.snapshot});
  if(!a||!owned(a)||a.requestId!==r.requestId||a.jobRef!==r.jobRef||a.action!==r.action||!parsed?.ok)throw Error('record_unavailable');
  const active={kind:'governed',id:r.requestId,jsaNumber:'JSA-'+r.requestId};
  if(b.operation!=='read')return {...base,action:'resume',active};
  const [job,companyName,acks,coverage]=await Promise.all([
    deps.job?deps.job(r.jobRef):Promise.resolve(null),deps.companyName?deps.companyName():Promise.resolve(''),
    deps.list('jsa_job_acknowledgments',shift.periodId,ids).then(checked),
    deps.list('jsa_job_read_coverage',shift.periodId,ids).then(checked),
  ]);
  if(job&&!decideInvoiceJobFields({expectedCompanyId:owner.companyId,expectedDriverId:owner.driverId,invoice:{...job,exists:true}}).ok)throw Error('scope_or_size');
  const activity=(v:Row)=>String(v.commodityType||v.jobType||'');
  const originalJob=job?{wellName:String(job.wellName||''),jobType:activity(job),dropOff:String(job.hauledTo||job.disposal||'')}:null;
  const coveredJobs=[...(originalJob?[{...originalJob,jobRef:r.jobRef,recordedAtMs:r.completedAtMs,method:'read_and_acknowledged'}]:[]),
    ...[...acks,...coverage].filter(x=>x.fullReadId===r.requestId&&['acknowledged','scope_read'].includes(x.method)&&Number.isFinite(x.recordedAtMs)&&x.recordedAtMs>=r.completedAtMs&&x.job)
      .map(x=>({jobRef:x.jobRef,wellName:String(x.job.wellName||''),jobType:String(x.job.jobType||''),dropOff:String(x.job.dropOff||''),recordedAtMs:x.recordedAtMs,method:x.method}))]
    .sort((a,b)=>a.recordedAtMs-b.recordedAtMs||String(a.jobRef).localeCompare(String(b.jobRef)));

  return {...base,action:'resume',active,...(b.operation==='read'?{record:{...parsed.value.snapshot,id:r.requestId,jsaNumber:active.jsaNumber,driverName:parsed.value.snapshot.printedName,date:parsed.value.snapshot.formDate||'',timestamp:new Date(r.completedAtMs).toISOString(),signatureImage:'data:image/png;base64,'+parsed.value.snapshot.signature.data,wellName:originalJob?.wellName||'',jobActivityName:originalJob?.jobType||'',wells:originalJob?[{name:originalJob.wellName,jobType:originalJob.jobType}]:[],operator:String(job?.operator||''),companyName,coveredJobs,assessmentArchiveUnavailable:true,state:'open'}}:{})};
 }
 const open=standalone.filter(r=>r.state==='open'&&(r.jsaPeriodId?ids.includes(r.jsaPeriodId):r.shiftId===shift.periodId)).sort((a,b)=>a.signedAtMs-b.signedAtMs||String(a.id).localeCompare(String(b.id)))[0];
 if(!open)return {...base,action:'new',active:null};
 const parsed=parseArtifactInput({requestId:'A'.repeat(43),snapshot:open.snapshot});if(!parsed.ok)throw Error('record_unavailable');
 const active={kind:'standalone',id:open.id,jsaNumber:open.jsaNumber||null};
 return {...base,action:'resume',active,...(b.operation==='read'?{record:{...parsed.value.snapshot,id:open.id,jsaNumber:active.jsaNumber,driverName:parsed.value.snapshot.printedName,date:parsed.value.snapshot.formDate||'',timestamp:new Date(open.signedAtMs).toISOString(),signatureImage:'data:image/png;base64,'+parsed.value.snapshot.signature.data,jobActivityName:open.job?.activity||'',wells:open.job?.wells||[],additions:open.additions||[],state:'open',workflow:'standalone'}}:{})};
}
