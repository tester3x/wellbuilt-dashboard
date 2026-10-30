const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
let calls=[],currentUser=null,createError,loginError;
function load(file,modules){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:id=>{if(!(id in modules))throw Error(id);return modules[id];},console});return exports;}
const auth=load('src/lib/auth.ts',{
 './firebase':{getFirebaseAuth:()=>({currentUser}),getFirebaseFunctions:()=>({})},'firebase/database':{},
 'firebase/auth':{EmailAuthProvider:{credential:(email,password)=>({email,password})},reauthenticateWithCredential:async()=>calls.push('reauth'),createUserWithEmailAndPassword:async()=>{calls.push('create');if(createError)throw createError;},signInWithEmailAndPassword:async()=>{calls.push('sign-in');if(loginError)throw loginError;}},
 'firebase/functions':{httpsCallable:(_,name)=>async payload=>{calls.push({name,payload});return {data:{ok:true,status:'pending',companyName:'Employer',displayName:payload.displayName}};}}
});
const policy=load('functions/src/security/employeeOnboardingPolicy.ts',{'firebase-functions/v2/https':{HttpsError:Error}});
for(const [role,caps]of Object.entries(policy.EMPLOYEE_ROLE_CAPABILITIES))assert.deepEqual([...caps].sort(),[...auth.DEFAULT_ROLE_CAPABILITIES[role]].sort(),role+' must match displayed permissions');
(async()=>{
 const input={email:'employee@example.test',password:'private-test-password',displayName:'Employee One',legalName:'Person One',companyCode:'VALIDCODE'};
 await auth.registerEmployeeWithEmail(input);assert.equal(calls[0],'create');assert.equal(calls[1].name,'requestEmployeeJoin');assert.equal(calls[1].payload.companyCode,'VALIDCODE');assert.ok(!('roles'in calls[1].payload));assert.ok(!('companyId'in calls[1].payload));
 calls=[];createError={code:'auth/email-already-in-use'};loginError=Error('wrong password');await assert.rejects(()=>auth.registerEmployeeWithEmail(input),/wrong password/);assert.equal(calls.length,2);
 calls=[];createError=undefined;loginError=undefined;currentUser={email:input.email};await auth.registerEmployeeWithEmail({...input,companyCode:undefined,invitationToken:'opaque'});assert.equal(calls[0],'reauth');assert.equal(calls[1].payload.invitationToken,'opaque');assert.ok(!('companyCode'in calls[1].payload));
 const login=fs.readFileSync('src/app/login/page.tsx','utf8'),join=fs.readFileSync('src/app/join/page.tsx','utf8'),panel=fs.readFileSync('src/components/admin/EmployeeOnboardingPanel.tsx','utf8');
 assert.match(login,/href="\/join\/"/);assert.match(login,/Create a company/);assert.match(join,/companyCode/);assert.match(join,/new-password/);assert.match(panel,/Invite Employee/);assert.match(panel,/mailto:/);assert.match(panel,/navigator.clipboard.writeText/);
 const returns=fs.readFileSync('src/components/DashboardReturnState.tsx','utf8');assert.match(returns,/pathname === '\/join'/,'invitation fragments must never be persisted by scroll history');
 assert.ok(!/localStorage|sessionStorage/.test(join),'signup must not persist passwords/invitations');
 console.log('PASS: employee signup auth/retry, no role/company injection, invitation/code paths, role parity and discoverable invitation controls');
})().catch(e=>{console.error(e);process.exitCode=1;});
