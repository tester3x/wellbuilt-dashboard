import {jsaNumber} from './jsaNumber';
import {parseArtifactInput} from './jsaArtifactCore';

type Row=Record<string,any>;
export type ShiftJsaSummaryDeps={
  list(collection:string,companyId:string,driverId:string,scope?:{shiftId:string;periodIds:string[]}):Promise<Row[]>;
  artifact(requestId:string):Promise<Row|null>;
};
export function parseShiftSummaryInput(input:unknown):string|null{
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('invalid_input');
  const b=input as Row;
  if(Object.keys(b).some(k=>!['protocolVersion','shiftId'].includes(k))||b.protocolVersion!==1)throw Error('invalid_input');
  if(b.shiftId===undefined)return null;
  if(typeof b.shiftId!=='string'||!/^\d{4}-\d{2}-\d{2}_\d{6}$/.test(b.shiftId))throw Error('invalid_input');
  return b.shiftId;
}

/** Historical, read-only projection. Never resolves/creates a JSA period, closes
 * one, or derives a scope from a date. The subject was canonically authorized by
 * the callable; a requested shift only narrows that subject's own records. */
export async function readShiftJsaSummary(deps:ShiftJsaSummaryDeps,subject:{companyId:string;driverId:string},shiftId:string|null){
  const base={protocolVersion:1,...subject,shiftId,fullReadCount:0,acknowledgementCount:0,coveredJobCount:0,jobCount:0,firstReadAt:null as string|null,jsaNumbers:[] as string[],issues:0};
  if(!shiftId)return {...base,status:'no_shift' as const,lifecycle:'unknown' as const};
  const owned=(r:Row)=>r.companyId===subject.companyId&&r.driverId===subject.driverId;
  const periods=await deps.list('jsa_work_periods',subject.companyId,subject.driverId,{shiftId,periodIds:[]});
  if(periods.length>2000||periods.some(r=>!owned(r)))throw Error('scope_or_size');
  const matched=periods.filter(r=>r.shiftId===shiftId&&/^[a-f0-9]{48}$/.test(r.id));
  const periodIds=new Set(matched.map(r=>r.id));
  if(periodIds.size>20)throw Error('scope_or_size');
  const [requests,acks,coverage]=await Promise.all(['jsa_governed_requests','jsa_job_acknowledgments','jsa_job_read_coverage'].map(c=>deps.list(c,subject.companyId,subject.driverId,{shiftId,periodIds:[...periodIds]})));
  if([requests,acks,coverage].some(rows=>rows.length>2000||rows.some(r=>!owned(r))))throw Error('scope_or_size');
  const inScope=(r:Row)=>r.binding?.periodId===shiftId||r.binding?.associatedPeriodId===shiftId||periodIds.has(r.binding?.jsaPeriodId);
  const jobScope=(r:Row)=>r.periodId===shiftId||(typeof r.requirementKey==='string'&&r.requirementKey.startsWith('jsa:')&&periodIds.has(r.requirementKey.slice(4)));
  const candidates=requests.filter(r=>inScope(r)&&r.state==='completed'&&['read_completed','read_and_acknowledged'].includes(r.action)&&Number.isFinite(r.completedAtMs));
  if(candidates.length>250)throw Error('scope_or_size');
  const verified=new Map<string,Row>();let issues=0;
  await Promise.all(candidates.map(async r=>{
    const a=await deps.artifact(r.requestId);
    if(!a||!owned(a)||a.requestId!==r.requestId||a.jobRef!==r.jobRef||a.action!==r.action||!parseArtifactInput({requestId:r.requestId,snapshot:a.snapshot}).ok){issues++;return;}
    verified.set(r.requestId,r);
  }));
  const jobs=new Set<string>(),numbers=new Set<string>();
  for(const r of verified.values()){if(r.jobRef)jobs.add(r.jobRef);numbers.add(jsaNumber('JSA-'+r.requestId,r.completedAtMs,r.jsaNumber));}
  const ackJobs=new Set<string>(),coveredJobs=new Set<string>();
  for(const [rows,method,target] of [[acks,'acknowledged',ackJobs],[coverage,'scope_read',coveredJobs]] as const){
    const latest=new Map<string,Row>();
    for(const r of rows.filter(r=>jobScope(r)&&r.method===method)){
      if(typeof r.jobRef!=='string'||!r.jobRef||!Number.isFinite(r.recordedAtMs)){issues++;continue;}
      if(!latest.has(r.jobRef)||latest.get(r.jobRef)!.recordedAtMs<r.recordedAtMs)latest.set(r.jobRef,r);
    }
    for(const r of latest.values()){
      const read=verified.get(r.fullReadId)||(!r.fullReadId&&!r.requirementKey&&r.periodId===shiftId
        ? [...verified.values()].filter(v=>!v.binding?.jsaPeriodId&&(v.binding?.periodId===shiftId||v.binding?.associatedPeriodId===shiftId)&&v.completedAtMs<=r.recordedAtMs).sort((a,b)=>a.completedAtMs-b.completedAtMs)[0]
        : undefined);
      if(!read||read.completedAtMs>r.recordedAtMs){issues++;continue;}
      // New context receipts must link to the same context, even when both
      // contexts happen to have been attached to the same HOS shift.
      if(r.requirementKey?.startsWith('jsa:')&&read.binding?.jsaPeriodId!==r.requirementKey.slice(4)){issues++;continue;}
      target.add(r.jobRef);jobs.add(r.jobRef);
      if(typeof r.jsaNumber==='string'&&r.jsaNumber.length<=160)numbers.add(jsaNumber(r.jsaNumber,r.jsaNumber==='JSA-'+read.requestId?read.completedAtMs:r.recordedAtMs,r.jsaNumber));
    }
  }
  const first=[...verified.values()].sort((a,b)=>a.completedAtMs-b.completedAtMs)[0];
  return {...base,status:issues?'partial' as const:verified.size?'recorded' as const:'no_evidence' as const,
    lifecycle:matched.length?matched.every(r=>r.state==='finalized')?'finalized' as const:'open' as const:'unknown' as const,
    fullReadCount:verified.size,acknowledgementCount:ackJobs.size,coveredJobCount:coveredJobs.size,jobCount:jobs.size,
    firstReadAt:first?new Date(first.completedAtMs).toISOString():null,jsaNumbers:[...numbers].sort(),issues};
}
