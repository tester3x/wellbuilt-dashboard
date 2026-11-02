import {readJsaHomeState,governedJsaDocument,standaloneJsaDocument,type HomeDeps} from './jsaHomeState';
type Row=Record<string,any>;
export type ShiftPreviewDeps=HomeDeps&{
 history():Promise<{requests:Row[];standalone:Row[]}>;
 linkedStops(readId:string):Promise<Row[]>;
};
/** Viewing only. No reads, acknowledgements, shift starts or coverage are created. */
export async function readShiftJsaPreview(deps:ShiftPreviewDeps,owner:{companyId:string;driverId:string},body:unknown){
 const b=body as Row;
 if(!b||Array.isArray(b)||b.protocolVersion!==1||Object.keys(b).some(k=>k!=='protocolVersion'))throw Error('invalid_input');
 const shift=await deps.shift();
 if(shift.state==='unverifiable')throw Error('shift_unavailable');
 const base={protocolVersion:1,...owner,shiftState:shift.state,shiftId:shift.periodId||null,viewOnly:true};
 if(shift.state==='open'){
  // Exactly the same current-shift selection and document projection as WB JSA.
  // In particular, never substitute yesterday's document for a new shift.
  const home=await readJsaHomeState({...deps,shift:async()=>shift},owner,{protocolVersion:1,operation:'read'});
  return {...base,record:('record' in home?home.record:null)||null};
 }
 const history=await deps.history();
 const checked=(rows:Row[])=>{if(rows.length>2000||rows.some(r=>r.companyId!==owner.companyId||r.driverId!==owner.driverId))throw Error('scope_or_size');return rows;};
 const candidates=[
  ...checked(history.requests).filter(r=>r.state==='completed'&&['read_completed','read_and_acknowledged'].includes(r.action)&&Number.isFinite(r.completedAtMs)).map(r=>({kind:'governed',time:r.completedAtMs,row:r})),
  ...checked(history.standalone).filter(r=>['open','closed'].includes(r.state)&&Number.isFinite(r.signedAtMs)).map(r=>({kind:'standalone',time:r.signedAtMs,row:r})),
 ].sort((a,b)=>b.time-a.time||String(a.row.requestId||a.row.id).localeCompare(String(b.row.requestId||b.row.id)));
 const latest=candidates[0];
 if(!latest)return {...base,record:null};
 const r=latest.row;
 const stops=latest.kind==='governed'?checked(await deps.linkedStops(r.requestId)):[];
 const record=latest.kind==='standalone'?standaloneJsaDocument(r):await governedJsaDocument({
  ...deps,list:async c=>['jsa_job_acknowledgments','jsa_job_read_coverage'].includes(c)?stops.filter(x=>c==='jsa_job_acknowledgments'?x.method==='acknowledged':x.method==='scope_read'):[],
 },owner,r,'',[]);
 return {...base,shiftId:r.shiftId||r.binding?.associatedPeriodId||r.binding?.periodId||null,record};
}
