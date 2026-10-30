import {PullImportRow} from '../imports/pullParser';
/** UI clocks edit minutes only; preserving that minute is not a time correction. */
export function normalizeReviewReason(row:any,review:any):any {
 if(!review||typeof review.reason!=='string'||review.reason.length>300)throw Error('invalid_review');
 const sameTime=Number.isFinite(Date.parse(row.dateTimeUTC))&&Math.floor(Date.parse(row.dateTimeUTC)/60000)===Math.floor(Date.parse(review.dateTimeUTC)/60000);
 const unchanged=sameTime&&['tankLevelFeet','bottomLevelFeet','bblsTaken'].every(key=>!Object.prototype.hasOwnProperty.call(review,key)||(review[key]===null&&row[key]===null)||(typeof review[key]==='number'&&typeof row[key]==='number'&&Math.abs(review[key]-row[key])<1e-8));
 const reason=review.reason.trim();
 if(reason.length<3&&!(!reason&&unchanged))throw Error('Enter a reason when changing a value');
 return {...review,dateTimeUTC:sameTime?row.dateTimeUTC:review.dateTimeUTC,reason:reason||'Confirmed unchanged values'};
}
export function applyReviewCorrections(row:PullImportRow,review:any):PullImportRow{
 if(!review)return row;
 review=normalizeReviewReason(row,review);
 if(Object.keys(review).some(k=>!['dateTimeUTC','reason','confirmed','tankLevelFeet','bottomLevelFeet','bblsTaken','actorUid','timeEstimate'].includes(k))||review.confirmed!==true||typeof review.reason!=='string'||review.reason.trim().length<3||review.reason.length>300||typeof review.dateTimeUTC!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(review.dateTimeUTC)||!Number.isFinite(Date.parse(review.dateTimeUTC)))throw Error('invalid_review');
 if(review.timeEstimate!==undefined){
  const e=review.timeEstimate;
  if(!e||Object.keys(e).some(k=>!['status','method','sampleCount','intervalMinutes','anchorPostedAt'].includes(k))||e.status!=='estimated'||e.method!=='back_to_back_average'||!Number.isInteger(e.sampleCount)||e.sampleCount<3||e.sampleCount>20||!Number.isInteger(e.intervalMinutes)||e.intervalMinutes<15||e.intervalMinutes>240||e.anchorPostedAt!==row.postedAt||Date.parse(review.dateTimeUTC)>=Date.parse(e.anchorPostedAt)||Date.parse(e.anchorPostedAt)-Date.parse(review.dateTimeUTC)>4*e.intervalMinutes*60000)throw Error('invalid_time_estimate');
 }
 const value={...row,dateTimeUTC:review.dateTimeUTC,issues:[...row.issues]};
 for(const key of ['tankLevelFeet','bottomLevelFeet','bblsTaken'] as const)if(Object.prototype.hasOwnProperty.call(review,key)){
  const n=review[key];if(key==='bottomLevelFeet'&&n===null){value[key]=null;continue;}
  if(typeof n!=='number'||!Number.isFinite(n)||n<0||n>(key==='bblsTaken'?1000:40)||(key==='bblsTaken'&&n===0))throw Error('invalid_review_measurement');value[key]=n;
 }
 if(value.bottomLevelFeet!==null&&(value.tankLevelFeet===null||value.bottomLevelFeet>value.tankLevelFeet))throw Error('invalid_review_bottom');
 // An explicit review may discard a mistyped reported bottom. WB M derives the
 // calibrated post-pull level from top and confirmed barrels; retain the raw
 // observation in originalMeasurements rather than inventing a replacement.
 if(Object.prototype.hasOwnProperty.call(review,'bottomLevelFeet')&&
    (value.bottomLevelFeet===null||value.bottomLevelFeet<=value.tankLevelFeet!)){
  value.issues=value.issues.filter(issue=>issue!=='Labelled bottom exceeds top');
 }
 value.issues=value.issues.filter(issue=> !(['Unreadable levels','Inferred level separator needs historical validation'].includes(issue)&&value.tankLevelFeet!==null&&Object.prototype.hasOwnProperty.call(review,'tankLevelFeet'))&&!(issue==='Invalid top level'&&value.tankLevelFeet!==null)&&!(issue==='Missing barrels'&&value.bblsTaken!==null)&&!['Pull time lacks AM/PM; confirm','Invalid stated pull time','Stated time is far from the post; confirm the pull date and time','Multiple wells in one message; confirm individual pull times'].includes(issue));
 return value;
}
