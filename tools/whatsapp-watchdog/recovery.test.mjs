import test from 'node:test';
import assert from 'node:assert/strict';
import {ReceiverRecovery} from './recovery.mjs';
import {collectReceiver} from './receiver-history.mjs';

test('restart, Wi-Fi outage and stale receiver recover with bounded retries; manual stop and QR are respected', async () => {
  let now=1000000, connected=true, calls=0, state={connect:true,state:'Stopped'};
  const r=new ReceiverRecovery({snapshot:()=>state,online:async()=>connected,now:()=>now,restart:async()=>calls++});
  await r.tick(); assert.equal(calls,1);
  await r.tick(); assert.equal(calls,1);
  now+=16000; connected=false; await r.tick(); assert.equal(calls,1);
  now+=31000; connected=true; await r.tick(); assert.equal(calls,2);
  state={connect:false,state:'Stopped'};now+=400000;await r.tick();assert.equal(calls,2);
  for(const name of ['Scan QR','Authentication failed']){state={connect:true,state:name};now+=400000;await r.tick();assert.equal(calls,2);}
  state={connect:true,state:'Connected',lastReceiverCheck:new Date(now).toISOString()};await r.tick();assert.equal(calls,2);
  now+=181000;await r.tick();assert.equal(calls,3);
});

test('overlapping health checks cannot launch duplicate browsers', async () => {
  let release, calls=0;
  const r=new ReceiverRecovery({snapshot:()=>({connect:true,state:'Disconnected'}),online:()=>new Promise(resolve=>release=resolve),restart:async()=>calls++});
  const first=r.tick();await r.tick();release(true);await first;assert.equal(calls,1);
});

function fixture(pages) {
  const msg=t=>({id:{_serialized:'m'+t,remote:{_serialized:'group'}},t,body:'test'});
  const loaded=[msg(1999)];let calls=0;
  const chat={id:{server:'g.us',_serialized:'group'},msgs:{getModelsArray:()=>loaded}};
  globalThis.window={AuthStore:{AppState:{state:'CONNECTED'}},require(name){
    if(name==='WAWebCollections')return {Chat:{getModelsArray:()=>[chat]},Msg:{getModelsArray:()=>[],on(){}}};
    return {async loadEarlierMsgs(){calls++;const page=pages.shift();if(page instanceof Error)throw page;const next=(page||[]).map(msg);loaded.push(...next);return next;}};
  }};
  return {get calls(){return calls;}};
}

test('catch-up pages past 100 messages to durable checkpoint, then repeats after a connection gap', async () => {
  const f=fixture([Array.from({length:150},(_,i)=>1900-i),[1300]]);
  try {
    const result=await collectReceiver({ids:['group'],checkpoints:{group:1950},now:2000});
    assert.equal(f.calls,2);assert.equal(result.messages.length,151);assert.equal(result.covered.group,2000);
    window.__wellBuiltHistory.group=1900;
    await collectReceiver({ids:['group'],checkpoints:{group:2000},now:2100});
    assert.equal(window.__wellBuiltHistory.group,2100);
  } finally {delete globalThis.window;}
});

test('missing group and failed history never return an advanced checkpoint', async () => {
  fixture([new Error('offline')]);
  try {
    await assert.rejects(collectReceiver({ids:['group','missing'],checkpoints:{},now:2000}),/groups to sync/);
    await assert.rejects(collectReceiver({ids:['group'],checkpoints:{group:1950},now:2000}),/offline/);
    assert.equal(window.__wellBuiltHistory.group,undefined);
  } finally {delete globalThis.window;}
});
import {finishSyncedLogin} from './receiver-ready.mjs';
test('already-synced login finishes the SDK callback once, while unpaired sessions never do',async()=>{
 let calls=0;globalThis.window={AuthStore:{AppState:{state:'UNPAIRED'}},require:()=>({Socket:{state:'CONNECTED',hasSynced:true}}),onAppStateHasSyncedEvent:async()=>calls++};
 try{assert.equal(await finishSyncedLogin(),false);window.AuthStore.AppState.state='CONNECTED';assert.equal(await finishSyncedLogin(),true);assert.equal(await finishSyncedLogin(),false);assert.equal(calls,1);}finally{delete globalThis.window;}
});
