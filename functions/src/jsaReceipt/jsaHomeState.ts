import {parseArtifactInput} from './jsaArtifactCore';
type Row=Record<string,any>;
export type HomeDeps={
  shift():Promise<{state:'none'|'open'|'unverifiable';periodId?:string}>;
  list(collection:string,shiftId:string,periodIds:string[]):Promise<Row[]>;
  artifact(id:string):Promise<Row|null>;
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
  return {...base,action:'resume',active,...(b.operation==='read'?{record:{...parsed.value.snapshot,id:r.requestId,jsaNumber:active.jsaNumber,driverName:parsed.value.snapshot.printedName,date:parsed.value.snapshot.formDate||'',timestamp:new Date(r.completedAtMs).toISOString(),signatureImage:'data:image/png;base64,'+parsed.value.snapshot.signature.data,wellName:a.wellName||'',jobActivityName:a.jobType||'',wells:a.wells||[],state:'open'}}:{})};
 }
 const open=standalone.filter(r=>r.state==='open'&&(r.jsaPeriodId?ids.includes(r.jsaPeriodId):r.shiftId===shift.periodId)).sort((a,b)=>a.signedAtMs-b.signedAtMs||String(a.id).localeCompare(String(b.id)))[0];
 if(!open)return {...base,action:'new',active:null};
 const parsed=parseArtifactInput({requestId:'A'.repeat(43),snapshot:open.snapshot});if(!parsed.ok)throw Error('record_unavailable');
 const active={kind:'standalone',id:open.id,jsaNumber:open.jsaNumber||null};
 return {...base,action:'resume',active,...(b.operation==='read'?{record:{...parsed.value.snapshot,id:open.id,jsaNumber:active.jsaNumber,driverName:parsed.value.snapshot.printedName,date:parsed.value.snapshot.formDate||'',timestamp:new Date(open.signedAtMs).toISOString(),signatureImage:'data:image/png;base64,'+parsed.value.snapshot.signature.data,jobActivityName:open.job?.activity||'',wells:open.job?.wells||[],additions:open.additions||[],state:'open',workflow:'standalone'}}:{})};
}
