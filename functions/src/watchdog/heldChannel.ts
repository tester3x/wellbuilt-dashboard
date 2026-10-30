import * as admin from 'firebase-admin';
import {heldResumeCandidate,applyHeldResume} from './monitoringHold';
import type {JsonRecord} from '../imports/pullImportModel';

export async function resumeHeldChannel(body:JsonRecord,initial:JsonRecord){
 const names=Object.entries(initial.heldWells||{}).filter(([,h]:any)=>h.state==='on_hold'&&h.autoResume?.mode==='next_load_or_level'&&h.channels?.[body.chatId]).map(([name])=>name);
 if(!names.length)return null;
 const configs:JsonRecord={};for(const name of names)configs[name]=(await admin.database().ref('well_config/'+name).once('value')).val();
 const ref=admin.firestore().doc('watchdog_v2_config/laptop');
 return admin.firestore().runTransaction(async tx=>{
  const policy=(await tx.get(ref)).data();if(!policy?.enabled)return null;
  if(policy.channels?.[body.chatId])return policy.channels[body.chatId];
  const now=Date.now(),candidate=heldResumeCandidate(policy,body,configs,now);if(!candidate)return null;
  const next=applyHeldResume(policy,candidate,body,now);tx.set(ref,next);return next.channels[body.chatId];
 });
}
