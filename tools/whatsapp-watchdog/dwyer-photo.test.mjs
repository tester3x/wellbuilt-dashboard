import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';
import {Queue,header} from './core.mjs';
import {DwyerPhotoIntake,downloadDwyerChatImage,downloadDwyerMedia,dwyerBank,isTallgrassChannel,photoEvidence,readDwyerGauge} from './dwyer-photo.mjs';
import {Transport,orderedDeliveryRows} from './transport.mjs';

const gauge = {tagVerified:true,bottomFeet:6.4};
const media = {mimetype:'image/png',data:Buffer.from('synthetic fixture').toString('base64')};

test('synced Dwyer image downloads by exact group and bare ID with its MIME type', async () => {
  const id='short-image-id',channel='tallgrass-test';
  const photo={id:{id},type:'image',mimetype:'image/jpeg',directPath:'test',mediaKey:'test',size:3};
  const messages=[photo];
  let downloadCalls=0;
  const group={id:{_serialized:channel},msgs:{getModelsArray:()=>messages}};
  const download=runInNewContext(`(${downloadDwyerChatImage})`,{
    AbortSignal,
    window:{
      require(name){
        if (name==='WAWebCollections') return {Chat:{get:()=>undefined,getModelsArray:()=>[group]}};
        assert.equal(name,'WAWebDownloadManager');
        return {downloadManager:{async downloadAndMaybeDecrypt(options){
          downloadCalls++;
          assert.equal(options.mimetype,'image/jpeg');
          assert.equal(options.type,'image');
          return Buffer.from('jpg');
        }}};
      },
      WWebJS:{arrayBufferToBase64Async:bytes=>bytes.toString('base64')},
    },
  });
  const client={pupPage:{evaluate:(_fn,args)=>download(args)}};
  const result=await downloadDwyerMedia(client,channel,id,()=>assert.fail('used the serialized-ID fallback'));
  assert.equal(result.mimetype,'image/jpeg');
  assert.equal(result.data,Buffer.from('jpg').toString('base64'));
  assert.equal(await downloadDwyerMedia(client,'other-group',id),undefined);
  messages.push({...photo});
  assert.equal(await downloadDwyerMedia(client,channel,id),undefined);
  assert.equal(downloadCalls,1);
});

test('retry restores only the selected download failure under its original photo identity', async t => {
  const dir=mkdtempSync(path.join(tmpdir(),'watchdog-dwyer-retry-'));
  t.after(()=>{rmSync(path.join(dir,'queue.json'),{force:true});rmdirSync(dir);});
  const queue=new Queue(dir);
  const timestamp=Date.now()/1000;
  queue.data.dwyerPhotoStartedAt=timestamp*1000-1000;
  queue.data.dwyerDeliveryStartedAt=timestamp*1000-1000;
  const intake=new DwyerPhotoIntake(queue,async()=>({...gauge,bottomFeet:7.8}));
  const message={id:'original',channel:'tallgrass',timestamp,body:'',author:'Fixture'};
  await intake.receive(message,()=>undefined);
  await intake.receive({...message,id:'unrelated'},()=>undefined);
  const [held,unrelated]=Object.values(queue.data.messages);
  const rowId=held.rows[0].id;
  const previous=queue.data.deliveries[rowId];
  assert.equal(previous.status,'review');
  await assert.rejects(intake.retryHeldPhoto(held,7.7,()=>media),/expected WTR 3/);
  assert.equal(queue.data.messages[held.key],held);
  assert.equal(queue.data.deliveries[rowId],previous);
  await intake.retryHeldPhoto(held,7.8,()=>media);
  const recovered=queue.data.messages[held.key];
  assert.equal(recovered.rows[0].id,rowId);
  assert.equal(recovered.postedAt,held.postedAt);
  assert.equal(recovered.rows[0].photo.observedBottom.feet,7.8);
  assert.equal(queue.data.deliveries[rowId].status,'retry');
  assert.equal(queue.data.messages[unrelated.key],unrelated);
  assert.equal(queue.data.deliveries[unrelated.rows[0].id].status,'review');
  assert.throws(()=>intake.retryHeldPhoto(recovered,7.8,()=>media),/unsent download failure/);
});

test('Dwyer uses the WTR 3 decimal reading and all four equalizing tanks', () => {
  assert.equal(isTallgrassChannel({name:'Tallgrass Water'}),true);
  assert.equal(isTallgrassChannel({name:'Other Water'}),false);
  const row = photoEvidence({body:'Dwyer\nHauled 140 barrels\nStart: 7.8 ft',gauge});
  assert.equal(row.bottomLevelFeet,6.4);
  assert.equal(row.tankLevelFeet,6.4+140/102);
  assert.equal(row.photo.estimatedTop.bblPerFoot,102);
  assert.deepEqual(row.photo.driverReportedStart,{feet:7.8,source:'caption'});
  assert.equal(row.photo.observedBottom.gauge,'WTR 3 / LT-5103');
});

test('uncertain identification, quantity, and limits do not supply measurements', () => {
  const ambiguous = photoEvidence({body:'Not Dwyer\nHauled 140 bbl'});
  assert.equal(ambiguous.wellName,'Well needs review');
  assert.equal(ambiguous.bblsTaken,null);
  const unreadable = photoEvidence({body:'Dwyer\nHauled 140 bbl'});
  assert.equal(unreadable.wellName,'Dwyer');
  assert.equal(unreadable.bottomLevelFeet,null);
  for (const body of ['130 bbl capacity','Hauled 140 bbl\nHauled 120 bbl']) {
    const row = photoEvidence({body,gauge});
    assert.equal(row.photo.configuredDefaultBarrels,140);
    assert.equal(row.bblsTaken,null);
    assert.equal(row.tankLevelFeet,null);
  }
  assert.equal(photoEvidence({body:'Hauled 140 bbl',gauge,bank:{...dwyerBank,maxHaulBarrels:120}}).bblsTaken,null);
  const overCap = photoEvidence({body:'Hauled 141 bbl',gauge});
  assert.equal(overCap.bblsTaken,null);
  assert.equal(overCap.tankLevelFeet,null);
  assert.ok(overCap.issues.some(issue=>issue.includes('140 bbl Tallgrass cap')));
});

test('live/history overlap, duplicate media, expiry and restart stay in local review', async t => {
  const directory = mkdtempSync(path.join(tmpdir(),'watchdog-dwyer-test-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const queue = new Queue(directory);
  const intake = new DwyerPhotoIntake(queue,async()=>gauge);
  const message = {id:'test-photo',channel:'test-tallgrass',timestamp:Math.ceil(Date.now()/1000),
    body:'Dwyer\n130 bbl',author:'Fixture driver',senderId:'fixture'};
  assert.equal(intake.receive({...message,id:'old',timestamp:message.timestamp-60},()=>media),undefined);
  const captured = intake.receive(message,()=>media);
  assert.equal(queue.reviewInbox()[0].post.photoPending,true);
  assert.equal(intake.receive(message,()=>assert.fail('second download')),undefined);
  await captured;
  queue.ingest({...message,chat:header(message.timestamp*1000,message.author,message.body)});
  queue.reparseChannels({[message.channel]:{}});
  await intake.receive({...message,id:'second-photo'},()=>media);
  await intake.receive({...message,id:'expired',body:''},()=>undefined);
  const restored = new Queue(directory);
  const entries = restored.reviewInbox();
  assert.equal(entries.length,3);
  assert.equal(entries[0].row.bottomLevelFeet,6.4);
  assert.ok(entries[1].row.issues.some(issue=>issue.startsWith('Possible duplicate')));
  assert.equal(entries[2].row.wellName,'Well needs review');
  assert.equal(orderedDeliveryRows(restored.data.messages).length,2);
  assert.equal(restored.export(message.channel),'');
  const transport = new Transport(restored);
  transport.request = ()=>assert.fail('network request');
  await assert.rejects(transport.review(entries[0].row.id,'confirm',null,'test'),/Transport unavailable/);
  await transport.review(entries[0].row.id,'exclude',null,'fixture dismissal');
  assert.equal(restored.reviewInbox().length,2);
});

test('eligible photo sends through signed intake and polls the canonical receipt', async t => {
  const directory=mkdtempSync(path.join(tmpdir(),'watchdog-dwyer-delivery-test-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const queue=new Queue(directory);
  const intake=new DwyerPhotoIntake(queue,async()=>gauge);
  const message={id:'auto',channel:'test-tallgrass',timestamp:Math.ceil(Date.now()/1000),
    body:'Bottom',author:'Fixture driver'};
  await intake.receive(message,()=>media);
  assert.equal(queue.reviewInbox().length,0);
  const transport=new Transport(queue);
  transport.secret='mock-only';transport.config={enabled:true,enabledAt:0};
  transport.lastLifecycleCheck=Date.now();
  const requests=[];
  transport.request=async(endpoint,body)=>{
    requests.push(endpoint);
    if(endpoint==='ingestWatchdogPullV2'){
      assert.deepEqual(body.dwyerPhoto,{imageDigest:queue.data.messages[Object.keys(queue.data.messages)[0]].rows[0].photo.imageDigest,tagVerified:true,bottomFeet:6.4});
      return {status:'queued',identity:'test-identity',packetId:'test-packet'};
    }
    return {status:'complete',identity:'test-identity',packetId:'test-packet'};
  };
  await transport.tick(false);
  await transport.tick(false);
  assert.deepEqual(requests,['ingestWatchdogPullV2','getWatchdogPullReceiptV2']);
});

test('private Tallgrass crop reads 6.4 ft', {skip:!process.env.WBC_DWYER_OCR_FIXTURE}, async () => {
  const result = await readDwyerGauge(readFileSync(process.env.WBC_DWYER_OCR_FIXTURE));
  assert.deepEqual(result,gauge);
  const row = photoEvidence({body:'Hauled 140 barrels',gauge:result});
  assert.equal(row.tankLevelFeet.toFixed(2),'7.77');
});

test('private WTR 3 photo keeps its reading when the other tanks are cropped out', {
  skip:!process.env.WBC_DWYER_ANCHOR_FIXTURE,
}, async () => {
  const {default:sharp}=await import('sharp');
  const image=readFileSync(process.env.WBC_DWYER_ANCHOR_FIXTURE);
  const crop=region=>sharp(image).extract(region).png().toBuffer();
  const tight=await crop({left:225,top:370,width:140,height:388});
  const offset=await sharp(tight).extend({left:210,top:120,right:10,bottom:0,background:'#555'}).png().toBuffer();
  for (const framing of [image,tight,offset]) {
    assert.deepEqual(await readDwyerGauge(framing),{tagVerified:true,bottomFeet:7.8});
  }
  const noTag=await crop({left:225,top:449,width:140,height:309});
  const otherTank=await crop({left:93,top:370,width:138,height:388});
  for (const framing of [noTag,otherTank]) {
    assert.deepEqual(await readDwyerGauge(framing),{tagVerified:false,bottomFeet:null});
  }
});

test('four private photo framings reach the test queue once per run', {skip:!process.env.WBC_DWYER_QUEUE_FIXTURES}, async t => {
  // The manifest is supplied locally so customer images stay out of Git.
  const fixtures=JSON.parse(process.env.WBC_DWYER_QUEUE_FIXTURES);
  assert.equal(fixtures.length,4);
  const testChannel='tallgrass-isolated-test';
  for (let pass=1;pass<=2;pass++) {
    const directory=mkdtempSync(path.join(tmpdir(),'watchdog-dwyer-framing-'));
    t.after(()=>{
      for (const file of ['queue.json','queue.json.tmp']) rmSync(path.join(directory,file),{force:true});
      rmdirSync(directory);
    });
    const queue=new Queue(directory);
    const start=Math.min(...fixtures.map(f=>Date.parse(f.postedAt)));
    assert.ok(Number.isFinite(start));
    queue.data.dwyerPhotoStartedAt=start;
    queue.data.dwyerDeliveryStartedAt=start;
    const intake=new DwyerPhotoIntake(queue);
    const messages=fixtures.map((fixture,index)=>({
      id:'isolated-'+index,channel:testChannel,timestamp:Date.parse(fixture.postedAt)/1000,
      body:'Bottom',author:'Fixture driver',
    }));
    for (const [index,message] of messages.entries()) {
      const image=readFileSync(fixtures[index].path);
      await intake.receive(message,()=>({mimetype:'image/jpeg',data:image.toString('base64')}));
    }
    assert.equal(queue.reviewInbox().length,0);
    const sends=[];
    const received=new Map();
    const transport=new Transport(queue);
    transport.secret='mock-only';
    transport.config={enabled:true,enabledAt:0};
    transport.lastLifecycleCheck=Date.now();
    transport.request=async(endpoint,body)=>{
      if (endpoint==='ingestWatchdogPullV2') {
        assert.equal(body.chatId,testChannel);
        assert.equal(body.dwyerPhoto.tagVerified,true);
        const index=messages.findIndex(m=>m.id===body.messageId);
        assert.equal(body.dwyerPhoto.bottomFeet,fixtures[index].bottomFeet);
        assert.ok(!received.has(body.dwyerPhoto.imageDigest));
        const receipt={status:'complete',identity:body.dwyerPhoto.imageDigest,packetId:body.messageId};
        received.set(receipt.identity,receipt);
        sends.push(body.dwyerPhoto.bottomFeet);
        return {...receipt,status:'queued'};
      }
      assert.equal(endpoint,'getWatchdogPullReceiptV2');
      assert.ok(received.has(body.identity));
      return received.get(body.identity);
    };
    await transport.tick(false);
    assert.deepEqual(sends,fixtures.map(f=>f.bottomFeet));
    assert.equal(Object.values(queue.data.deliveries).filter(d=>d.status==='complete').length,4);
    const restored=new Queue(directory);
    const reopened=new DwyerPhotoIntake(restored);
    for (const message of messages) {
      assert.equal(reopened.receive(message,()=>assert.fail('duplicate download')),undefined);
    }
    transport.queue=restored;
    await transport.tick(false);
    assert.equal(sends.length,4);
    t.diagnostic('Test queue pass '+pass+': four completed receipts, zero duplicate sends');
  }
});
