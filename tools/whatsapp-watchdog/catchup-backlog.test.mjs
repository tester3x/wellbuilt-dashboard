import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {Queue, header} from './core.mjs';
import {Transport} from './transport.mjs';

const require = createRequire(import.meta.url);
const {evaluateIncomingPull} = require('../../functions/lib/packetGuards.js');
const {digest} = require('../../functions/lib/imports/pullImportModel.js');

// Isolated durable server adapter: no Firebase credentials or network calls.
// The real parser, queue, transport, observation identity and stale guard run.
class TestServer {
 constructor(file, failure) {
  this.file = file;
  try { this.data = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) {
   if (error.code !== 'ENOENT') throw error;
   this.data = {entries:{}, accepted:[], committed:[], rejected:[], faultUsed:false};
  }
  this.failure = failure;
 }
 save() { writeFileSync(this.file, JSON.stringify(this.data)); }
 fail(point) {
  if (this.failure !== point || this.data.faultUsed) return;
  this.data.faultUsed = true; this.save(); throw Error('simulated lost connection: '+point);
 }
 async request(endpoint, body, queue) {
  if (endpoint === 'ingestWatchdogPullV2') {
   this.fail('before-intake');
   const message = Object.values(queue.data.messages).find(m => m.id === body.messageId);
   const row = message.rows[body.rowIndex];
   const identity = digest([row.wellName,row.dateTimeUTC,row.tankLevelFeet,row.bottomLevelFeet,row.bblsTaken]);
   if (!this.data.entries[identity]) {
    // A subsequent load must never be submitted before its predecessor commits.
    assert.equal(Object.values(this.data.entries).filter(e => e.status !== 'complete').length, 0);
    this.data.entries[identity] = {identity,packetId:identity,row,status:'queued'};
    this.data.accepted.push(row.dateTimeUTC); this.save();
   }
   this.fail('after-intake');
   return this.receipt(identity);
  }
  assert.equal(endpoint, 'getWatchdogPullReceiptV2');
  const entry = this.data.entries[body.identity]; assert.ok(entry);
  this.fail(entry.status === 'complete' ? 'after-commit' : 'before-commit');
  return this.receipt(body.identity);
 }
 receipt(identity) {
  const {status,packetId} = this.data.entries[identity];
  return {ok:true,identity,packetId,status};
 }
 commit() {
  const pending = Object.values(this.data.entries).filter(e => e.status !== 'complete');
  assert.ok(pending.length <= 1);
  for (const entry of pending) {
   const verdict = evaluateIncomingPull({incomingDateTimeUTC:entry.row.dateTimeUTC,
    hasOutgoingResponse:!!this.data.watermark,watermarkDateTimeUTC:this.data.watermark,nowMs:Date.now()});
   if (verdict.action !== 'process') this.data.rejected.push(verdict.reason);
   assert.equal(verdict.action, 'process', JSON.stringify(verdict));
   this.data.watermark = entry.row.dateTimeUTC;
   this.data.committed.push(entry.row.dateTimeUTC); entry.status = 'complete';
  }
  this.save();
 }
}

for (const order of [[4,3,2,1,0],[2,4,0,3,1],[0,1,2,3,4]]) {
 for (const failure of ['none','before-intake','after-intake','before-commit','after-commit']) {
  test(`five-load catch-up ${order.join('')} / ${failure}: ordered, durable, exactly once`, async () => {
   const directory = mkdtempSync(path.join(os.tmpdir(),'watchdog-backlog-'));
   try {
    const base = Date.now()-86400000;
    const messages = Array.from({length:5}, (_,i) => ({id:'test-'+i,channel:'isolated-test',
     chat:header(base+i*3600000,'Test Driver',`Kahuna 5\nTop 12' 0"\nBottom 10' 0"\n${140+i} bbl`)}));
    let queue = new Queue(directory);
    for (const i of order) {
     assert.equal(queue.ingest(messages[i]).rows, 1);
     assert.equal(queue.ingest(messages[i]).duplicate, true);
    }
    const expected = Object.values(queue.data.messages).flatMap(m=>m.rows).map(r=>r.dateTimeUTC).sort();
    assert.equal(new Set(expected).size, 5);
    let server, transport;
    const restart = () => {
     queue = new Queue(directory);
     server = new TestServer(path.join(directory,'server.json'),failure);
     transport = new Transport(queue); transport.secret='synthetic-test-only';
     transport.config={enabled:true,enabledAt:0}; transport.lastLifecycleCheck=Date.now();
     transport.request=(endpoint,body)=>server.request(endpoint,body,queue);
    };
    restart();
    for (let cycle=0; cycle<18; cycle++) {
     await transport.tick(false);
     // Restart both sides while the accepted load is still awaiting processing.
     restart();
     await transport.tick(false);
     const saved = new Queue(directory);
     for (const entry of Object.values(server.data.entries)) {
      if (entry.status !== 'complete') {
       assert.equal(Object.values(saved.data.deliveries||{}).some(d=>d.identity===entry.identity&&d.status==='complete'),false);
      }
     }
     server.commit();
     restart(); // Also lose volatile receipt timers after server commit.
    }
    assert.deepEqual(server.data.accepted,expected);
    assert.deepEqual(server.data.committed,expected);
    assert.deepEqual(server.data.rejected,[]);
    assert.equal(Object.values(queue.data.deliveries).filter(d=>d.status==='complete').length,5);
    // Receiver replay after reboot must not create a sixth load or stale error.
    for (const message of [...messages].reverse()) assert.equal(queue.ingest(message).duplicate,true);
    restart(); await transport.tick(false);
    assert.deepEqual(server.data.committed,expected);
    assert.equal(Object.keys(server.data.entries).length,5);
    assert.equal(queue.reviewInbox().length,0);
    if (failure !== 'none') assert.equal(server.data.faultUsed,true);
   } finally { rmSync(directory,{recursive:true,force:true}); }
  });
 }
}

test('stale-guard negative control rejects a reversed backlog', () => {
 const nowMs=Date.now();
 assert.equal(evaluateIncomingPull({incomingDateTimeUTC:new Date(nowMs-7200000).toISOString(),
  hasOutgoingResponse:true,watermarkDateTimeUTC:new Date(nowMs-3600000).toISOString(),nowMs}).reason,'STALE_PULL_TIME');
});
