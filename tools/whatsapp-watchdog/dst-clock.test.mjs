import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import os from 'node:os';import path from 'node:path';import {Queue,header} from './core.mjs';
test('raw timestamp preserves both occurrences; ordinary header unchanged',()=>{
 assert.match(header('2026-11-01T06:09:31Z','Test','text'),/01:09:31 UTC-05:00/);
 assert.match(header('2026-11-01T07:09:31Z','Test','text'),/01:09:31 UTC-06:00/);
 assert.equal(header('2026-10-31T06:09:31Z','Test','text'),'[10/31/2026, 01:09:31] Test: text');
});
test('receiver replay releases only automatic clock hold without marking content edited',()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'watchdog-dst-'));try{
 const q=new Queue(dir),body='Gunslinger 3\n9.1\n6.9\n185 bbls\n1:41 am',base={id:'test',channel:'test'};
 q.ingest({...base,chat:'[11/01/2026, 01:41:26] Test: '+body});const id=q.snapshot().messages[0].rows[0].id;
 q.data.deliveries={[id]:{status:'review',issues:['Error: Ambiguous or nonexistent daylight-saving time','Invalid stated pull time']}};
 q.ingest({...base,chat:header('2026-11-01T07:41:26Z','Test',body)});
 assert.equal(q.snapshot().messages[0].edited,false);assert.equal(q.data.deliveries[id],undefined);
 assert.equal(q.snapshot().messages[0].rows[0].dateTimeUTC,'2026-11-01T07:41:00.000Z');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
