import {parsePullChat,findPullChatNotices} from '../imports/pullParser';
import type {JsonRecord} from '../imports/pullImportModel';

/** Only an explicitly armed, exclusive well channel may resume from a new report. */
export function heldResumeCandidate(policy:JsonRecord,body:JsonRecord,configs:JsonRecord,now:number){
 if(!policy?.enabled||policy.channels?.[body.chatId]||body.review||typeof body.chat!=='string'||!Number.isInteger(body.rowIndex))return null;
 for(const [wellName,value] of Object.entries(policy.heldWells||{})){
  const hold=value as JsonRecord,channel=hold.channels?.[body.chatId];
  if(hold.state!=='on_hold'||hold.autoResume?.mode!=='next_load_or_level'||hold.autoResume.consumed||policy.archivedWells?.[wellName]||!channel||channel.wells?.length!==1||channel.wells[0]!==wellName)continue;
  const armed=Date.parse(hold.autoResume.armedAt),cutoff=Date.parse(hold.effectiveAt),config=configs[wellName];
  if(!Number.isFinite(armed)||!Number.isFinite(cutoff)||!config||(config.companyId&&config.companyId!=='liquid-gold'))continue;
  const row=parsePullChat(body.chat,{levelNotation:'feet_inches',wellNames:[wellName],defaultWell:channel.defaultWell||''})[body.rowIndex];
  if(!row||row.excluded||row.wellName!==wellName||typeof row.tankLevelFeet!=='number'||!Number.isFinite(row.tankLevelFeet)||row.tankLevelFeet<0)continue;
  if(findPullChatNotices(body.chat).length||row.issues.some(issue=>!['Inferred level separator needs historical validation','Missing barrels','Confirm measurement time for top-only reading'].includes(issue)))continue;
  if(Number(config.tankHeight)>0&&row.tankLevelFeet>Number(config.tankHeight))continue;
  if(row.bottomLevelFeet!==null&&(row.bottomLevelFeet<0||row.bottomLevelFeet>row.tankLevelFeet))continue;
  const posted=Date.parse(row.postedAt),measured=Date.parse(row.dateTimeUTC);
  if(!(posted>armed&&posted<=now+300000&&measured>=cutoff&&measured<=now+300000))continue;
  return {wellName,hold,channel,row};
 }
 return null;
}

export function applyHeldResume(policy:JsonRecord,candidate:NonNullable<ReturnType<typeof heldResumeCandidate>>,body:JsonRecord,now:number){
 const {wellName,hold,channel,row}=candidate;
 return {...policy,channels:{...policy.channels,[body.chatId]:{...channel,resumeAfterPostedAt:hold.autoResume.armedAt}},
  heldWells:{...policy.heldWells,[wellName]:{...hold,state:'resumed',resumedAt:new Date(now).toISOString(),
   resumedBy:{messageId:body.messageId,chatId:body.chatId,postedAt:row.postedAt},autoResume:{...hold.autoResume,consumed:true}}}};
}

export function heldWellLifecycle(policy:JsonRecord){
 return Object.entries(policy.heldWells||{}).filter(([,h]:any)=>h.state==='on_hold').map(([wellName,h]:any)=>({wellName,
  channels:Object.keys(h.channels||{}),archive:null,state:'held',hold:{effectiveAt:h.effectiveAt,autoResume:h.autoResume||null}}));
}
