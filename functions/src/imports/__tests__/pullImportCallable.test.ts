const mockDocuments = new Map<string, any>();
let mockTree: Record<string, any> = {};
let mockCompany = 'liquid-gold';
let mockUid: string | undefined = 'staff';
const clone = (value: any) => value === undefined ? null : JSON.parse(JSON.stringify(value));
const mockDatabase = {
  ref(path: string) {
    let match: string | undefined;
    return {
      orderByChild() { return this; }, equalTo(value: string) { match = value; return this; },
      async once() { let value = mockTree[path]; if (match !== undefined) value = Object.fromEntries(Object.entries(value || {}).filter(([,row]: any)=>row.wellName === match)); return { val:()=>clone(value) }; },
      async transaction(callback: (value: any)=>any) { const next=callback(clone(mockTree[path])); if(next===undefined) return {committed:false}; mockTree[path]=clone(next); if(path.startsWith('packets/processed/')) mockTree['packets/processed'][path.split('/').pop()!]=clone(next); return {committed:true}; },
    };
  },
};
const mockFirestore = {
  collection(collection: string) { return {doc(id: string) { const key=collection+'/'+id; return {key,async set(value:any){mockDocuments.set(key,clone(value));},async update(value:any){mockDocuments.set(key,{...mockDocuments.get(key),...clone(value)});} }; } }; },
  async runTransaction(callback:any) {return callback({async get(ref:any){return {exists:mockDocuments.has(ref.key),data:()=>clone(mockDocuments.get(ref.key))};},update(ref:any,value:any){mockDocuments.set(ref.key,{...mockDocuments.get(ref.key),...clone(value)});}});},
};
jest.mock('firebase-admin',()=>({database:()=>mockDatabase,firestore:()=>mockFirestore}));
jest.mock('firebase-functions/v2/https',()=>({...jest.requireActual('firebase-functions/v2/https'),onCall:(_settings:any,handler:any)=>handler}));
jest.mock('../../security/trustedStaffAuthority',()=>({TRUSTED_CAPABILITY_MANAGE_DRIVERS:'manageDrivers',requireTrustedCompanyCapability:async (uid:string)=>{if(!uid) throw new Error('Unauthenticated');return {uid,companyId:mockCompany};}}));
jest.mock('../../security/audit',()=>({writeSecurityAudit:async()=>undefined}));
import { previewHistoricalPullImport, applyHistoricalPullImport } from '../pullImportCallable';
import { parsePullChat } from '../pullParser';
const preview = async()=> (previewHistoricalPullImport as any)({auth:{uid:mockUid},data:{rows:parsePullChat('[9/20/26, 3:00 PM] Driver: Kahuna 5- 8.0/7.0\n180 bbls\n[9/20/26, 5:00 PM] Driver: Kahuna 5- 8.0/7.0\n180 bbls'),banks:{},acknowledged:[],calibrationConfirmed:true}});
const apply = async(stage:any, ids=stage.rows.filter((r:any)=>r.status==='ready').map((r:any)=>r.id)) => (applyHistoricalPullImport as any)({auth:{uid:mockUid},data:{batchId:stage.batchId,selectedIds:ids}});
beforeEach(()=>{
 mockDocuments.clear();mockCompany='liquid-gold';mockUid='staff';
 mockTree={'well_config':{'Kahuna 5':{bblPerFoot:180,tankHeight:20}},'packets/processed':{},'wells/Kahuna 5/status':{isDown:true,current:{level:"9'0\"",asOf:'2026-10-01T20:00:00Z'},lastPull:{packetId:'live',dateTimeUTC:'2026-10-01T20:00:00Z'},calculated:{flowRate:'1:00:00'}},'well_config/Kahuna 5':{bblPerFoot:180,tankHeight:20}};
});
test('unauthenticated and other-company staff cannot preview',async()=>{
 mockUid=undefined;await expect(preview()).rejects.toThrow('Unauthenticated');mockUid='staff';mockCompany='other-company';await expect(preview()).rejects.toThrow('Global well pool');
});
test('selected import preserves last/current/down, never queues jobs, and replay adds nothing',async()=>{
 const before=clone(mockTree['wells/Kahuna 5/status']);const stage=await preview();const result=await apply(stage);
 expect(result.imported).toBe(2);const status=mockTree['wells/Kahuna 5/status'];expect(status.lastPull).toEqual(before.lastPull);expect(status.current).toEqual(before.current);expect(status.isDown).toBe(true);
 expect(Object.keys(mockTree).some(key=>key.includes('incoming')||key.includes('invoice')||key.includes('canonical_jobs'))).toBe(false);
 const replay=await apply(stage);expect(replay.replay).toBe(true);expect(Object.keys(mockTree['packets/processed'])).toHaveLength(2);
});
test('a different staff member cannot apply the staged batch',async()=>{
 const stage=await preview();mockUid='other-staff';await expect(apply(stage)).rejects.toThrow('another staff');expect(Object.keys(mockTree['packets/processed'])).toHaveLength(0);
});
test('new live history after preview prevents all import writes',async()=>{
 const stage=await preview();mockTree['packets/processed'].live={wellName:'Kahuna 5',dateTimeUTC:'2026-10-02T00:00:00Z',tankLevelFeet:8,bblsTaken:180};await expect(apply(stage)).rejects.toThrow('changed');expect(Object.keys(mockTree['packets/processed'])).toEqual(['live']);
});
test('preview expiry and unapproved selection are refused',async()=>{
 let stage=await preview();const key='historical_pull_imports/'+stage.batchId;mockDocuments.get(key).expiresAt=0;await expect(apply(stage)).rejects.toThrow('expired');stage=await preview();await expect(apply(stage,['not-a-row'])).rejects.toThrow('Only ready');
});
