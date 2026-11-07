import {createRequire} from 'node:module';
import path from 'node:path';
import {hash,header} from './core.mjs';

// Effective Dwyer configuration verified for this intake. Review-only estimates
// retain the snapshot so they can be checked against the configuration at haul time.
export const dwyerBank = {activeTanks:4,bblPerFootPerTank:25.5,defaultBarrels:140};
const maxImageBytes = 12 * 1024 * 1024;
const require = createRequire(import.meta.url);
export const isTallgrassChannel = channel => /\btallgrass\b/i.test(channel.name || '');

// Each region is relative to the verified Tallgrass panel crop. Check the
// panel's tags before using these regions. Other layouts go to review.
const tags = [
  ['LT5101',[.27,0,.18,.045],175],
  ['LT5102',[.53,0,.18,.047],150],
  ['LT5104',[.29,.445,.17,.035],215],
  ['WTR3',[.55,.482,.15,.024],135],
];
const wtr3Value = [502/900,1155/1600,84/900,50/1600];

export async function readDwyerGauge(image) {
  const [{default:sharp},{createWorker,PSM}] = await Promise.all([import('sharp'),import('tesseract.js')]);
  const input = sharp(image,{limitInputPixels:24_000_000});
  const {width,height} = await input.metadata();
  const worker = await createWorker('eng',1,{
    langPath:path.dirname(require.resolve('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz')),
    cacheMethod:'none',
  });
  try {
    await worker.setParameters({tessedit_pageseg_mode:PSM.SINGLE_LINE});
    async function crop([x,y,w,h],outputWidth) {
      return input.clone().extract({
        left:Math.round(x*width),top:Math.round(y*height),
        width:Math.round(w*width),height:Math.round(h*height),
      }).resize({width:outputWidth}).median(5).greyscale().normalise().png().toBuffer();
    }
    async function readTag([x,y,w,h],threshold) {
      const crop = await input.clone().extract({
        left:Math.floor(x*width),top:Math.floor(y*height),
        width:Math.floor(w*width),height:Math.floor(h*height),
      }).resize({width:480}).median(5).greyscale().normalise().threshold(threshold).negate()
        .extend({top:25,bottom:25,left:25,right:25,background:'white'}).png().toBuffer();
      return (await worker.recognize(crop)).data.text.trim().toUpperCase();
    }
    for (const [tag,region,threshold] of tags) {
      const label = (await readTag(region,threshold)).replace(/[^A-Z0-9]/g,'');
      if (label !== tag) return {tagVerified:false,bottomFeet:null};
    }
    await worker.setParameters({tessedit_char_whitelist:'0123456789.'});
    const display = await crop(wtr3Value,400);
    const readings = [];
    for (const threshold of [120,130,140]) {
      const binary = await sharp(display).threshold(threshold).png().toBuffer();
      const inverted = await sharp(binary).negate().png().toBuffer();
      const padded = await sharp(inverted).extend({top:25,bottom:25,left:25,right:25,background:'white'}).png().toBuffer();
      const {data} = await worker.recognize(padded);
      const value = data.text.trim();
      if (/^\d{1,2}\.\d$/.test(value) && data.confidence>=50) readings.push(value);
    }
    return {tagVerified:true,bottomFeet:readings.length>=2&&new Set(readings).size===1?Number(readings[0]):null};
  } finally { await worker.terminate(); }
}

export function photoEvidence({body,gauge,imageDigest,bank=dwyerBank}) {
  const identified = /^\s*dwyer(?:\s*[-:]|\s*$|\s+(?:hauled|pulled|took)\b)/im.test(body) || gauge?.tagVerified === true;
  const issues = ['Compare the photo with any separate text report for this haul'];
  if (!identified) issues.push('Confirm the well. The caption and gauge tags did not identify Dwyer');
  const bottom = identified ? gauge?.bottomFeet ?? null : null;
  if (bottom === null) issues.push('WTR 3 (LT-5103) bottom level needs verification');
  // Only accept an explicit completed haul statement. A standalone capacity,
  // planned load, or number next to the gauge is insufficient.
  const quantities = [...body.matchAll(/^\s*(?:dwyer\s*[-:]?\s*)?(?:i\s+)?(?:hauled|pulled|took)\s+(\d+(?:\.\d+)?)\s*(?:bbls?|barrels?)\.?\s*$/gim)];
  const quantity = Number(quantities[0]?.[1]);
  const confirmedBarrels = identified && quantities.length===1 && Number.isFinite(quantity) && quantity>0
    && (bank.maxHaulBarrels==null || quantity<=bank.maxHaulBarrels) ? quantity : null;
  if (confirmedBarrels===null) issues.push('Confirm actual barrels hauled. The configured default is not a reported haul');
  const bblPerFoot = bank.activeTanks*bank.bblPerFootPerTank;
  const estimatedTopFeet = bottom!==null && confirmedBarrels!==null && Number.isFinite(bblPerFoot) && bblPerFoot>0
    ? bottom+confirmedBarrels/bblPerFoot : null;
  const starts = [...body.matchAll(/^\s*(?:start(?:ed)?(?:\s+at)?|top)\s*:?\s*(\d+(?:\.\d+)?)\s*(?:ft|feet)\.?\s*$/gim)];
  const driverReportedStart = identified && starts.length===1 ? {feet:Number(starts[0][1]),source:'caption'} : null;
  return {
    wellName:identified?'Dwyer':'Well needs review',
    bottomLevelFeet:bottom,tankLevelFeet:estimatedTopFeet,bblsTaken:confirmedBarrels,issues,
    photo:{imageDigest,tagVerified:!!gauge?.tagVerified,
      observedBottom:bottom===null?null:{feet:bottom,source:'ocr',gauge:'WTR 3 / LT-5103'},
      estimatedTop:estimatedTopFeet===null?null:{feet:estimatedTopFeet,source:'bottom_plus_confirmed_haul',bblPerFoot},
      confirmedBarrels,configuredDefaultBarrels:bank.defaultBarrels,driverReportedStart,bank},
  };
}

export class DwyerPhotoIntake {
  pending = new Map();
  tail = Promise.resolve();
  constructor(queue,recognize=readDwyerGauge) {
    this.queue=queue;
    this.recognize=recognize;
    queue.data.dwyerPhotoStartedAt ??= Date.now();
  }
  receive(message,download) {
    if (!Number.isFinite(message.timestamp) || message.timestamp*1000 < this.queue.data.dwyerPhotoStartedAt) return;
    const key = hash(message.channel+'\0'+message.id);
    const previous = this.queue.data.messages[key];
    if (this.pending.has(key) || previous?.deleted ||
        (previous?.photoOnly && !previous.photoPending && previous.body===message.body)) return;
    const post = {...message,chat:header(message.timestamp*1000,message.author,message.body)};
    const pendingEvidence = photoEvidence({body:message.body});
    pendingEvidence.issues.push('Photo processing pending');
    this.queue.ingest({...post,photoEvidence:pendingEvidence,photoPending:true});
    const job = this.tail.then(()=>this.capture(post,download)).finally(()=>this.pending.delete(key));
    this.tail=job.catch(()=>{});
    this.pending.set(key,job);
    return job;
  }
  async capture(message,download) {
    let gauge,imageDigest;
    try {
      let timer;
      const media = await Promise.race([
        Promise.resolve().then(download),
        new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Photo download timed out')),15000);timer.unref();}),
      ]).finally(()=>clearTimeout(timer));
      if (!media?.mimetype?.startsWith('image/') || !media.data ||
          media.data.length > Math.ceil(maxImageBytes*4/3)) throw Error('Image unavailable');
      const image = Buffer.from(media.data,'base64');
      imageDigest = hash(image);
      gauge = await this.recognize(image);
    } catch {
      // Even when WhatsApp has expired the media or OCR fails, preserve the
      // candidate for a reviewer who can look up the original post.
    }
    const evidence = photoEvidence({body:message.body,gauge,imageDigest});
    const key = hash(message.channel+'\0'+message.id);
    if (this.queue.data.messages[key]?.deleted) return;
    const possibleDuplicate = Object.values(this.queue.data.messages).find(post=>
      post.key!==key && post.channel===message.channel && !post.deleted &&
      ((imageDigest && post.rows.some(row=>row.photo?.imageDigest===imageDigest)) ||
       (message.senderId && post.senderId===message.senderId &&
        Math.abs(Date.parse(post.postedAt)-message.timestamp*1000)<=90000 &&
        post.rows.some(row=>row.wellName==='Dwyer'))));
    if (possibleDuplicate) evidence.issues.push('Possible duplicate Dwyer report in this group');
    this.queue.ingest({...message,photoEvidence:evidence});
  }
}
