const mockRows = new Map<string, any>();
class MockRef {
  constructor(public path: string, public filter?: [string, any]) {}
  get id() { return this.path.split('/').at(-1)!; }
  collection(name: string) { return new MockRef(this.path + '/' + name); }
  doc(name: string) { return new MockRef(this.path + '/' + name); }
  limit() { return this; }
  where(field: string, _op: string, value: any) { return new MockRef(this.path, [field, value]); }
  async get() {
    const prefix = this.path + '/';
    return { docs: [...mockRows].filter(([key, value]) => key.startsWith(prefix)
      && !key.slice(prefix.length).includes('/') && (!this.filter || value[this.filter[0]] === this.filter[1]))
      .map(([key, value]) => mockSnapshot(key, value)) };
  }
}
function mockSnapshot(key: string, value: any) {
  return { id: key.split('/').at(-1), exists: !!value, data: () => value, get: (field: string) => value?.[field] };
}
jest.mock('firebase-admin', () => ({ firestore: Object.assign(() => ({ collection: (path: string) => new MockRef(path),
  runTransaction: async (work: any) => work({ get: async (ref: MockRef) => mockSnapshot(ref.path, mockRows.get(ref.path)),
    create: (ref: MockRef, value: any) => { if (mockRows.has(ref.path)) throw Error('exists'); mockRows.set(ref.path, value); },
    update: (ref: MockRef, value: any) => { const next={...mockRows.get(ref.path)};for(const [key,v] of Object.entries(value))next[key]=(v as any)?.arrayUnion ? [...(next[key]||[]),(v as any).arrayUnion]:v;mockRows.set(ref.path,next); },
    set: (ref: MockRef, value: any) => mockRows.set(ref.path, value) }),
}), { FieldValue: { arrayUnion: (value:any)=>({arrayUnion:value}), serverTimestamp: () => ({ toDate: () => new Date('2026-11-18T03:00:00Z') }) } }) }));
jest.mock('../operational/shiftAuthorityCallables', () => ({ resolveSubject: async (request: any) => {
  if (request.auth?.token?.kind !== 'driver') throw Error('driver_session_required');
  return { driverId: request.auth.token.driverId, companyId: 'company-a' };
} }));
jest.mock('../trustedStaffAuthority', () => ({ requireTrustedCompanyCapability: async (uid: string, cap: string) => {
  if (['dispatcher', 'dual'].includes(uid) && cap === 'createDispatch') return { uid, companyId: 'company-a' };
  if (uid === 'foreign' && cap === 'createDispatch') return { uid, companyId: 'company-b' };
  throw Error('permission-denied');
} }));
import { driverJobExceptionsHandler as driver, reviewJobExceptionsHandler as staff } from '../jobExceptions';
const scope = () => ({ jobId:'job-a',jobType:'Production Water',pickup:'Burger 1',dropoff:'burger 1',pickupLat:48,pickupLng:-103,dropoffLat:48,dropoffLng:-103 });
const dreq = (action: string, extra: any = {}) => ({ auth:{uid:'dual',token:{kind:'driver',app:'wbt',driverId:'driver-a',roles:['admin']}},data:{action,scope:scope(),reason:'Company wants this load billed as PW',...extra} } as any);
const sreq = (uid: string, data: any, token: any = {}) => ({auth:{uid,token},data} as any);
beforeEach(() => { mockRows.clear(); mockRows.set('companies/company-a',{liveDispatchSync:true});
 mockRows.set('invoices/job-a',{status:'open',companyId:'company-a',driverId:'driver-a',wellName:'Burger 1',commodityType:'Production Water'}); });
test('hybrid and dispatch-only cannot self approve, even trusted admin driver or client mode spoof',async()=>{
 for(const mode of [true,false]) { mockRows.set('companies/company-a',{liveDispatchSync:mode});
  await expect(driver(dreq('selfApprove',{mode:'independent',isAdmin:true}))).rejects.toThrow('Dispatch/admin');
  const r=await driver(dreq('request'));expect(r.status).toBe('pending'); }
 expect([...mockRows.keys()].filter(k=>k.includes('job_exception_requests'))).toHaveLength(2);
});
test('same uid requires an explicit staff session; cross company and plain driver cannot review',async()=>{
 const r=await driver(dreq('request'));
 await expect(staff(sreq('dual',{action:'approve',id:r.id,note:'Reviewed'},{kind:'driver',app:'wbt'}))).rejects.toThrow('staff session');
 await expect(staff(sreq('foreign',{action:'approve',id:r.id,note:'Reviewed'}))).rejects.toThrow('not found');
 await expect(staff(sreq('other',{action:'approve',id:r.id,note:'Reviewed'}))).rejects.toThrow('permission-denied');
 await staff(sreq('dual',{action:'approve',id:r.id,note:'Contract checked explicitly'}));
 expect((await driver(dreq('status'))).status).toBe('approved');
 const row=[...mockRows.values()].find(v=>v.kind==='same_site_pw');expect(row.reviewedBy).toBe('dual');expect(row.reviewSource).toBe('staff_review');
});
test('independent can self approve; role is irrelevant and all job evidence stays unchanged',async()=>{
 mockRows.set('companies/company-a',{});const before=JSON.stringify(mockRows.get('invoices/job-a'));
 const r=await driver(dreq('selfApprove'));expect(r.mode).toBe('independent');expect(r.status).toBe('approved');
 expect((await driver(dreq('status'))).status).toBe('approved');
 expect(JSON.stringify(mockRows.get('invoices/job-a'))).toBe(before);
 mockRows.set('companies/company-a',{liveDispatchSync:true});expect((await driver(dreq('status'))).status).toBe('none');
});
test('approval is bound to job, location, coordinates and job type, never a global location bypass',async()=>{
 const r=await driver(dreq('request'));await staff(sreq('dispatcher',{action:'approve',id:r.id,note:'Checked contract'}));
 for(const change of [{jobType:'Production Water (hr)'},{pickup:'Gab 1',dropoff:'Gab 1'},{pickupLat:48.001,dropoffLat:48.001}]) {
  expect((await driver(dreq('status',{scope:{...scope(),...change}}))).status).toBe('none'); }
 mockRows.set('invoices/job-b',{status:'open',companyId:'company-a',driverId:'driver-a'});
 expect((await driver(dreq('status',{scope:{...scope(),jobId:'job-b'}}))).status).toBe('none');
 expect([...mockRows.values()].filter(v=>v.kind==='same_site_pw')).toHaveLength(1);
});
test('replays create once; rejection and missing reason cannot become approval',async()=>{
 const a=await driver(dreq('request')),b=await driver(dreq('request'));expect(a.id).toBe(b.id);
 expect((await staff(sreq('dispatcher',{action:'list'})) as any).items).toHaveLength(1);
 await expect(staff(sreq('dispatcher',{action:'approve',id:a.id,note:''}))).rejects.toThrow('reason');
 await staff(sreq('dispatcher',{action:'reject',id:a.id,note:'Wrong job type'}));
 await expect(driver(dreq('request'))).rejects.toThrow('rejected');
 expect((await driver(dreq('status'))).status).toBe('rejected');
});
test('unknown mode, foreign/closed/grouped job, wrong audience and mismatched sites refuse',async()=>{
 await expect(driver(dreq('request',{scope:{...scope(),dropoff:'Hydro Clear'}}))).rejects.toThrow('same-site');
 await expect(driver({...dreq('request'),auth:{uid:'dual',token:{kind:'driver',app:'jsa',driverId:'driver-a'}}})).rejects.toThrow('Tickets');
 for(const patch of [{companyId:'foreign'},{driverId:'other'},{status:'closed'},{haulGroupId:'group'}]) {
  mockRows.set('invoices/job-a',{status:'open',companyId:'company-a',driverId:'driver-a',...patch});
  await expect(driver(dreq('request'))).rejects.toThrow(); }
 mockRows.set('companies/company-a',{liveDispatchSync:null});await expect(driver(dreq('request'))).rejects.toThrow('mode');
});

