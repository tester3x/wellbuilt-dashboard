import {signedReadJsaNumber} from './jsaNumber';
import {parseAuthPrincipal, requireAudience, decideInvoiceJobFields} from './jsaReceiptCore';
import {parseArtifactInput} from './jsaArtifactCore';

type Row = Record<string, any>;
export type SavedJobDeps = {
  invoice(id:string):Promise<Row|null>;
  list(collection:string,company:string,driver:string,jobRef?:string):Promise<Row[]>;
  request?(id:string):Promise<Row|null>;
  linkedStops?(readId:string,company:string,driver:string):Promise<Row[]>;
  artifact(id:string):Promise<Row|null>;
};
/** Historical read only: no current-shift or current-policy requirement. */
export async function readSavedJobJsa(deps:SavedJobDeps,auth:{uid?:string|null;claims?:Record<string,unknown>},body:unknown){
  const parsed=parseAuthPrincipal(auth);
  if(!parsed.ok||!requireAudience(parsed.value,'wbt').ok)throw Error('not_authorized');
  const p=parsed.value,b=body as Row;
  if(!b||Array.isArray(b)||Object.keys(b).some(k=>!['protocolVersion','jobRef'].includes(k))||b.protocolVersion!==1||typeof b.jobRef!=='string'||!/^[A-Za-z0-9._-]{1,128}$/.test(b.jobRef))throw Error('invalid_job');
  const invoice=await deps.invoice(b.jobRef);
  if(!invoice||!decideInvoiceJobFields({expectedCompanyId:p.companyId,expectedDriverId:p.driverId,invoice:{...invoice,exists:true}}).ok)throw Error('not_authorized');
  const owned=(r:Row)=>r.companyId===p.companyId&&r.driverId===p.driverId;
  const [acks,coverage]=await Promise.all(['jsa_job_acknowledgments','jsa_job_read_coverage'].map(c=>deps.list(c,p.companyId,p.driverId,b.jobRef)));
  if([acks,coverage].some(rows=>rows.length>2000||rows.some(r=>!owned(r))))throw Error('scope_or_size');
  const ack=acks.filter(r=>r.jobRef===b.jobRef&&r.method==='acknowledged'&&Number.isFinite(r.recordedAtMs)).sort((a,b)=>b.recordedAtMs-a.recordedAtMs||String(a.id).localeCompare(String(b.id)))[0];
  const linked=coverage.filter(r=>r.jobRef===b.jobRef&&r.method==='scope_read'&&r.fullReadId).sort((a,b)=>b.recordedAtMs-a.recordedAtMs)[0];
  const fullReadId=ack?.fullReadId||(!ack&&linked?.fullReadId);
  const reads:Row[]=fullReadId&&deps.request
    ? [await deps.request(fullReadId)].filter((r):r is Row=>!!r)
    : await deps.list('jsa_governed_requests',p.companyId,p.driverId,!ack&&!linked?b.jobRef:undefined);
  if(reads.length>2000||reads.some(r=>!owned(r)))throw Error('scope_or_size');
  const completed=reads.filter(r=>r.state==='completed'&&['read_completed','read_and_acknowledged'].includes(r.action)&&Number.isFinite(r.completedAtMs));
  const inAckScope=(r:Row)=>r.completedAtMs<=ack.recordedAtMs&&(ack.fullReadId?r.requestId===ack.fullReadId:ack.policyDay?r.binding?.policyDay===ack.policyDay:!!ack.periodId&&(r.binding?.periodId===ack.periodId||r.binding?.associatedPeriodId===ack.periodId));
  const direct=completed.filter(r=>r.jobRef===b.jobRef).sort((a,b)=>a.completedAtMs-b.completedAtMs)[0];
  const read=ack?completed.filter(r=>inAckScope(r)&&(!ack.fullReadId||r.requestId===ack.fullReadId)).sort((a,b)=>a.completedAtMs-b.completedAtMs||String(a.requestId).localeCompare(String(b.requestId)))[0]
    :linked?completed.find(r=>r.requestId===linked.fullReadId&&r.completedAtMs<=linked.recordedAtMs):direct;
  const acknowledgement=ack?{recordedAt:new Date(ack.recordedAtMs).toISOString(),method:'acknowledged'}:null;
  const base={coveredJobs:[] as Row[],jsaNumber:read?signedReadJsaNumber(read):null,protocolVersion:1,jobRef:b.jobRef,companyId:p.companyId,driverId:p.driverId,wellName:String(invoice.wellName||''),acknowledgement};
  if(!read)return {...base,fullRead:null};
  const artifact=await deps.artifact(read.requestId);
  if(!artifact||!owned(artifact)||artifact.requestId!==read.requestId||artifact.jobRef!==read.jobRef||artifact.action!==read.action)return {...base,fullRead:null};
  // Re-parse and allowlist signed content; never return receipt handles, tokens or actor metadata.
  const snapshot=parseArtifactInput({requestId:read.requestId,snapshot:artifact.snapshot});
  if(!snapshot.ok)return {...base,fullRead:null};
  const stops=deps.linkedStops?await deps.linkedStops(read.requestId,p.companyId,p.driverId):[...acks,...coverage];
  if(stops.length>2000||stops.some(r=>!owned(r)))throw Error('scope_or_size');
  const coveredJobs:Row[]=[];
  const add=(job:Row,jobRef:string,recordedAtMs:number)=>{
    const text=(v:unknown)=>typeof v==='string'?v.slice(0,300):'';
    if(!text(job.wellName))return;
    coveredJobs.push({jobRef,wellName:text(job.wellName),jobType:text(job.jobType),dropOff:text(job.dropOff),recordedAt:new Date(recordedAtMs).toISOString()});
  };
  add(read,read.jobRef,read.completedAtMs);
  for(const location of snapshot.value.snapshot.locations||[])
    if(!coveredJobs.some(job=>job.wellName===location))add({wellName:location,jobType:read.jobType},read.jobRef,read.completedAtMs);
  for(const stop of stops)if(stop.fullReadId===read.requestId&&['acknowledged','scope_read'].includes(stop.method)
    && Number.isFinite(stop.recordedAtMs)&&stop.recordedAtMs>=read.completedAtMs&&stop.job)
    add(stop.job,stop.jobRef,stop.recordedAtMs);
  return {...base,coveredJobs,fullRead:{requestId:read.requestId,jobRef:read.jobRef,completedAt:new Date(read.completedAtMs).toISOString(),snapshot:snapshot.value.snapshot}};
}
