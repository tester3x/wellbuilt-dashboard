import fs from 'node:fs';import {combinedPullTimes} from './combined-times.mjs';import assert from 'node:assert/strict';
const issue='Multiple wells in one message; confirm individual pull times';
const rows=[{id:'first',wellName:'A',dateTimeUTC:'2026-10-19T19:00:00.000Z',issues:[issue]},{id:'last',wellName:'B',dateTimeUTC:'2026-10-19T19:00:00.000Z',issues:[issue]}];const message={senderId:'s',channel:'c',postedAt:rows[0].dateTimeUTC,rows};const data={messages:{},deliveries:{}};
for(let i=0;i<5;i++){const id='old'+i;data.messages[id]={senderId:'s',channel:'c',rows:[{id,dateTimeUTC:new Date(Date.parse('2026-10-19T10:00:00Z')+i*3600000).toISOString()}]};data.deliveries[id]={status:'complete'};}
const result=combinedPullTimes(message,data);assert.equal(result[0].dateTimeUTC,'2026-10-19T18:00:00.000Z');assert.equal(result[0].timeEstimate.intervalMinutes,60);assert.equal(result[1].timeEstimate,undefined);assert.equal(result[1].dateTimeUTC,message.postedAt);
assert.equal(combinedPullTimes({...message,senderId:'other'},data),null);assert.equal(combinedPullTimes({...message,rows:[rows[0],{...rows[1],wellName:''}]},data),null);
const midnight=structuredClone(data);for(const p of Object.values(midnight.messages))for(const r of p.rows)r.dateTimeUTC=new Date(Date.parse(r.dateTimeUTC)-14*3600000).toISOString();assert.ok(combinedPullTimes({...message,postedAt:'2026-10-19T05:00:00.000Z',rows:rows.map(r=>({...r,dateTimeUTC:'2026-10-19T05:00:00.000Z'}))},midnight));
console.log('Combined-time tests passed: same sender/channel, averaged intervals, unknown well hold, last post time, and midnight continuity.');

// A driver may report two successive pulls from the SAME well in one post.
// Preserve distinct row identities and input order; only earlier time is estimated.
const sameWell={...message,rows:rows.map((r,i)=>({...r,wellName:'Same Well',tankLevelFeet:i?9.75:12,bottomLevelFeet:i?7.25:9.5}))};
const same=combinedPullTimes(sameWell,data);assert.equal(same.length,2);
assert.deepEqual(same.map(r=>r.id),['first','last']);assert.equal(same[0].dateTimeUTC,'2026-10-19T18:00:00.000Z');
assert.equal(same[1].dateTimeUTC,message.postedAt);assert.deepEqual(same.map(r=>[r.tankLevelFeet,r.bottomLevelFeet]),[[12,9.5],[9.75,7.25]]);
assert.equal(same[0].timeEstimate.status,'estimated');assert.equal(same[1].timeEstimate,undefined);
