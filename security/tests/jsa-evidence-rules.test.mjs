import {readFileSync} from 'node:fs';
import {initializeTestEnvironment,assertFails,assertSucceeds} from '@firebase/rules-unit-testing';
import {doc,getDoc,setDoc,updateDoc,deleteDoc} from 'firebase/firestore';
const projectId='demo-jsa-audit';
const env=await initializeTestEnvironment({projectId,firestore:{host:'127.0.0.1',port:8183,rules:readFileSync(new URL('../jsa-evidence/firestore.rules',import.meta.url),'utf8')}});
const signed={companyId:'synthetic-company',driverId:'synthetic-driver',signature:'synthetic evidence'};
let count=0;
try{
 await env.withSecurityRulesDisabled(async ctx=>{
  await setDoc(doc(ctx.firestore(),'jsas/synthetic-record'),signed);
  await setDoc(doc(ctx.firestore(),'jsa_read_receipts/synthetic-receipt'),{companyId:signed.companyId,driverHash:signed.driverId});
  await setDoc(doc(ctx.firestore(),'staff/synthetic-staff'),{enabled:true,role:'admin',companyId:signed.companyId});
 });
 const anon=env.unauthenticatedContext().firestore(),own=env.authenticatedContext('synthetic-user',{kind:'driver',app:'jsa',driverId:signed.driverId,companyId:signed.companyId}).firestore();
 const foreign=env.authenticatedContext('foreign-user',{kind:'driver',app:'jsa',driverId:'foreign',companyId:'foreign'}).firestore();
 const staff=env.authenticatedContext('synthetic-staff',{}).firestore();
 for(const db of [anon,foreign]){await assertFails(getDoc(doc(db,'jsas/synthetic-record')));count++;}
 await assertSucceeds(getDoc(doc(own,'jsas/synthetic-record')));count++;
 await assertSucceeds(getDoc(doc(staff,'jsas/synthetic-record')));count++;
 for(const db of [anon,own,foreign,staff]){
  await assertFails(setDoc(doc(db,'jsas/new-signed-record'),signed));count++;
  await assertFails(updateDoc(doc(db,'jsas/synthetic-record'),{signature:'changed'}));count++;
  await assertFails(deleteDoc(doc(db,'jsas/synthetic-record')));count++;
  await assertFails(setDoc(doc(db,'jsa_read_receipts/new-receipt'),{companyId:signed.companyId,driverHash:signed.driverId}));count++;
  await assertFails(getDoc(doc(db,'jsa_read_receipts/synthetic-receipt')));count++;
  await assertFails(setDoc(doc(db,'jsa_legacy_evidence/new-proof'),signed));count++;
  await assertFails(setDoc(doc(db,'jsa_authenticated_receipts/new-proof'),signed));count++;
 }
 await env.withSecurityRulesDisabled(async ctx=>{const r=(await getDoc(doc(ctx.firestore(),'jsas/synthetic-record'))).data();if(r.signature!==signed.signature)throw Error('signed bytes changed');});count++;
 console.log(`PASS ${count} synthetic rules assertions: retained owner/staff reads, immutable signed evidence, no anonymous/foreign/driver/staff direct mutation or receipt access.`);
}finally{await env.cleanup();}
