import {createRequire} from 'node:module';
import path from 'node:path';
import {hash,header} from './core.mjs';

// Effective Dwyer configuration verified for this intake. Review-only estimates
// retain the snapshot so they can be checked against the configuration at haul time.
export const dwyerBank = {activeTanks:4,bblPerFootPerTank:25.5,defaultBarrels:140,maxHaulBarrels:140};
const maxImageBytes = 12 * 1024 * 1024;
const require = createRequire(import.meta.url);
export const isTallgrassChannel = channel => /\btallgrass\b/i.test(channel.name || '');

// Puppeteer serializes this function into the already connected receiver page.
// Synced group posts may have a bare ID that whatsapp-web.js cannot resolve.
export async function downloadDwyerChatImage({channel,id,maxBytes}) {
  const {Chat}=window.require('WAWebCollections');
  const chat=Chat.get(channel)||Chat.getModelsArray().find(group=>group.id?._serialized===channel);
  const matches=chat?.msgs?.getModelsArray().filter(message=>message.type==='image' &&
    (message.id?._serialized===id || message.id?.id===id));
  if (matches?.length!==1) return;
  const [message]=matches;
  const mimetype=message.mimetype;
  if (!mimetype?.startsWith('image/') || !message.directPath || !message.mediaKey ||
      message.size>maxBytes || message.mediaData?.mediaStage==='REUPLOADING') return;
  const downloadQpl={addAnnotations(){return this;},addPoint(){return this;}};
  const bytes=await window.require('WAWebDownloadManager').downloadManager.downloadAndMaybeDecrypt({
    directPath:message.directPath,encFilehash:message.encFilehash,filehash:message.filehash,
    mediaKey:message.mediaKey,mediaKeyTimestamp:message.mediaKeyTimestamp,
    type:message.type,mimetype,signal:AbortSignal.timeout(10000),downloadQpl,
  });
  if (!bytes?.byteLength || bytes.byteLength>maxBytes) return;
  const image=new Uint8Array(bytes);
  let binary='';
  for (let offset=0;offset<image.length;offset+=8192) {
    binary+=String.fromCharCode(...image.subarray(offset,offset+8192));
  }
  return {mimetype,data:btoa(binary)};
}

export async function downloadDwyerMedia(client,channel,id,downloadLegacy) {
  const media=await client.pupPage.evaluate(downloadDwyerChatImage,{channel,id,maxBytes:maxImageBytes})
    .catch(()=>undefined);
  return media?.data ? media : downloadLegacy?.();
}

// Each region is relative to the verified Tallgrass panel crop. Check the
// panel's tags before using these regions. Other layouts go to review.
const tags = [
  ['LT5101',[.27,0,.18,.045],175],
  ['LT5102',[.53,0,.18,.047],150],
  ['LT5104',[.29,.445,.17,.035],215],
  ['WTR3',[.55,.482,.15,.024],135],
];
const wtr3Value = [502/900,1155/1600,84/900,50/1600];

// Tank graphics give us candidate search boxes at any position in the frame.
// Only the LT-5103 tag identifies WTR 3. Other tanks can be outside the photo.
async function locateWaterTankCandidates(input) {
  const {data,info:{width,height}} = await input.clone().resize({width:450,height:900,fit:'inside'})
    .removeAlpha().toColourspace('srgb').raw().toBuffer({resolveWithObject:true});
  const seen = new Uint8Array(width*height);
  const blue = i => data[i*3+2]>105 && data[i*3+2]>data[i*3]+50 && data[i*3+2]>data[i*3+1]+35;
  const tanks = [];
  for (let i=0;i<seen.length;i++) {
    if (seen[i] || !blue(i)) continue;
    const pending = [i];
    seen[i]=1;
    let left=width,right=0,top=height,bottom=0,count=0;
    while (pending.length) {
      const index=pending.pop(), x=index%width, y=Math.floor(index/width);
      left=Math.min(left,x); right=Math.max(right,x);
      top=Math.min(top,y); bottom=Math.max(bottom,y); count++;
      for (const next of [x>0?index-1:-1,x+1<width?index+1:-1,index-width,index+width]) {
        if (next<0 || next>=seen.length || seen[next] || !blue(next)) continue;
        seen[next]=1;
        pending.push(next);
      }
    }
    const span=right-left+1, depth=bottom-top+1;
    if (span>=width*.06 && span<=width*.85 && depth>=4 && count>=span*depth*.63)
      tanks.push({left,bottom:bottom+1,span});
  }
  return {tanks,width,height};
}

async function readLocatedGauge(input, width, height, worker, sharp) {
  const located=await locateWaterTankCandidates(input);
  if (!located.tanks.length || located.tanks.length>12) return {tagVerified:false,bottomFeet:null};
  const scaleX=width/located.width, scaleY=height/located.height;
  function cropBounds({left,bottom,span},dx,dy,w,h) {
    const rect={left:Math.round((left+dx*span)*scaleX),top:Math.round((bottom+dy*span)*scaleY),
      width:Math.round(w*span*scaleX),height:Math.round(h*span*scaleY)};
    if (rect.left<0 || rect.top<0 || rect.left+rect.width>width || rect.top+rect.height>height) return null;
    return rect;
  }
  async function crop(tank,dx,dy,w,h) {
    const rect=cropBounds(tank,dx,dy,w,h);
    if (!rect) return null;
    // Shrink first to suppress the fine monitor pattern in the photos.
    const reduced=await input.clone().extract(rect).resize({width:75}).greyscale().png().toBuffer();
    return sharp(reduced).resize({width:350}).median(3).normalise().png().toBuffer();
  }
  async function recognize(buf, threshold) {
    const binary=await sharp(buf).threshold(threshold).png().toBuffer();
    const inverted=await sharp(binary).negate().png().toBuffer();
    const padded=await sharp(inverted).extend({top:24,bottom:24,left:24,right:24,background:'white'}).png().toBuffer();
    return (await worker.recognize(padded)).data;
  }
  await worker.setParameters({tessedit_char_whitelist:'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-'});
  async function matchesTag(tank) {
    let matchingCrops=0;
    for (const offset of [-2.39,-2.32,-2.25]) {
      let exact=false;
      const tag=await crop(tank,-.05,offset,.9,.29);
      if (!tag) continue;
      for (const threshold of [115,145,175]) {
        const {text,confidence}=await recognize(tag,threshold);
        if (text.replace(/[^A-Z0-9]/g,'')!=='LT5103') continue;
        if (confidence>=50) return true;
        exact=true;
      }
      if (exact && ++matchingCrops>=2) return true;
    }
    return false;
  }
  let target=null;
  for (const tank of located.tanks) {
    if (!await matchesTag(tank)) continue;
    if (target) return {tagVerified:false,bottomFeet:null};
    target=tank;
  }
  if (!target) return {tagVerified:false,bottomFeet:null};
  await worker.setParameters({tessedit_char_whitelist:'0123456789.'});
  const readings=new Set();
  let ordinaryCrops=0;
  for (const cropWidth of [.76,.83]) {
    const display=await crop(target,.03,.82,cropWidth,.42);
    if (!display) continue;
    const values=new Set();
    for (const threshold of [140,150,160]) {
      const {text,confidence}=await recognize(display,threshold);
      const value=text.trim();
      if (/^\d{1,2}\.\d$/.test(value) && confidence>=48) values.add(value);
    }
    if (values.size===1) ordinaryCrops++;
    for (const value of values) readings.add(value);
  }
  if (readings.size>1) return {tagVerified:true,bottomFeet:null};
  if (ordinaryCrops===2) return {tagVerified:true,bottomFeet:Number([...readings][0])};

  // Faint monitor digits can disappear under a single global threshold.
  // Subtract the nearby background and require agreement across cutoffs.
  let repeatable=false;
  const displayCrops=[
    {rect:cropBounds(target,.12,.84,.64,.38),favorYellow:true},
    {rect:cropBounds(target,.13,.88,.58,.32),favorYellow:false},
  ];
  for (const {rect,favorYellow} of displayCrops) {
    if (!rect) continue;
    const {data,info}=await input.clone().extract(rect).removeAlpha().toColourspace('srgb')
      .raw().toBuffer({resolveWithObject:true});
    const raw={width:info.width,height:info.height,channels:1};
    const signal=Buffer.alloc(raw.width*raw.height);
    for (let i=0;i<signal.length;i++) {
      const r=data[i*3],g=data[i*3+1],b=data[i*3+2];
      signal[i]=Math.round(favorYellow?(r+g)/2:(r+2*g+b)/4);
    }
    const smooth=sharp(signal,{raw}).greyscale().blur(.85).raw();
    const [detail,background]=await Promise.all([smooth.clone().toBuffer(),smooth.clone().blur(5).toBuffer()]);
    let votes=0;
    for (const cutoff of [4,6,8]) {
      const binary=Buffer.from(detail.map((pixel,i)=>pixel-background[i]>=cutoff?0:255));
      const padded=await sharp(binary,{raw}).resize({width:320})
        .extend({top:24,bottom:24,left:24,right:24,background:'white'}).png().toBuffer();
      const {data:{text,confidence}}=await worker.recognize(padded);
      const value=text.trim();
      if (/^\d{1,2}\.\d$/.test(value) && confidence>=58) {
        readings.add(value);
        votes++;
      }
    }
    repeatable ||= votes>=2;
  }
  if (repeatable && readings.size===1) return {tagVerified:true,bottomFeet:Number([...readings][0])};
  // The display's faint strokes can sit on a brightness gradient. Normalize
  // each scan line and strengthen existing pixels around the decimal point.
  const faintReadings = [];
  for (const rect of [cropBounds(target,.154,.754,.546,.331),cropBounds(target,.192,.777,.477,.277)]) {
    if (!rect || rect.width<25 || rect.height<15) break;
    const {width,height}=rect;
    const raw={width,height,channels:1};
    const pixels=await input.clone().extract(rect).blur(1).toColourspace('b-w').raw().toBuffer();
    const signal=Buffer.alloc(pixels.length);
    for (let y=0;y<height;y++) {
      const start=y*width;
      const row=pixels.subarray(start,start+width);
      const baseline=Buffer.from(row).sort()[Math.floor(width*.23)];
      for (let x=0;x<width;x++) signal[start+x]=Math.max(0,row[x]-baseline);
    }
    const votes=new Map();
    for (const threshold of [8,12,14]) {
      const enhanced=Buffer.from(signal);
      const decimalRight=Math.floor(width*.60);
      for (let y=Math.floor(height*.59);y<Math.floor(height*.84);y++) {
        for (let x=Math.floor(width*.45);x<decimalRight;x++) {
          if (signal[y*width+x]<threshold) continue;
          for (let dy=-2;dy<=2;dy++) {
            for (let dx=-2;dx<=2;dx++) {
              if (x+dx<decimalRight) enhanced[(y+dy)*width+x+dx]=255;
            }
          }
        }
      }
      const binary=await sharp(enhanced,{raw}).threshold(threshold).negate().png().toBuffer();
      const padded=await sharp(binary).resize({width:300})
        .extend({top:25,bottom:25,left:25,right:25,background:'white'}).png().toBuffer();
      const {data:{text,confidence}}=await worker.recognize(padded);
      const value=text.trim();
      if (/^\d{1,2}\.\d$/.test(value) && confidence>=58) votes.set(value,(votes.get(value)||0)+1);
    }
    if (votes.size!==1) break;
    const [[value,count]]=votes;
    if (count<2) break;
    faintReadings.push(value);
  }
  const agreed=faintReadings.length===2 && faintReadings[0]===faintReadings[1];
  return {tagVerified:true,bottomFeet:agreed && (!readings.size || readings.has(faintReadings[0]))?Number(faintReadings[0]):null};
}

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
      if (label !== tag) return await readLocatedGauge(input,width,height,worker,sharp);
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
    if (readings.length>=2 && new Set(readings).size===1)
      return {tagVerified:true,bottomFeet:Number(readings[0])};
    return await readLocatedGauge(input,width,height,worker,sharp);
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
  const mentioned = [...body.matchAll(/\b(\d+(?:\.\d+)?)\s*(?:bbls?|barrels?)\b/gi)];
  const bareQuantities = [...body.matchAll(/^\s*(\d{3}(?:\.\d+)?)\s*$/gm)];
  const conflicting = quantities.length>1 || [...mentioned,...bareQuantities].some(match=>Number(match[1])!==bank.defaultBarrels);
  const confirmedBarrels = identified && !conflicting && quantities.length===1 && Number.isFinite(quantity) && quantity>0
    && (bank.maxHaulBarrels==null || quantity<=bank.maxHaulBarrels) ? quantity : null;
  const standardBarrels = identified && !conflicting && confirmedBarrels===null &&
    (bank.maxHaulBarrels==null || bank.defaultBarrels<=bank.maxHaulBarrels) ? bank.defaultBarrels : null;
  const selectedBarrels = confirmedBarrels??standardBarrels;
  if (selectedBarrels===null) issues.push('Resolve conflicting haul evidence or confirm the Dwyer report');
  if (Number.isFinite(quantity) && quantity>bank.maxHaulBarrels)
    issues.push('Reported quantity exceeds the '+bank.maxHaulBarrels+' bbl Tallgrass cap');
  const bblPerFoot = bank.activeTanks*bank.bblPerFootPerTank;
  const estimatedTopFeet = bottom!==null && selectedBarrels!==null && Number.isFinite(bblPerFoot) && bblPerFoot>0
    ? bottom+selectedBarrels/bblPerFoot : null;
  const starts = [...body.matchAll(/^\s*(?:start(?:ed)?(?:\s+at)?|top)\s*:?\s*(\d+(?:\.\d+)?)\s*(?:ft|feet)\.?\s*$/gim)];
  const driverReportedStart = identified && starts.length===1 ? {feet:Number(starts[0][1]),source:'caption'} : null;
  return {
    wellName:identified?'Dwyer':'Well needs review',
    bottomLevelFeet:bottom,tankLevelFeet:estimatedTopFeet,bblsTaken:selectedBarrels,issues,
    photo:{imageDigest,tagVerified:!!gauge?.tagVerified,
      observedBottom:bottom===null?null:{feet:bottom,source:'ocr',gauge:'WTR 3 / LT-5103'},
      estimatedTop:estimatedTopFeet===null?null:{feet:estimatedTopFeet,source:standardBarrels===null?'bottom_plus_confirmed_haul':'bottom_plus_standard_haul',bblPerFoot},
      confirmedBarrels,standardBarrels,configuredDefaultBarrels:bank.defaultBarrels,driverReportedStart,bank},
  };
}

export class DwyerPhotoIntake {
  pending = new Map();
  tail = Promise.resolve();
  constructor(queue,recognize=readDwyerGauge) {
    this.queue=queue;
    this.recognize=recognize;
    queue.data.dwyerPhotoStartedAt ??= Date.now();
    queue.data.dwyerDeliveryStartedAt ??= Date.now();
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
    return this.scheduleCapture(key,post,download);
  }
  retryHeldPhoto(post,expectedBottomFeet,download,reviewImageDigest) {
    const row=post?.rows?.[0];
    const delivery=this.queue.data.deliveries?.[row?.id];
    const timestamp=Date.parse(post?.postedAt)/1000;
    if (!post?.photoOnly || post.deleted || post.edited || post.photoPending ||
        !Number.isFinite(timestamp) || timestamp*1000<this.queue.data.dwyerDeliveryStartedAt ||
        !row?.photo || row.photo.observedBottom || delivery?.status!=='review' || delivery.identity ||
        delivery.review || delivery.reviewDismissal || this.pending.has(post.key)) {
      throw Error('This photo is not an unsent photo reading failure');
    }
    if (!Number.isFinite(expectedBottomFeet) || expectedBottomFeet<0) throw Error('Confirm the visible WTR 3 reading first');
    if (reviewImageDigest!==undefined && (typeof reviewImageDigest!=='string' ||
        !/^[a-f0-9]{64}$/.test(reviewImageDigest))) throw Error('Invalid reviewed photo fingerprint');
    const message={...post,timestamp};
    return this.scheduleCapture(post.key,message,download,{post,row,delivery,expectedBottomFeet,reviewImageDigest});
  }
  scheduleCapture(key,post,download,retry) {
    const job = this.tail.then(()=>this.capture(post,download,retry)).finally(()=>this.pending.delete(key));
    this.tail=job.catch(()=>{});
    this.pending.set(key,job);
    return job;
  }
  async capture(message,download,retry) {
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
    let reviewedBottom=false;
    const key = hash(message.channel+'\0'+message.id);
    if (retry) {
      if (this.queue.data.messages[key]!==retry.post || this.queue.data.deliveries[retry.row.id]!==retry.delivery) {
        throw Error('Photo review changed during retry');
      }
      reviewedBottom=retry.reviewImageDigest!==undefined;
      if (reviewedBottom && imageDigest!==retry.reviewImageDigest) {
        throw Error('Recovered image does not match the reviewed photo');
      }
      if (!imageDigest || !gauge?.tagVerified ||
          (gauge.bottomFeet!==retry.expectedBottomFeet && !(reviewedBottom && gauge.bottomFeet===null))) {
        throw Error('Recovered photo did not verify the expected WTR 3 reading');
      }
      if (retry.row.photo.imageDigest && imageDigest!==retry.row.photo.imageDigest) {
        throw Error('Recovered image does not match the held photo');
      }
    }
    if (this.queue.data.messages[key]?.deleted) return;
    const evidence=photoEvidence({body:message.body,gauge:reviewedBottom
      ? {...gauge,bottomFeet:retry.expectedBottomFeet} : gauge,imageDigest});
    if (reviewedBottom) evidence.photo.observedBottom.source='review';
    const postedAt=message.timestamp*1000;
    const possibleDuplicate = Object.values(this.queue.data.messages).some(post=>{
      if (post.key===key || post.channel!==message.channel || post.deleted) return false;
      const otherTime=Date.parse(post.postedAt);
      const nearSameSender=message.senderId && post.senderId===message.senderId &&
        Math.abs(otherTime-postedAt)<=90000;
      return post.rows.some(row=>{
        if (!(imageDigest && row.photo?.imageDigest===imageDigest) &&
            !(nearSameSender && row.wellName==='Dwyer')) return false;
        if (!retry) return true;
        const delivery=this.queue.data.deliveries?.[row.id];
        if (delivery?.status==='excluded') return false;
        // A later unsent duplicate must not prevent recovery of the first report.
        return !!(delivery?.identity || delivery?.review || delivery?.status==='complete' ||
          row.photo?.autoSend || otherTime<postedAt || (otherTime===postedAt && post.key<key));
      });
    });
    if (possibleDuplicate) evidence.issues.push('Possible duplicate Dwyer report in this group');
    evidence.photo.canSend = !!imageDigest && message.timestamp*1000>=this.queue.data.dwyerDeliveryStartedAt;
    evidence.photo.autoSend = !reviewedBottom && evidence.photo.canSend && !!gauge?.tagVerified &&
      evidence.bottomLevelFeet!==null && evidence.bblsTaken!==null && !possibleDuplicate;
    this.queue.ingest({...message,photoEvidence:evidence});
  }
}
