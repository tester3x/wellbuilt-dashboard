/** Compatibility entry for an authenticated, already-owned signed original.
 * Mutable/anonymous/hash-only submission and day-status writes are no longer
 * accepted here. Use the same immutable archive as jsaLegacyEvidence; never
 * rewrite a signed snapshot to add names, timestamps or owner metadata.
 */
import * as https from 'firebase-functions/v2/https';
import {jsaLegacyEvidence} from '../../jsaReceipt/jsaLegacyEvidenceCallable';
export const submitJsaRecord=https.onCall({timeoutSeconds:30,memory:'256MiB',enforceAppCheck:false},async request=>{
 const data=request.data as {jsa?:Record<string,unknown>;jsaId?:string;dayStatus?:unknown;dayStatusId?:unknown}|null;
 if(!data?.jsa||Array.isArray(data.jsa)||typeof data.jsa!=='object'||typeof data.jsa.id!=='string'
  ||!data.jsa.id||(data.jsaId!==undefined&&data.jsaId!==data.jsa.id))throw new https.HttpsError('invalid-argument','stable_signed_record_required');
 if(data.dayStatus!==undefined||data.dayStatusId!==undefined)throw new https.HttpsError('failed-precondition','use_governed_projection_path');
 const result=await jsaLegacyEvidence.run({...request,data:{operation:'store',record:data.jsa}});
 return{ok:true,jsaId:result.recordId,reused:result.reused};
});
