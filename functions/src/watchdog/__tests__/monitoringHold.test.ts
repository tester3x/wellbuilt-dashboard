import {heldResumeCandidate,applyHeldResume,heldWellLifecycle} from '../monitoringHold';
const now=Date.parse('2026-10-27T20:00:00Z');
const configs={'Cyclone 2':{tankHeight:20,companyId:'liquid-gold'}};
const policy=()=>({enabled:true,channels:{other:{wells:['Other']}},heldWells:{'Cyclone 2':{state:'on_hold',effectiveAt:'2026-10-26T16:46:48Z',channels:{group:{wells:['Cyclone 2'],defaultWell:'Cyclone 2',defaultBbls:170}},autoResume:{mode:'next_load_or_level',armedAt:'2026-10-27T19:00:00Z'}}}});
const report=(content='Cyclone 2\nTop 9\'2"\nBottom 7\'2"\n170 bbl',stamp='10/27/2026, 14:30:00')=>({chatId:'group',messageId:'new',rowIndex:0,chat:`[${stamp}] Driver: ${content}`});
test('new load and level reports qualify; chatter and other wells do not',()=>{
 for(const text of [undefined,'Cyclone 2\nTop 9\'2"'])expect(heldResumeCandidate(policy(),report(text),configs,now)?.wellName).toBe('Cyclone 2');
 for(const text of ['We are waiting','Cyclone 3\nTop 9\'2"\nBottom 7\'2"\n170 bbl','Cyclone 2\nTop 25\n170 bbl','Cyclone 2\nTop 9\nBottom 12\n170 bbl','Cyclone 2\nTop unknown\n170 bbl'])expect(heldResumeCandidate(policy(),report(text),configs,now)).toBeNull();
});
test('old, future, edited review, unarmed, archived and shared channels cannot resume',()=>{
 for(const stamp of ['10/26/2026, 11:46:48','10/27/2026, 14:00:00','10/28/2026, 14:30:00'])expect(heldResumeCandidate(policy(),report(undefined,stamp),configs,now)).toBeNull();
 expect(heldResumeCandidate(policy(),{...report(),review:{confirmed:true}},configs,now)).toBeNull();
 for(const change of [(p:any)=>delete p.heldWells['Cyclone 2'].autoResume,(p:any)=>p.archivedWells={'Cyclone 2':{}},(p:any)=>p.heldWells['Cyclone 2'].channels.group.wells.push('Cyclone 3')]){const p=policy();change(p);expect(heldResumeCandidate(p,report(),configs,now)).toBeNull();}
});
test('one-shot restoration retains settings and unrelated holds with a durable cutoff',()=>{
 const p=policy(),before=JSON.stringify(p),candidate=heldResumeCandidate(p,report(),configs,now)!;
 const next=applyHeldResume(p,candidate,report(),now);
 expect(JSON.stringify(p)).toBe(before);
 expect(next.channels.group).toEqual({...p.heldWells['Cyclone 2'].channels.group,resumeAfterPostedAt:p.heldWells['Cyclone 2'].autoResume.armedAt});
 expect(next.channels.other).toEqual(p.channels.other);
 expect(next.heldWells['Cyclone 2']).toMatchObject({state:'resumed',autoResume:{consumed:true},resumedBy:{messageId:'new'}});
 expect(heldResumeCandidate(next,report(),configs,now)).toBeNull();
 expect(heldWellLifecycle(p)).toMatchObject([{wellName:'Cyclone 2',state:'held',hold:{autoResume:{mode:'next_load_or_level'}}}]);
 expect(heldWellLifecycle(next)).toEqual([]);
});
