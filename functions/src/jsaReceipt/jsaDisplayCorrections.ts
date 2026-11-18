import {parseAuthPrincipal,requireAudience,JSA_APP_JSA} from './jsaReceiptCore';
type Row=Record<string,any>;
export type CorrectionStore={list(company:string,driver:string):Promise<Row[]>;put(entry:Row):Promise<void>};
export async function jsaDisplayCorrectionOperation(store:CorrectionStore,auth:{uid?:string|null;claims?:Record<string,unknown>},body:unknown,now=Date.now()){
 const parsed=parseAuthPrincipal(auth);if(!parsed.ok||!requireAudience(parsed.value,JSA_APP_JSA).ok)throw Error('not_authorized');const p=parsed.value,b=body as Row;
 if(!b||Array.isArray(b)||!['list','put'].includes(b.operation)||Object.keys(b).some(k=>!['operation','entry'].includes(k)))throw Error('invalid_input');
 if(b.operation==='list'){if(b.entry!==undefined)throw Error('invalid_input');const entries=await store.list(p.companyId,p.driverId);if(entries.length>500||entries.some(e=>e.companyId!==p.companyId||e.driverId!==p.driverId))throw Error('scope_or_size');return {schemaVersion:1,companyId:p.companyId,driverId:p.driverId,entries};}
 const e=b.entry;const allowed=['schemaVersion','recordId','sourceFingerprint','companyId','driverId','confirmedBy','actorUid','confirmedAtMs','reason','operator','locations'];
 if(!e||Array.isArray(e)||Object.keys(e).some(k=>!allowed.includes(k))||e.schemaVersion!==1||e.companyId!==p.companyId||e.driverId!==p.driverId||e.actorUid!==auth.uid||typeof e.recordId!=='string'||!/^[A-Za-z0-9._-]{1,160}$/.test(e.recordId)||typeof e.sourceFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(e.sourceFingerprint)||!Number.isSafeInteger(e.confirmedAtMs)||e.confirmedAtMs<1||e.confirmedAtMs>now+300000)throw Error('invalid_input');
 const text=(v:unknown,max:number)=>typeof v==='string'&&v.trim().length>0&&v.trim().length<=max;
 if(!text(e.reason,500)||!text(e.confirmedBy,300)||e.operator!==undefined&&!text(e.operator,300)||e.locations!==undefined&&(!Array.isArray(e.locations)||!e.locations.length||e.locations.length>20||e.locations.some((v:unknown)=>!text(v,300)))||e.operator===undefined&&e.locations===undefined)throw Error('invalid_input');
 await store.put({...e,receivedAtMs:now});return {schemaVersion:1,saved:true,receivedAtMs:now,companyId:p.companyId,driverId:p.driverId};
}
