import {onCall,HttpsError} from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import {manageJsaTemplate} from './jsaTemplateManagement';

export async function authorizeTemplateStaff(get:(path:string)=>Promise<Record<string,any>|null>,auth:{uid:string;token:Record<string,any>}|undefined,companyId:unknown){
  if(!auth)throw new HttpsError('unauthenticated','Sign in first');
  if(typeof companyId!=='string'||!/^[A-Za-z0-9_-]{1,120}$/.test(companyId))throw new HttpsError('invalid-argument','Invalid company');
  if(auth.token.wellbuiltAdmin===true && (await get(`platform_admins/${auth.uid}`))?.enabled===true)return;
  const staff=await get(`staff/${auth.uid}`);
  if(staff?.enabled!==true||staff.companyId!==companyId||!['admin','it','manager'].includes(staff.role))throw new HttpsError('permission-denied','Company template management permission required');
}
export const jsaManageTemplate=onCall({timeoutSeconds:30,memory:'256MiB'},async request=>{
  const db=admin.firestore();
  return db.runTransaction(async transaction=>{
    const get=async(path:string)=>{const s=await transaction.get(db.doc(path));return s.exists?s.data()!:null;};
    await authorizeTemplateStaff(get,request.auth,request.data?.companyId);
    return manageJsaTemplate({get,list:async path=>(await transaction.get(db.collection(path))).docs.map(d=>({id:d.id,data:d.data()})),set:(path,data)=>{transaction.set(db.doc(path),data);},delete:path=>{transaction.delete(db.doc(path));}},request.data,request.auth!.uid,new Date().toISOString());
  });
});
