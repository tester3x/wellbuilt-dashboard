import {httpsCallable} from 'firebase/functions';
import {getFirebaseFunctions} from './firebase';
export type DispatchAccountSignal={state:'recently_active'|'signed_out'|'unknown';verifiedAt:number|null;signedOutAt:number|null};
export async function getDispatchDriverSignals(companyId:string,driverIds:string[]):Promise<Record<string,DispatchAccountSignal>>{
 const ids=[...new Set(driverIds.filter(id=>/^[a-zA-Z0-9_-]{8,128}$/.test(id)))];
 const signals:Record<string,DispatchAccountSignal>={};
 for(let offset=0;offset<ids.length;offset+=200){
  const response=await httpsCallable<{companyId:string;driverIds:string[]},{companyId:string;signals:Record<string,DispatchAccountSignal>}>(getFirebaseFunctions(),'staffGetDispatchDriverSignals',{timeout:15000})({companyId,driverIds:ids.slice(offset,offset+200)});
  if(response.data.companyId!==companyId)throw Error('Driver status company mismatch');
  for(const id of ids.slice(offset,offset+200))if(response.data.signals[id])signals[id]=response.data.signals[id];
 }
 return signals;
}
