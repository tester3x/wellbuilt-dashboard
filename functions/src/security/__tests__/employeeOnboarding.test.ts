import {requestEmployeeJoin,resolveEmployeeJoin,getEmployeeJoinStatus,createEmployeeInvitation,getEmployeeInvitation,listEmployeeJoinRequests,syncEmployeeResponsibilities} from '../employeeOnboarding';
import {EMPLOYEE_ROLE_CAPABILITIES,employeeRoleGrant} from '../employeeOnboardingPolicy';
import {TRUSTED_CAPABILITY_ALLOWLIST} from '../trustedStaffAuthority';
import {verifyPasscodeScrypt} from '../passcode';
const mockDocs=new Map<string,any>(),mockRealtime=new Map<string,any>();
let mockFailPath='',mockCompany='company-a',mockDisabled=false,mockAllowed=true;
const clone=(v:any)=>v==null?v:JSON.parse(JSON.stringify(v));
const snapshot=(path:string)=>({exists:mockDocs.has(path),data:()=>clone(mockDocs.get(path))});
const reference=(path:string):any=>({path,get:async()=>snapshot(path),create:async(v:any)=>{if(mockDocs.has(path))throw Error('exists');mockDocs.set(path,clone(v));},update:async(v:any)=>mockDocs.set(path,{...mockDocs.get(path),...clone(v)}),delete:async()=>mockDocs.delete(path)});
const mockDb:any={
 collection:(name:string)=>({
  doc:(id:string)=>reference(name+'/'+id),
  where:(field:string,_op:string,value:any)=>({
   get:async()=>({docs:[...mockDocs.entries()].filter(([p,v])=>p.startsWith(name+'/')&&v[field]===value).map(([,v])=>({data:()=>clone(v)}))})
  })
 }),
 runTransaction:async(fn:any)=>{
  const writes:any[]=[];
  const result=await fn({
   get:async(ref:any)=>{if(writes.length)throw Error('read after write');return snapshot(ref.path);},
   create:(ref:any,v:any)=>writes.push(['create',ref.path,clone(v)]),
   update:(ref:any,v:any)=>writes.push(['update',ref.path,clone(v)]),
   delete:(ref:any)=>writes.push(['delete',ref.path])
  });
  for(const[k,p]of writes){if(k==='create'&&mockDocs.has(p))throw Error('exists');if(k==='update'&&!mockDocs.has(p))throw Error('missing');}
  for(const[k,p,v]of writes){if(k==='delete')mockDocs.delete(p);else mockDocs.set(p,k==='create'?v:{...mockDocs.get(p),...v});}
  return result;
 }
};
jest.mock('firebase-admin',()=>({firestore:()=>mockDb,database:()=>({ref:(path:string)=>({get:async()=>({val:()=>clone(mockRealtime.get(path))}),transaction:async(fn:any)=>{
 if(mockFailPath&&path.startsWith(mockFailPath)){mockFailPath='';throw Error('temporary outage');}
 let value=fn(null);if(value!==undefined&&mockRealtime.has(path))value=fn(clone(mockRealtime.get(path)));
 if(value===undefined)return {committed:false};mockRealtime.set(path,clone(value));return {committed:true,snapshot:{val:()=>clone(value)}};
},update:async(v:any)=>mockRealtime.set(path,{...mockRealtime.get(path),...v})})}),auth:()=>({getUser:async(uid:string)=>({uid,email:uid+'@example.test',disabled:mockDisabled,providerData:[{providerId:'password'}]})})}));
jest.mock('../companyOnboarding',()=>({resolveCompanyJoinCode:async(code:string)=>{if(code!=='VALIDCODE')throw Error('invalid code');return {companyId:'company-a',companyName:'Test Company'};}}));
jest.mock('../rateLimit',()=>({checkRateLimit:async()=>mockAllowed,hashIp:()=> 'ip'}));
jest.mock('../tokenMint',()=>({driverAuthUid:(id:string)=>'driver_'+id.replace(/-/g,'').slice(0,28),ensureDriverAuthUser:async(id:string)=>'driver_'+id.replace(/-/g,'').slice(0,28)}));
jest.mock('../operational/ensureEmptyShiftAuthority',()=>({ensureInitializedEmptyShiftAuthority:async()=>({}),assertEnsureAuthorityOk:()=>{}}));
jest.mock('../trustedStaffAuthority',()=>({...jest.requireActual('../trustedStaffAuthority'),requireTrustedCompanyCapability:async(uid:string)=>{if(uid!=='employer')throw Error('denied');return {uid,companyId:mockCompany};}}));
const request=(data:any={},uid='employee'):any=>({auth:{uid},data,rawRequest:{ip:'127.0.0.1'}});
const signup=(extra:any={})=>requestEmployeeJoin.run(request({companyCode:'VALIDCODE',displayName:'New Employee',legalName:'Employee Legal',passcode:'private-password',...extra}));
const approve=(extra:any={})=>resolveEmployeeJoin.run(request({uid:'employee',action:'approve',roles:['dispatch'],...extra},'employer'));
beforeEach(()=>{mockDocs.clear();mockRealtime.clear();mockFailPath='';mockCompany='company-a';mockDisabled=false;mockAllowed=true;mockDocs.set('companies/company-a',{name:'Test Company',status:'active'});mockDocs.set('trusted_staff_authority/employer',{schemaVersion:1,uid:'employer',companyId:'company-a',active:true,capabilities:[...TRUSTED_CAPABILITY_ALLOWLIST]});});
test('company-code signup is pending, has no grants and never stores plaintext password',async()=>{
 expect(await signup()).toMatchObject({status:'pending',companyName:'Test Company'});
 expect(mockRealtime.get('users/employee')).toMatchObject({role:'driver',status:'pending',companyId:'company-a'});
 expect([...mockDocs.keys()].filter(k=>k.startsWith('trusted_staff_authority/'))).toEqual(['trusted_staff_authority/employer']);
 expect(JSON.stringify([...mockDocs])).not.toContain('private-password');
 expect(await verifyPasscodeScrypt('private-password',mockDocs.get('employee_join_credentials/employee').passcode)).toBe(true);
 const id=mockDocs.get('employee_join_requests/employee').driverId;await signup();expect(mockDocs.get('employee_join_requests/employee').driverId).toBe(id);
});
test('dispatch approval links web/app identity, grants company-scoped dispatch and is replay safe',async()=>{
 await signup();expect(await approve()).toMatchObject({status:'complete'});
 const row=mockDocs.get('employee_join_requests/employee');
 expect(mockRealtime.get('users/employee')).toMatchObject({status:'active',role:'dispatch',driverId:row.driverId});
 expect(mockRealtime.get('drivers/profiles/'+row.driverId)).toMatchObject({roles:['dispatch'],active:true,dashboardUid:'employee'});
 expect(mockDocs.get('trusted_staff_authority/employee').capabilities).toContain('createDispatch');
 expect(mockDocs.get('trusted_staff_authority/employee').capabilities).not.toContain('viewAllCompanies');
 mockDocs.get('trusted_staff_authority/employee').active=false;mockDocs.get('driver_credentials/'+row.driverId).active=false;
 await approve();expect(mockDocs.get('trusted_staff_authority/employee').active).toBe(false);expect(mockDocs.get('driver_credentials/'+row.driverId).active).toBe(false);
});
test('failed provisioning retries keep one canonical employee and do not report approval early',async()=>{
 await signup();mockFailPath='drivers/profiles/';await expect(approve()).rejects.toThrow('temporary outage');
 const id=mockDocs.get('employee_join_requests/employee').driverId;expect((await getEmployeeJoinStatus.run(request())).status).toBe('approving');
 await approve();expect(mockDocs.get('employee_join_requests/employee').driverId).toBe(id);expect((await getEmployeeJoinStatus.run(request())).status).toBe('complete');
});
test('tenant mismatch, caller role/company injection, self-grant and privilege escalation fail closed',async()=>{
 await expect(signup({roles:['admin']})).rejects.toThrow('Invalid employee request');
 await signup();mockCompany='other';mockDocs.get('trusted_staff_authority/employer').companyId='other';await expect(approve()).rejects.toThrow('another company');mockCompany='company-a';mockDocs.get('trusted_staff_authority/employer').companyId='company-a';
 await expect(approve({roles:['it']})).rejects.toThrow('valid employee responsibilities');
 await expect(approve({companyId:'other'})).rejects.toThrow('Invalid employee request');
 await expect(approve({uid:'employer'})).rejects.toThrow('another employee');
 mockDocs.get('trusted_staff_authority/employer').capabilities=['manageDrivers','manageRolesAndCapabilities'];await expect(approve()).rejects.toThrow('beyond your own');
});
test('invitation is opaque, expires, identifies company, binds one applicant and grants nothing',async()=>{
 const link=await createEmployeeInvitation.run(request({},'employer'));const token=link.url.split('#invite=')[1];expect(token).toHaveLength(64);
 expect((await getEmployeeInvitation.run(request({invitationToken:token}))).companyName).toBe('Test Company');
 await signup({companyCode:undefined,invitationToken:token}); // exact transport omits undefined code in real JSON
 const second=request({invitationToken:token,displayName:'Another Employee',passcode:'private-password'},'other');await expect(requestEmployeeJoin.run(second)).rejects.toThrow('no longer available');
 const invitation=[...mockDocs.values()].find(v=>v.createdBy==='employer');invitation.expiresAtMs=0;
 await expect(getEmployeeInvitation.run(request({invitationToken:token}))).rejects.toThrow('expired');
});
test('rejection is terminal, no roles or app credentials are activated',async()=>{
 await signup();await resolveEmployeeJoin.run(request({uid:'employee',action:'reject'},'employer'));
 expect(mockDocs.has('employee_join_credentials/employee')).toBe(false);expect((await approve()).status).toBe('rejected');
});
test('later role demotion removes dispatch authority for both identities',async()=>{
 await signup();await approve();await syncEmployeeResponsibilities('employer','employee',['driver']);
 expect(mockDocs.get('trusted_staff_authority/employee').capabilities).toEqual([]);
 const row=mockDocs.get('employee_join_requests/employee');expect(mockRealtime.get('drivers/profiles/'+row.driverId).roles).toEqual(['driver']);
});
test('requests are company scoped; inactive accounts and rate limits cannot register',async()=>{
 await signup();expect((await listEmployeeJoinRequests.run(request({},'employer'))).requests).toHaveLength(1);mockCompany='other';mockDocs.get('trusted_staff_authority/employer').companyId='other';expect((await listEmployeeJoinRequests.run(request({},'employer'))).requests).toHaveLength(0);
 mockDisabled=true;await expect(signup()).rejects.toThrow('email/password');mockDisabled=false;mockAllowed=false;await expect(signup()).rejects.toThrow('Too many');
});
test('every role grants only allowlisted company capabilities',()=>{
 for(const role of Object.keys(EMPLOYEE_ROLE_CAPABILITIES)){
  const grant=employeeRoleGrant([role],TRUSTED_CAPABILITY_ALLOWLIST);expect(grant.capabilities.every(c=>(TRUSTED_CAPABILITY_ALLOWLIST as readonly string[]).includes(c))).toBe(true);
  expect(grant.capabilities).not.toContain('manageRolesAndCapabilities');
 }
});


test('new Auth email backfill does not block employee signup, but company membership is never adopted',async()=>{
 mockRealtime.set('users/employee',{email:'employee@example.test',displayName:'employee'});
 expect((await signup()).status).toBe('pending');
 mockRealtime.set('users/other',{email:'other@example.test',companyId:'another-company',status:'active'});
 await expect(requestEmployeeJoin.run(request({companyCode:'VALIDCODE',displayName:'Other Person',passcode:'private-password'},'other'))).rejects.toThrow('another setup');
});
test('signup reserves a unique sign-in name before approval and rejection releases only its own reservation',async()=>{
 await signup();
 await expect(requestEmployeeJoin.run(request({companyCode:'VALIDCODE',displayName:'New Employee',passcode:'private-password'},'second'))).rejects.toThrow('another setup');
 await resolveEmployeeJoin.run(request({uid:'employee',action:'reject'},'employer'));
 expect((await requestEmployeeJoin.run(request({companyCode:'VALIDCODE',displayName:'New Employee',passcode:'private-password'},'second'))).status).toBe('pending');
});
