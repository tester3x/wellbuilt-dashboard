const mockUser:Record<string,any>={driverHash:'office-approved',displayName:'OfficeLogin'};
const mockApproved:Record<string,any>={'office-approved':{companyId:'company-a',legalName:'Office Employee'}};
const mockWrites:any[]=[];
jest.mock('firebase-functions/v2/https',()=>({onCall:(_:unknown,handler:unknown)=>handler,
  HttpsError:class extends Error{constructor(public code:string,message:string){super(message);}}}));
jest.mock('../trustedStaffAuthority',()=>({requireTrustedCompanyCapability:async()=>({uid:'office',companyId:'company-a'}),
  decideTrustedCompanyCapability:()=>({ok:false})}));
jest.mock('firebase-admin',()=>{
  const thread={exists:true,data:()=>({companyId:'company-a',participants:['user:office','driver:driver']}),get:()=>false};
  const ref={kind:'thread',get:async()=>thread,collection:()=>({doc:()=>({kind:'message'})})};
  const db={doc:()=>({get:async()=>({data:()=>null})}),collection:()=>({doc:()=>ref}),runTransaction:async(fn:any)=>fn({
    get:async(r:any)=>r.kind==='thread'?thread:{exists:false},create:(_:unknown,row:any)=>mockWrites.push(row),update:()=>{}})};
  return {database:()=>({ref:(path:string)=>{
    const rows:Record<string,any>={'users/office':mockUser,users:{},'drivers/profiles':{},'drivers/approved':mockApproved,
      'drivers/identityBindings/byDriver':{},'drivers/identityBindings/byApproved':{}};
    const query:any={orderByChild:()=>query,equalTo:()=>query,once:async()=>({val:()=>rows[path]})};return query;
  }}),firestore:Object.assign(()=>db,{FieldValue:{serverTimestamp:()=> 'SERVER_TIME'}})};
});
import {staffChat} from '../staffChat';
const send=async()=>{mockWrites.length=0;await (staffChat as any)({auth:{uid:'office'},data:{action:'send',threadId:'thread',clientId:'fixture',text:'Unchanged message'}});return mockWrites[0];};
afterEach(()=>{for(const k of Object.keys(mockUser))delete mockUser[k];Object.assign(mockUser,{driverHash:'office-approved',displayName:'OfficeLogin'});mockApproved['office-approved']={companyId:'company-a',legalName:'Office Employee'};});
test('actual send resolves legacy authorized owner without companyId through company-owned approved real name',async()=>{
  const row=await send();expect(row.senderName).toBe('Office Employee');expect(row.text).toBe('Unchanged message');expect(row.senderId).toBe('user:office');
  expect(mockUser.companyId).toBeUndefined(); // Display projection does not rewrite identity.
});
test('explicit foreign company cannot borrow own real-name or linked display data',async()=>{
  Object.assign(mockUser,{companyId:'foreign',legalName:'Foreign Real Name'});expect((await send()).senderName).toBe('Name unavailable');
});
test('foreign approved link and alias-only account remain unknown instead of leaking or showing login',async()=>{
  mockApproved['office-approved']={companyId:'foreign',legalName:'Foreign Employee'};expect((await send()).senderName).toBe('Name unavailable');
  delete mockUser.driverHash;expect((await send()).senderName).toBe('Name unavailable');
});
