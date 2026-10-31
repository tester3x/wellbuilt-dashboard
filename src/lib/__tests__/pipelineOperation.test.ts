import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mergeWellPool} from '../wellPoolCore.ts';
import {projectWellLevel,wbmInputsFromWell} from '../wellLevelProjection.ts';
import {classifyWell} from '../dispatchPriority.ts';
test('governed pipeline catalog holds assumed height on web and never recommends a synthetic load',()=>{
 const [well]=mergeWellPool({Example:{tankHeight:20,tanks:2,bblPerFoot:51,bottomLevel:3,pullBbls:140,isDown:false,pipelineOperation:{mode:'running',holdingLevelFeet:10,productionMinutesPerFoot:101.13,levelBasis:'assumed'}}},{Example:{wellName:'Example',wellDown:false,lastPullBottomLevel:"9'2\"",lastPullDateTimeUTC:'2026-10-27T02:00:00Z',currentLevel:"9'2\"",flowRate:'1:41:08'}});
 for(const at of [Date.parse('2026-10-31T12:00:00Z'),Date.parse('2026-11-03T12:00:00Z')])assert.equal(projectWellLevel(well,at).estFeet,10);
 assert.equal(well.lastPullBottomLevel,"9'2\"");assert.equal(wbmInputsFromWell(well).flowMinutesPerFoot,0);
 const c=classifyWell(well,Date.parse('2026-10-31T12:00:00Z'));assert.equal(c.label,'PIPELINE');assert.equal(c.availableLoads,0);
 assert.equal(projectWellLevel({...well,isDown:true,wellDown:true},Date.parse('2026-10-31T12:00:00Z')).estFeet,9+2/12);
});
