import {chatTimestamp,splitChat,type PullImportRow} from '../imports/pullParser';
import {calibration,type JsonRecord} from '../imports/pullImportModel';

const cap = 140;
const isNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export function dwyerPhotoObservation(body: JsonRecord, channel: JsonRecord, config: JsonRecord) {
 const photo = body.dwyerPhoto;
 if (!photo || Object.keys(photo).some(k=>!['imageDigest','tagVerified','bottomFeet'].includes(k)) ||
   !/^[a-f0-9]{64}$/.test(photo.imageDigest) || typeof photo.tagVerified!=='boolean' ||
   body.rowIndex!==0 || !channel.wells?.includes('Dwyer') ||
   config?.companyId!=='liquid-gold' || !/^tallgrass$/i.test(config.route || ''))
  throw Error('invalid_dwyer_photo');
 const posts = splitChat(body.chat);
 if (posts.length!==1 || !posts[0].author) throw Error('invalid_dwyer_photo');
 const post = posts[0];
 const postedAt = chatTimestamp(post.date,post.time);
 const review = body.review;
 if (review && (review.confirmed!==true || typeof review.reason!=='string' ||
   review.reason.trim().length<3 || review.reason.length>300 ||
   Object.keys(review).some(k=>!['confirmed','reason','dateTimeUTC','bottomLevelFeet','bblsTaken'].includes(k))))
  throw Error('invalid_review');
 const bank = calibration(config);
 if (config.equalizedTanks!==true || Number(config.activeTanks)!==4 || !(bank>0 && bank<=1000))
  return {issue:'Confirm effective Dwyer four-tank calibration'};
 const bottom = review?.bottomLevelFeet ?? photo.bottomFeet;
 const quantities = [...post.body.matchAll(/^\s*(?:dwyer\s*[-:]?\s*)?(?:i\s+)?(?:hauled|pulled|took)\s+(\d+(?:\.\d+)?)\s*(?:bbls?|barrels?)\.?\s*$/gim)];
 const mentioned = [...post.body.matchAll(/\b(\d+(?:\.\d+)?)\s*(?:bbls?|barrels?)\b/gi)];
 const bareQuantities = [...post.body.matchAll(/^\s*(\d{3}(?:\.\d+)?)\s*$/gm)];
 const conflicting = quantities.length>1 || [...mentioned,...bareQuantities].some(match=>Number(match[1])!==cap);
 const selected = review ? review.bblsTaken : conflicting ? null : cap;
 const source = review?'office_confirmed':quantities.length===1&&!conflicting?'driver_caption':'owner_standard';
 const driverLimit=channel.driverCapacities?.[body.senderId] ?? channel.driverCapacities?.[post.author];
 const limit=Math.min(cap,...[channel.maxLoadBbls,channel.wellLoadLimits?.Dwyer,driverLimit].filter(n=>isNumber(n)&&n>0));
 if ((!photo.tagVerified && !review) || !isNumber(bottom) || bottom<0)
  return {issue:'Confirm Dwyer WTR 3 (LT-5103) and its bottom in decimal feet'};
 if (!isNumber(selected) || selected<=0 || selected>limit)
  return {issue:'Resolve conflicting Dwyer haul evidence within the '+limit+' bbl limit'};
 const top=bottom+selected/bank;
 if (top>Number(config.tankHeight || 40)) return {issue:'Estimated top exceeds the Dwyer tank height'};
 const row:PullImportRow={id:photo.imageDigest,wellName:'Dwyer',author:post.author,postedAt,dateTimeUTC:postedAt,
  tankLevelFeet:top,bottomLevelFeet:bottom,bblsTaken:selected,source:body.chat,issues:[],excluded:false,measurementTimeSource:'posted'};
 const starts=[...post.body.matchAll(/^\s*(?:start(?:ed)?(?:\s+at)?|top)\s*:?\s*(\d+(?:\.\d+)?)\s*(?:ft|feet)\.?\s*$/gim)];
 return {row,proof:{imageDigest:photo.imageDigest,gauge:'WTR 3 / LT-5103',measurementTimeSource:'whatsapp_post',
  bottomSource:review?'reviewed_photo':'ocr',topSource:source==='owner_standard'?'bottom_plus_standard_haul':'bottom_plus_actual_haul',barrelSource:source,
  ocrBottomFeet:isNumber(photo.bottomFeet)?photo.bottomFeet:null,
  bankBblPerFoot:bank,haulLimitBbls:limit,driverReportedStartFeet:starts.length===1?Number(starts[0][1]):null,
  ...(review?{reviewReason:review.reason.trim()}:{})}};
}
