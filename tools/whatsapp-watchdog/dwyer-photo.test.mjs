import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {Queue,header} from './core.mjs';
import {DwyerPhotoIntake,dwyerBank,isTallgrassChannel,photoEvidence,readDwyerGauge} from './dwyer-photo.mjs';
import {Transport,orderedDeliveryRows} from './transport.mjs';

const gauge = {tagVerified:true,bottomFeet:6.4};
const media = {mimetype:'image/png',data:Buffer.from('synthetic fixture').toString('base64')};

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
  for (const body of ['140 bbl capacity','Did not haul 140 bbl','Hauled 140 bbl\nHauled 120 bbl']) {
    const row = photoEvidence({body,gauge});
    assert.equal(row.photo.configuredDefaultBarrels,140);
    assert.equal(row.bblsTaken,null);
    assert.equal(row.tankLevelFeet,null);
  }
  assert.equal(photoEvidence({body:'Hauled 140 bbl',gauge,bank:{...dwyerBank,maxHaulBarrels:120}}).bblsTaken,null);
});

test('live/history overlap, duplicate media, expiry and restart stay in local review', async t => {
  const directory = mkdtempSync(path.join(tmpdir(),'watchdog-dwyer-test-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const queue = new Queue(directory);
  const intake = new DwyerPhotoIntake(queue,async()=>gauge);
  const message = {id:'test-photo',channel:'test-tallgrass',timestamp:Math.ceil(Date.now()/1000),
    body:'Dwyer\nHauled 140 barrels',author:'Fixture driver',senderId:'fixture'};
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
  assert.deepEqual(orderedDeliveryRows(restored.data.messages),[]);
  assert.equal(restored.export(message.channel),'');
  const transport = new Transport(restored);
  transport.request = ()=>assert.fail('network request');
  await assert.rejects(transport.review(entries[0].row.id,'confirm',null,'test'),/review-only/);
  await transport.review(entries[0].row.id,'exclude',null,'fixture dismissal');
  assert.equal(restored.reviewInbox().length,2);
});

test('private Tallgrass crop reads 6.4 ft', {skip:!process.env.WBC_DWYER_OCR_FIXTURE}, async () => {
  const result = await readDwyerGauge(readFileSync(process.env.WBC_DWYER_OCR_FIXTURE));
  assert.deepEqual(result,gauge);
  const row = photoEvidence({body:'Hauled 140 barrels',gauge:result});
  assert.equal(row.tankLevelFeet.toFixed(2),'7.77');
});
