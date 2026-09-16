const fs=require('fs'),ts=require('typescript'),assert=require('node:assert/strict');
const calls=[];const api={};
const source=fs.readFileSync('src/lib/jsaTemplates.ts','utf8');
new Function('exports','require',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText)(api,p=>p==='firebase/firestore'?{}:p==='firebase/functions'?{httpsCallable:(_,name)=>async body=>{assert.equal(name,'jsaManageTemplate');calls.push(body);return{data:{id:body.templateId}}}}:p==='./firebase'?{getFirebaseFunctions:()=>({})}:{});
(async()=>{
 const locationLayout={schemaVersion:1,locationsCoveredPlacement:'after-job-details',locationDifferencesPlacement:'after-assessment'};
 await api.saveJsaTemplate('company','load',{name:'Loading',tasks:['loading'],locationLayout,version:99,status:'active',updatedBy:'forged'},'forged');
 assert.deepEqual(calls[0],{companyId:'company',templateId:'load',operation:'save',data:{name:'Loading',tasks:['loading'],locationLayout}});
 await api.activateJsaTemplate('company','load','forged');await api.deactivateJsaTemplate('company','load');await api.deleteJsaTemplate('company','load');
 assert.deepEqual(calls.map(c=>c.operation),['save','publish','deactivate','delete']);
 assert.ok(!/runTransaction|setDoc|updateDoc|deleteDoc/.test(source));
 console.log('5 publication transport assertions passed: authenticated callable operations, server-owned metadata, no direct writes');
})().catch(e=>{console.error(e);process.exitCode=1});
