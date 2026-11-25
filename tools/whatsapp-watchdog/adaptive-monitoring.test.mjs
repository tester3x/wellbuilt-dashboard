import test from 'node:test';import assert from 'node:assert/strict';import {learnChannelActivity,AdaptiveMonitoring}from './adaptive-monitoring.mjs';
const post=(id,at,well='Gunslinger 3',channel='g')=>({id,channel,postedAt:at,rows:[{wellName:well}]});
test('learns quiet daytime from local overnight history, then an unexpected daytime post wakes it',()=>{
 const messages={};for(let day=20;day<=22;day++)for(const hour of ['01','03','05','19','21','23']){const id=day+hour;messages[id]=post(id,`2026-11-${day}T${hour}:00:00-06:00`);}
 const now=Date.parse('2026-11-23T12:00:00-06:00');let plan=learnChannelActivity(messages,{},now);assert.equal(plan.quiet,true);assert.equal(plan.channels[0].reason,'historically_quiet_hour');
 messages.surprise=post('surprise',new Date(now).toISOString());plan=learnChannelActivity(messages,{},now);assert.equal(plan.quiet,false,'unexpected daytime load must not wait for a learned schedule');
});
test('manual Gabriel pause does not silence Thor in the same channel or change any records',()=>{
 const now=Date.now(),messages={g:post('g',new Date(now).toISOString(),'Gabriel 1'),t:post('t',new Date(now).toISOString(),'Thor 1')},original=JSON.stringify(messages);
 const m=new AdaptiveMonitoring({data:{messages}},{enabled:true,pausedWells:['Gabriel 1']},['g']);assert.equal(m.isPaused('Gabriel 1'),true);assert.equal(m.isPaused('Thor 1'),false);assert.equal(m.plan().quiet,false);assert.equal(JSON.stringify(messages),original);
});
test('short history uses bounded idle backoff, not a guessed permanent schedule; disabled stays compatible',()=>{
 const q={data:{messages:{one:post('one',new Date(Date.now()-12*3600000).toISOString())}}};const m=new AdaptiveMonitoring(q,{enabled:true});assert.equal(m.interval(300000,1800000),1800000);assert.equal(new AdaptiveMonitoring(q,{}).interval(300000,1800000),300000);
});
import {Transport} from './transport.mjs';
test('paused wells cannot send, and resuming does not replay reports captured during the pause',async()=>{
 const now=new Date().toISOString(),row={id:'gab',wellName:'Gabriel 1',postedAt:now,dateTimeUTC:now,issues:[]},q={data:{messages:{m:{id:'m',channel:'g',rows:[row],notices:[]}},deliveries:{}},save(){},reparseChannels(){}};
 const t=new Transport(q);t.config={enabled:true,enabledAt:0};t.secret='test';t.monitoring=new AdaptiveMonitoring(q,{enabled:true,pausedWells:['Gabriel 1']});t.lastLifecycleCheck=Date.now();t.request=()=>assert.fail('No cloud send/check for paused well');await t.tick(false);assert.equal(q.data.deliveries.gab.status,'monitoring_paused');
 t.monitoring=new AdaptiveMonitoring(q,{enabled:true,pausedWells:[]});await t.tick(false);assert.equal(q.data.deliveries.gab.status,'monitoring_paused');
});
