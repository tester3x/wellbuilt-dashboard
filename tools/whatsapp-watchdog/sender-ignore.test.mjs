import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {isIgnoredSender,loadSenderIgnoreRules} from './sender-ignore.mjs';

test('sender ignore applies only to one WhatsApp identity in one channel',()=>{
 const sender='mike-example@lid',gabriel='gabriel-example@g.us',other='other-example@g.us';
 const rules={[gabriel]:[createHash('sha256').update(sender).digest('hex')]};
 assert.equal(isIgnoredSender(rules,gabriel,sender),true);
 assert.equal(isIgnoredSender(rules,other,sender),false);
 assert.equal(isIgnoredSender(rules,gabriel,'another-person@lid'),false);
 assert.equal(isIgnoredSender(rules,gabriel,''),false);
 assert.equal(isIgnoredSender({},gabriel,sender),false);
});

test('private sender-ignore file is optional and rejects malformed rules',()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'watchdog-sender-ignore-'));
 try{
  assert.deepEqual(loadSenderIgnoreRules(dir),{});
  const rules={'gabriel-example@g.us':[createHash('sha256').update('mike-example@lid').digest('hex')]};
  writeFileSync(path.join(dir,'sender-ignore.json'),JSON.stringify(rules));
  assert.deepEqual(loadSenderIgnoreRules(dir),rules);
  writeFileSync(path.join(dir,'sender-ignore.json'),'{"gabriel-example@g.us":["wrong"]}');
  assert.throws(()=>loadSenderIgnoreRules(dir),/Invalid sender-ignore rule hash/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
