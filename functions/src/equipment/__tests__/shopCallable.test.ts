const mockDriver=jest.fn();const mockStaff=jest.fn();const mockWhere=jest.fn();const mockGet=jest.fn();const mockMembership=jest.fn();const mockTransaction=jest.fn();
const mockQuery:any={where:(...a:unknown[])=>{mockWhere(...a);return mockQuery;},orderBy:()=>mockQuery,limit:()=>mockQuery,startAfter:()=>mockQuery,get:async()=>({docs:[],size:0})};
jest.mock('firebase-admin',()=>({
 firestore:Object.assign(()=>({collection:(name:string)=>name==='equipment_shop_access'?{doc:()=>({collection:()=>({doc:()=>({get:mockMembership})})})}:{...mockQuery,doc:()=>({get:mockGet,collection:()=>mockQuery})},runTransaction:mockTransaction}),{FieldPath:{documentId:()=> '__name__'}}),
 database:()=>({ref:()=>({once:async()=>({val:()=>({companyId:'company-a',active:true,legalName:'Test Driver'})})})}),
}));
jest.mock('firebase-functions/v2/https',()=>({onCall:(_o:unknown,h:unknown)=>h,HttpsError:class extends Error{code:string;constructor(code:string,message:string){super(message);this.code=code;}}}));
jest.mock('../../security/requireDriverAuth',()=>({requireSecureDriver:(...a:unknown[])=>mockDriver(...a)}));
jest.mock('../../security/trustedStaffAuthority',()=>({requireTrustedCompanyCapability:(...a:unknown[])=>mockStaff(...a)}));
import {equipmentShop} from '../shopCallable';
const invoke=equipmentShop as unknown as (r:unknown)=>Promise<any>;
const req=(data:unknown)=>({auth:{uid:'uid-a',token:{kind:'driver',driverId:'driver-a'}},data});
beforeEach(()=>{jest.clearAllMocks();mockDriver.mockResolvedValue({uid:'uid-a',driverId:'driver-a',companyId:'company-a',displayName:'Driver'});mockMembership.mockResolvedValue({data:()=>({enabled:false})});mockGet.mockResolvedValue({data:()=>({companyId:'company-b',driverId:'driver-a'})});});
test('driver list is bound to verified company and driver',async()=>{
 expect(await invoke(req({op:'list'}))).toMatchObject({staff:false,orders:[]});
 expect(mockWhere).toHaveBeenCalledWith('companyId','==','company-a');expect(mockWhere).toHaveBeenCalledWith('driverId','==','driver-a');
});
test('client cannot inject a staff role or another company',async()=>{await expect(invoke(req({op:'list',staff:true,companyId:'company-b'}))).rejects.toMatchObject({code:'invalid-argument'});});
test('driver cannot update even their own report',async()=>{await expect(invoke(req({op:'update',id:'report_123',revision:1,action:'signoff'}))).rejects.toMatchObject({code:'permission-denied'});expect(mockTransaction).not.toHaveBeenCalled();});
test('cross-company detail is not returned',async()=>{await expect(invoke(req({op:'get',id:'report_123'}))).rejects.toMatchObject({code:'not-found'});});
test('only a server-enabled membership expands driver view to shop queue',async()=>{mockMembership.mockResolvedValue({data:()=>({enabled:true})});expect(await invoke(req({op:'list'}))).toMatchObject({staff:true});expect(mockWhere).not.toHaveBeenCalledWith('driverId','==','driver-a');});
test('unscoped drivers fail before accessing reports',async()=>{mockDriver.mockResolvedValue({uid:'uid-a',driverId:'driver-a'});await expect(invoke(req({op:'list'}))).rejects.toMatchObject({code:'permission-denied'});expect(mockWhere).not.toHaveBeenCalled();});
test('unauthenticated caller cannot use staff authority',async()=>{mockStaff.mockRejectedValue({code:'unauthenticated'});await expect(invoke({data:{op:'list'}})).rejects.toMatchObject({code:'unauthenticated'});expect(mockWhere).not.toHaveBeenCalled();});
