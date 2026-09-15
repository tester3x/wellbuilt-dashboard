const fs=require('fs'),ts=require('typescript'),assert=require('node:assert/strict');
const data=new Map(); const clone=v=>v==null?v:JSON.parse(JSON.stringify(v));
const snap=ref=>({id:ref.split('/').at(-1),ref,exists:()=>data.has(ref),data:()=>clone(data.get(ref))});
const firestore={doc:(_, ...p)=>p.join('/'),collection:(_, ...p)=>p.join('/'),getDoc:async r=>snap(r),getDocs:async col=>({docs:[...data.keys()].filter(k=>k.startsWith(col+'/')&&k.slice(col.length+1).indexOf('/')<0).map(snap)}),setDoc:async(r,v)=>data.set(r,clone(v)),runTransaction:async(_,fn)=>{
 const writes=[];const result=await fn({get:async r=>snap(r),set:(r,v,o)=>writes.push(()=>data.set(r,o?.merge?{...data.get(r),...clone(v)}:clone(v))),update:(r,v)=>writes.push(()=>data.set(r,{...data.get(r),...clone(v)})),delete:r=>writes.push(()=>data.delete(r))});writes.forEach(w=>w());return result;
}};
function load(file){const api={};new Function('exports','require',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText)(api,p=>p==='firebase/firestore'?firestore:p==='firebase/functions'?{}:p==='./firebase'?{getFirestoreDb:()=>({})}:load('src/lib/jsaTaskTemplates.ts'));return api;}
const api=load('src/lib/jsaTemplates.ts');const col='jsa_templates/company/templates/';
const template=(name,tasks)=>({name,tasks,steps:[{id:'1',title:'Exact wording',items:[{hazard:'Exact hazard',controls:'Exact control'}]}],ppeItems:[],preparedItems:[]});
(async()=>{
 await api.saveJsaTemplate('company','base',template('Base',[]),'test');await api.activateJsaTemplate('company','base','test');
 await api.saveJsaTemplate('company','load',template('Loading',['Loading']),'test');await api.activateJsaTemplate('company','load','test');
 await api.saveJsaTemplate('company','unload',template('Unloading',['Unloading']),'test');await api.activateJsaTemplate('company','unload','test');
 assert.equal(data.get('jsa_templates/company').activeTemplates.length,3);assert.equal(data.get('jsa_templates/company').name,'Base');
 await assert.rejects(()=>api.saveJsaTemplate('company','load',{name:'Overwrite'},'test'),/Deactivate/);
 await assert.rejects(()=>api.deleteJsaTemplate('company','load'),/cannot be deleted/);
 await api.deactivateJsaTemplate('company','load');await api.saveJsaTemplate('company','load',{steps:[{id:'2',title:'Revised wording',items:[]}]},'test');await api.activateJsaTemplate('company','load','test');
 assert.equal(data.get(col+'load--published-v1').steps[0].title,'Exact wording');assert.equal(data.get(col+'load--published-v2').steps[0].title,'Revised wording');
 assert.equal(data.get(col+'unload').status,'active');
 assert.equal((await api.loadJsaTemplates('company')).length,3);
 await api.deactivateJsaTemplate('company','base');assert.equal(data.get('jsa_templates/company').status,'draft');assert.equal(data.get('jsa_templates/company').activeTemplates.length,2);
 console.log('PASS: publication revisions, active-edit/delete refusal, unrelated tasks retained, legacy mirror preservation and revision list isolation');
})().catch(e=>{console.error(e);process.exitCode=1});
