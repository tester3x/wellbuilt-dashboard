import type {JsonRecord} from './imports/pullImportModel';
export interface FlowWindowResult {packetId:string;flowRateDays:number;recoveryInches:number;timeDifDays:number;action:'anchor'|'break'|'reset'|'hold'|'update'}
/** Recompute from observations, so edits/deletions cannot leave stale persisted anchors. */
export function calculateFlowWindows(history:JsonRecord,minimumRecoveryInches:number):FlowWindowResult[]{
 if(!Number.isFinite(minimumRecoveryInches)||minimumRecoveryInches<3||minimumRecoveryInches>24)throw Error('Invalid flow recovery threshold');
 const rows=Object.entries(history).filter(([key,p])=>p&&!p.deleted&&!/^(edit_|delete_|history_)/.test(key))
 .map(([key,p])=>({key,p,time:Date.parse(p.dateTimeUTC||'')})).filter(r=>Number.isFinite(r.time)).sort((a,b)=>a.time-b.time||a.key.localeCompare(b.key));
 let anchor:{time:number;bottom:number}|null=null,removed=0;const result:FlowWindowResult[]=[];
 for(const {key,p,time} of rows){
 const top=Number(p.tankTopInches??Number(p.tankLevelFeet)*12),bottom=Number(p.tankAfterInches),bbl=Number(p.bblsTaken);
 let action:FlowWindowResult['action']='anchor',flowRateDays=0,recoveryInches=0,timeDifDays=0;
 if(p.noLevel||p.wellDown===true||p.flowIntervalBarrier===true||!Number.isFinite(top)||!Number.isFinite(bottom)||!Number.isFinite(bbl)||bbl<=0||top<=0||bottom<0||bottom>top){anchor=null;removed=0;action='break';}
 else if(!anchor){anchor={time,bottom};}
 else {timeDifDays=(time-anchor.time)/86400000;recoveryInches=top-anchor.bottom+removed;
 if(timeDifDays<=0||timeDifDays>30||recoveryInches<0){action='reset';anchor={time,bottom};removed=0;}
 else if(recoveryInches<minimumRecoveryInches){action='hold';removed+=top-bottom;}
 else {const rate=timeDifDays*12/recoveryInches;if(rate>0&&rate<365){flowRateDays=rate;action='update';}else action='reset';anchor={time,bottom};removed=0;}
 }
 result.push({packetId:p.packetId||key,flowRateDays,recoveryInches,timeDifDays,action});
 }
 return result;
}
