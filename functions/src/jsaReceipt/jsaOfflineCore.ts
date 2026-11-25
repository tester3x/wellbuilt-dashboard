import {parseArtifactInput} from './jsaArtifactCore';
import {createHash} from 'crypto';

export const offlineHash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const operatorKey=(v:string)=>v.trim().toUpperCase().replace(/[^A-Z0-9]/g,'');

/** Never import a previous shift's read into newly prepared local authority. */
export function preparedShiftRead(rows:any[],context:{id:string;shiftId:string|null;companyId:string;driverId:string}) {
 return rows.filter(r=>r.companyId===context.companyId&&r.driverId===context.driverId
  &&r.binding?.jsaPeriodId===context.id&&(r.binding?.associatedPeriodId||null)===context.shiftId
  &&r.state==='completed'&&r.action==='read_and_acknowledged'&&Number.isFinite(r.completedAtMs))
  .sort((a,b)=>a.completedAtMs-b.completedAtMs)[0]||null;
}
export type OfflineAssessment={name:string;steps:any[];ppeItems:any[];preparedItems:any[];contentHash:string;packageId:string|null;tasks:string[]};
export type OfflineGrant={version:1;id:string;companyId:string;driverId:string;issuedAtMs:number;expiresAtMs:number;
 shiftId:string|null;offShiftPeriodEndsAtMs?:number;offShiftPreparation?:{validUntilMs:number;windowMs:number};offShiftPeriod?:{rootGrantId:string;periodId:string;startedAtMs:number};binding:any;requirementKey:string;policyDay:string;mode:'off'|'per_job'|'per_shift';allowAcknowledge:boolean;
 jobSettings?:Record<string,unknown>;photoRequirements?:Record<string,any>;executionProfiles?:unknown[];operators:string[];assessments:OfflineAssessment[];fullReadId:string|null};
export type OfflineEvent={version:1;id:string;grantId:string;jobRef:string;operator:string;occurredAtMs:number;
 kind:'read'|'acknowledged'|'scope_read'|'off';fullReadId?:string;assessmentHash?:string;snapshot?:unknown};

/** Issued policy is immutable. Late delivery uses the original work period and
 * occurrence time, never whichever shift is open when the radio reconnects. */
export function validateOfflineEvent(g:OfflineGrant,e:OfflineEvent,job:any,period:any,read:any,now:number){
 if(!e||Object.keys(e).some(k=>!['version','id','grantId','jobRef','operator','occurredAtMs','kind','fullReadId','assessmentHash','snapshot'].includes(k))
  ||e.version!==1||!/^[A-Za-z0-9_-]{43}$/.test(e.id)||e.grantId!==g.id||!/^[A-Za-z0-9._-]{1,128}$/.test(e.jobRef)
  ||!['read','acknowledged','scope_read','off'].includes(e.kind))throw Error('malformed_event');
 if(!Number.isSafeInteger(e.occurredAtMs)||e.occurredAtMs<g.issuedAtMs-120000||e.occurredAtMs>g.expiresAtMs||g.shiftId===null&&Number.isFinite(g.offShiftPeriodEndsAtMs)&&e.occurredAtMs>=g.offShiftPeriodEndsAtMs!||e.occurredAtMs>now+120000)throw Error('event_time');
 if(!job||job.companyId!==g.companyId||(job.driverId||job.driverHash)!==g.driverId)throw Error('job_owner');
 if(typeof e.operator!=='string'||typeof job.operator!=='string'||operatorKey(e.operator)!==operatorKey(job.operator)
  ||!g.operators.some(o=>operatorKey(o)===operatorKey(e.operator)))throw Error('operator_scope');
 if(!period||period.companyId!==g.companyId||period.driverId!==g.driverId||period.id!==g.binding.jsaPeriodId
  ||period.shiftId!==g.shiftId||!['open','finalized'].includes(period.state))throw Error('work_period');
 if(period.state==='finalized'&&(!Number.isFinite(period.finalizedAtMs)||e.occurredAtMs>period.finalizedAtMs))throw Error('shift_ended');
 if(g.mode==='off'){if(e.kind!=='off')throw Error('policy_mismatch');return {method:'off',snapshot:null};}
 if(e.kind==='off')throw Error('policy_mismatch');
 if(e.kind==='read'){
  const a=g.assessments.find(a=>a.contentHash===e.assessmentHash);
  if(!a||a.packageId!==null&&a.packageId!==job.packageId||a.tasks.length&&!a.tasks.some(t=>t.trim().toLowerCase()===String(job.commodityType||job.jobType||'').trim().toLowerCase()))throw Error('assessment_scope');
  const parsed=parseArtifactInput({requestId:e.id,snapshot:e.snapshot});
  if(!parsed.ok)throw Error('invalid_signed_read');
  const s=parsed.value.snapshot;
  if(s.stepsAcknowledged!==true||!a.steps.length||a.steps.some(x=>s.stepAcks[x.id]!==true)
   ||!a.preparedItems.length||a.preparedItems.some(x=>s.prepared[x.id]!==true))throw Error('incomplete_read');
  if(a.ppeItems.some(x=>x.required===true&&s.ppeSelected[x.id]!==true))throw Error('required_ppe');
  return {method:'read',snapshot:parsed.value};
 }
 if(e.snapshot!==undefined||e.assessmentHash!==undefined)throw Error('unexpected_read');
 if(e.kind==='acknowledged'&&(g.mode!=='per_job'||!g.allowAcknowledge)||e.kind==='scope_read'&&g.mode!=='per_shift')throw Error('policy_mismatch');
 if(!read||read.requestId!==e.fullReadId||read.companyId!==g.companyId||read.driverId!==g.driverId
  ||read.binding?.jsaPeriodId!==g.binding.jsaPeriodId||read.state!=='completed'||read.action!=='read_and_acknowledged'
  ||!Number.isFinite(read.completedAtMs)||read.completedAtMs>e.occurredAtMs)throw Error('qualifying_read');
 return {method:e.kind,snapshot:null};
}

/** The server-issued root freezes membership, operator scope, assessments and execution profiles.
 * Local periods may rotate, but may not expand any permission in that root. */
export function deriveOffShiftGrant(root:OfflineGrant, period:any):OfflineGrant {
 const windowMs=14*3600000;
 if(root.offShiftPeriod||root.offShiftPreparation?.windowMs!==windowMs
  ||!Number.isSafeInteger(root.offShiftPreparation.validUntilMs)||!period
  ||Object.keys(period).some(k=>!['rootGrantId','periodId','startedAtMs'].includes(k))
  ||period.rootGrantId!==root.id||!/^[a-f0-9]{48}$/.test(period.periodId)
  ||!Number.isSafeInteger(period.startedAtMs)||period.startedAtMs<root.issuedAtMs-120000
  ||period.startedAtMs>=root.offShiftPreparation.validUntilMs)throw Error('off_shift_preparation');
 const id=offlineHash(['off-shift',root.id,period.periodId,period.startedAtMs]);
 const binding={...root.binding,jsaPeriodId:period.periodId};delete binding.associatedPeriodId;
 return {...root,id,issuedAtMs:period.startedAtMs,expiresAtMs:root.offShiftPreparation.validUntilMs,offShiftPeriodEndsAtMs:Math.min(period.startedAtMs+windowMs,root.offShiftPreparation.validUntilMs),
  shiftId:null,offShiftPeriod:period,binding,
  requirementKey:'jsa:'+period.periodId,fullReadId:null};
}
