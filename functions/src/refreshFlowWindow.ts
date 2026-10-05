import {effectiveFlow} from './effectiveFlow';
const display=(days:number)=>{const s=Math.round(days*86400);return `${Math.floor(s/3600)}:${String(Math.floor(s/60)%60).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;};
/** Refresh only derived fields; original measurements, ownership and down state are preserved. */
export async function refreshFlowWindow(db:any,wellName:string):Promise<void>{
 const cfg=(await db.ref('well_config/'+wellName).once('value')).val()||{};
 if(!cfg.flowWindowMinimumRecoveryInches)return;
 const history=(await db.ref('packets/processed').orderByChild('wellName').equalTo(wellName).once('value')).val()||{};
 const flow=effectiveFlow(history,cfg);if(!flow)return;
 const updates:any={};
 for(const r of flow.results){const key=Object.keys(history).find(k=>(history[k].packetId||k)===r.packetId);if(!key)continue;for(const [field,value] of Object.entries({flowRateDays:r.flowRateDays,flowRate:r.flowRateDays?display(r.flowRateDays):'',recoveryInches:r.recoveryInches,timeDifDays:r.timeDifDays,flowIntervalAction:r.action}))updates[`packets/processed/${key}/${field}`]=value;}
 if(Object.keys(updates).length)await db.ref().update(updates);
 if(!(flow.averageDays>0))return;
 const last=Object.values(history).filter((p:any)=>p.requestType==='pull'&&!p.noLevel&&!p.deleted&&Number(p.tankTopInches)>0).sort((a:any,b:any)=>Date.parse(b.dateTimeUTC)-Date.parse(a.dateTimeUTC))[0] as any;
 if(!last)return;
 const rate=display(flow.averageDays),bank=Number(cfg.bblPerFoot)||20*(cfg.tanks||cfg.numTanks||1);
 const needed=Math.max(0,(Number(cfg.bottomLevel??cfg.allowedBottom??1)+Number(cfg.pullBbls||140)/bank)*12-Number(last.tankAfterInches));
 const waitDays=needed/12*flow.averageDays,next=new Date(Date.parse(last.dateTimeUTC)+waitDays*86400000).toISOString(),bbl=Math.round(bank/flow.averageDays);
 const outgoing=(await db.ref('packets/outgoing').orderByChild('wellName').equalTo(wellName).once('value')).val()||{};
 for(const [key,value] of Object.entries(outgoing)){const p=value as any;if(p.lastPullPacketId!==last.packetId)continue;
 await db.ref('packets/outgoing/'+key).transaction((current:any)=>current?.lastPullPacketId===last.packetId&&current.lastPullDateTimeUTC===last.dateTimeUTC?{...current,flowRate:rate,bbls24hrs:String(bbl),windowBblsDay:null,overnightBblsDay:null,nextPullTimeUTC:next,nextPullTime:new Intl.DateTimeFormat('en-US',{timeZone:current.timezone||'America/Chicago',dateStyle:'short',timeStyle:'short'}).format(new Date(next)),timeTillPull:current.wellDown?'Down':display(waitDays).split(':').slice(0,2).join(':'),isEdit:true,timestamp:new Date().toISOString(),timestampUTC:new Date().toISOString()}:undefined);
 }
 await db.ref('wells/'+wellName+'/status').transaction((status:any)=>status?.lastPull?.packetId===last.packetId?{...status,calculated:{...status.calculated,flowRate:rate,flowRateMinutes:Math.round(flow.averageDays*144000)/100,bbls24hrs:bbl,nextPullTimeUTC:next,nextPullTime:new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',dateStyle:'short',timeStyle:'short'}).format(new Date(next)),timeTillPull:status.isDown?'Down':display(waitDays).split(':').slice(0,2).join(':')}}:undefined);
 await db.ref('well_config/'+wellName).update({avgFlowRate:rate,avgFlowRateMinutes:Math.round(flow.averageDays*144000)/100});
}

