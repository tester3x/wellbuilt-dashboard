const records=new Map<string,any>();
const ref=(key:string)=>({key,get:async()=>({exists:records.has(key),data:()=>records.get(key)})});
jest.mock('firebase-functions/v2/https',()=>({onCall:(_o:any,fn:any)=>fn,onRequest:(_o:any,fn:any)=>fn,HttpsError:class extends Error{constructor(public code:string,message:string){super(message);}}}));
jest.mock('../intake',()=>({authenticate:jest.fn(async()=>{})}));
jest.mock('../remoteReview',()=>({authorizeWatchdogOffice:jest.fn(async(request:any,write=false)=>{if(!request.auth)throw Error('unauthenticated');if(write&&request.auth.uid!=='manager')throw Error('permission-denied');return request.data.companyId;})}));
jest.mock('firebase-admin',()=>({firestore:()=>({doc:ref,runTransaction:async(fn:any)=>fn({get:(r:any)=>r.get(),create:(r:any,v:any)=>{if(records.has(r.key))throw Error('exists');records.set(r.key,v);},set:(r:any,v:any)=>records.set(r.key,{...records.get(r.key),...v}),update:(r:any,v:any)=>records.set(r.key,{...records.get(r.key),...v})})})}));
import {getWatchdogAgentHealth,requestWatchdogRecovery,syncWatchdogAgentV2} from '../remoteAgent';
import {authenticate} from '../intake';
const health={workerReachable:true,state:'Connected',paused:false,lastReceiverCheck:new Date().toISOString(),transportStatus:'Ready',pending:0,reviews:0,channels:8,version:'test',error:''};
const device='watchdog_agents/hp-watchdog',id='request-test-000001';
const office=(extra:any={},uid='manager')=>({auth:{uid},data:{companyId:'liquid-gold',requestId:id,action:'restart_worker',reason:'Recover stopped worker',...extra}});
async function sync(extra:any={}){let code=200,result:any;const response:any={status:(n:number)=>{code=n;return response;},json:(v:any)=>{result=v;}};await (syncWatchdogAgentV2 as any)({body:{agentId:'hp-watchdog',health,...extra}},response);return {code,result};}
beforeEach(()=>{records.clear();process.env.WATCHDOG_HMAC_KEY_V1='synthetic-test-key';(authenticate as jest.Mock).mockResolvedValue(undefined);});
test('no heartbeat is not reported online; view-only staff cannot recover; company scope is enforced',async()=>{
 expect(await (getWatchdogAgentHealth as any)(office())).toMatchObject({installed:false,stale:true});
 await expect((requestWatchdogRecovery as any)(office({},'viewer'))).rejects.toThrow('permission');
 await expect((getWatchdogAgentHealth as any)({data:{companyId:'liquid-gold'}})).rejects.toThrow('unauthenticated');
 await expect((getWatchdogAgentHealth as any)(office({companyId:'other'}))).rejects.toThrow('No Watchdog');
 await expect((requestWatchdogRecovery as any)(office())).rejects.toThrow('Install');
});
test('health sync authenticates, bounds fields and rejects unknown agent, QR or arbitrary command payloads',async()=>{
 expect((await sync()).code).toBe(200);expect(authenticate).toHaveBeenCalledWith(expect.anything(),'syncWatchdogAgentV2');
 expect(records.get(device).seenAt).toBeGreaterThan(0);
 expect((await sync({agentId:'other'})).code).toBe(400);
 expect((await sync({health:{...health,qr:'secret'}})).code).toBe(400);
 (authenticate as jest.Mock).mockRejectedValueOnce(Error('invalid signature'));expect((await sync()).code).toBe(400);
 await expect((requestWatchdogRecovery as any)(office({action:'run_shell'}))).rejects.toThrow('Choose');
});
test('recovery is audited, idempotent and cannot overwrite an unexpired pending request',async()=>{
 await sync();const first=await (requestWatchdogRecovery as any)(office());
 const saved=records.get(device+'/commands/'+id);expect(saved.actorUid).toBe('manager');expect(saved.reason).toBe('Recover stopped worker');
 expect(await (requestWatchdogRecovery as any)(office())).toEqual(first);
 await expect((requestWatchdogRecovery as any)(office({requestId:'request-test-000002'}))).rejects.toThrow('already waiting');
 await expect((requestWatchdogRecovery as any)(office({actorUid:'forged'}))).rejects.toThrow('invalid_agent_payload');
 const delivery=await sync();expect(delivery.result.command.action).toBe('restart_worker');
 await sync({result:{id,ok:true,error:''}});expect(records.get(device+'/commands/'+id).state).toBe('applied');
 expect((await sync()).result.command).toBeNull();
 await sync({result:{id,ok:true,error:''}});expect(records.get(device+'/commands/'+id).state).toBe('applied');
});
test('expired commands are not issued and a delayed old result cannot strand a newer command',async()=>{
 await sync();await (requestWatchdogRecovery as any)(office());jest.spyOn(Date,'now').mockReturnValue(Date.now()+11*60000);
 expect((await sync()).result.command).toBeNull();expect(records.get(device+'/commands/'+id).state).toBe('expired');
 jest.restoreAllMocks();
 const newer='request-test-000002';await (requestWatchdogRecovery as any)(office({requestId:newer,action:'refresh'}));
 const result=await sync({result:{id,ok:false,error:'interrupted'}});expect(result.result.command.id).toBe(newer);
 expect(records.get(device+'/commands/'+id).state).toBe('expired');
 expect((await sync({result:{id:'foreign-request-01',ok:true,error:''}})).code).toBe(400);
});
test('a command changed outside the authorized callable is never issued',async()=>{
 await sync();await (requestWatchdogRecovery as any)(office());records.get(device+'/commands/'+id).action='resume';
 expect((await sync()).result.command).toBeNull();expect(records.get(device+'/commands/'+id).state).toBe('failed');
});
