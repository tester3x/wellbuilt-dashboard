import {parseAuthPrincipal, requireAudience, decideInvoiceJobFields} from './jsaReceiptCore';
import {parseArtifactInput} from './jsaArtifactCore';

type Row = Record<string, any>;
export type SavedJobDeps = {
  invoice(id:string):Promise<Row|null>;
  list(collection:string,company:string,driver:string):Promise<Row[]>;
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
  const [reads,acks,coverage]=await Promise.all(['jsa_governed_requests','jsa_job_acknowledgments','jsa_job_read_coverage'].map(c=>deps.list(c,p.companyId,p.driverId)));
  if([reads,acks,coverage].some(rows=>rows.length>2000||rows.some(r=>!owned(r))))throw Error('scope_or_size');
  const completed=reads.filter(r=>r.state==='completed'&&['read_completed','read_and_acknowledged'].includes(r.action)&&Number.isFinite(r.completedAtMs));
  const ack=acks.filter(r=>r.jobRef===b.jobRef&&r.method==='acknowledged'&&Number.isFinite(r.recordedAtMs)).sort((a,b)=>a.recordedAtMs-b.recordedAtMs||String(a.id).localeCompare(String(b.id)))[0];
  const linked=coverage.find(r=>r.jobRef===b.jobRef&&r.method==='scope_read'&&r.fullReadId);
  const inAckScope=(r:Row)=>r.completedAtMs<=ack.recordedAtMs&&(ack.policyDay?r.binding?.policyDay===ack.policyDay:!!ack.periodId&&(r.binding?.periodId===ack.periodId||r.binding?.associatedPeriodId===ack.periodId));
  const direct=completed.filter(r=>r.jobRef===b.jobRef).sort((a,b)=>a.completedAtMs-b.completedAtMs)[0];
  const read=ack?completed.filter(r=>inAckScope(r)&&(!ack.fullReadId||r.requestId===ack.fullReadId)).sort((a,b)=>a.completedAtMs-b.completedAtMs||String(a.requestId).localeCompare(String(b.requestId)))[0]
    :linked?completed.find(r=>r.requestId===linked.fullReadId&&r.completedAtMs<=linked.recordedAtMs):direct;
  const acknowledgement=ack?{recordedAt:new Date(ack.recordedAtMs).toISOString(),method:'acknowledged'}:null;
  const base={protocolVersion:1,jobRef:b.jobRef,companyId:p.companyId,driverId:p.driverId,wellName:String(invoice.wellName||''),acknowledgement};
  if(!read)return {...base,fullRead:null};
  const artifact=await deps.artifact(read.requestId);
  if(!artifact||!owned(artifact)||artifact.requestId!==read.requestId||artifact.jobRef!==read.jobRef||artifact.action!==read.action)return {...base,fullRead:null};
  // Re-parse and allowlist signed content; never return receipt handles, tokens or actor metadata.
  const snapshot=parseArtifactInput({requestId:read.requestId,snapshot:artifact.snapshot});
  if(!snapshot.ok)return {...base,fullRead:null};
  return {...base,fullRead:{requestId:read.requestId,jobRef:read.jobRef,completedAt:new Date(read.completedAtMs).toISOString(),snapshot:snapshot.value.snapshot}};
}
