import * as admin from 'firebase-admin';
import {productionLevelChatDeps} from '../levelReportDelivery';
import {conversationId,CONVERSATIONS} from '../security/dispatchConversations';

jest.mock('firebase-admin',()=>({firestore:Object.assign(jest.fn(),{FieldValue:{serverTimestamp:()=>({toMillis:()=>100})}})}));

test.each([false,true])('old fast-path message is enriched once; newer human preview is preserved=%s',async newer=>{
 const threadId=conversationId('company-a','canonical'),threadPath=`${CONVERSATIONS}/${threadId}`,messagePath=`${threadPath}/messages/level_one`;
 const stamp={toMillis:()=>100},oldText='Fixture Well\nTop: 11 Bottom: 6';
 const rows:Record<string,any>={
  [threadPath]:{companyId:'company-a',driverId:'canonical',audience:'dispatch_team',type:'direct',participants:['driver:canonical','user:office'],
   lastMessage:newer?{senderId:'user:office',text:'Human message',timestamp:{toMillis:()=>200}}:{senderId:'driver:canonical',text:oldText,timestamp:stamp}},
  [messagePath]:{sourcePacketId:'one',senderId:'driver:canonical',text:oldText,timestamp:stamp},
 };
 const updates:any[]=[];
 const ref=(path:string):any=>({path,doc:(key:string)=>ref(`${path}/${key}`),collection:(key:string)=>ref(`${path}/${key}`)});
 const tx={get:async(r:any)=>{const snapshot=rows[r.path]?{...rows[r.path]}:null;return {exists:!!snapshot,data:()=>snapshot,get:(key:string)=>snapshot?.[key]};},
  update:(r:any,patch:any)=>{updates.push({path:r.path,patch});for(const [key,value]of Object.entries(patch)){
    if(key==='lastMessage.text')rows[r.path].lastMessage.text=value;else rows[r.path][key]=value;
  }},create:jest.fn()};
 (admin.firestore as unknown as jest.Mock).mockReturnValue({collection:(key:string)=>ref(key),runTransaction:async(fn:any)=>fn(tx)});
 const deps=productionLevelChatDeps(),message={sourcePacketId:'one',senderId:'driver:canonical',text:'Well marked DOWN · Fixture Well\n'+oldText,wellState:'down'};
 await deps.writeOnce(threadId,'level_one','company-a',['canonical'],message);
 expect(rows[messagePath].text).toBe(message.text);expect(rows[messagePath].timestamp).toBe(stamp);
 expect(rows[threadPath].lastMessage.text).toBe(newer?'Human message':message.text.slice(0,100));
 const count=updates.length;await deps.writeOnce(threadId,'level_one','company-a',['canonical'],message);
 expect(updates).toHaveLength(count);expect(tx.create).not.toHaveBeenCalled();
});
