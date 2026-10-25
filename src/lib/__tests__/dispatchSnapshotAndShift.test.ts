import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dispatchLevelSnapshot } from '../dispatchLevelSnapshot.ts';
import { projectWellLevel } from '../wellLevelProjection.ts';
import { shiftResolveRequest } from '../shiftResolveRequest.ts';
import { parseShiftResolveEnvelope, shiftDotForDriver } from '../shiftDotCore.ts';
import type { WellResponse } from '../wells';

test('single and queue dispatch freeze the projected level at assignment, preserving pull history', () => {
 const pull = Date.parse('2026-10-24T00:00:00Z');
 const well = {wellName:'Fixture',currentLevel:"5'7\"",lastPullBottomLevel:"5'7\"",lastPullDateTimeUTC:new Date(pull).toISOString(),flowRate:'1:00:00'} as WellResponse;
 const original = structuredClone(well), assigned = pull + 340 * 60000;
 const snapshot = dispatchLevelSnapshot(well, assigned);
 assert.equal(snapshot.currentLevel, "11'3\"");
 assert.equal(snapshot.currentLevel, projectWellLevel(well,assigned).estDisplay);
 assert.notEqual(snapshot.currentLevel, projectWellLevel(well,assigned + 3600000).estDisplay);
 assert.deepEqual(well,original);
 assert.equal(dispatchLevelSnapshot(undefined, assigned).currentLevel,'');
 assert.equal(dispatchLevelSnapshot({...well,lastPullBottomLevel:''},assigned).currentLevel,'');
 const page=readFileSync(new URL('../../app/dispatch/page.tsx',import.meta.url),'utf8');
 assert.match(page,/dispatchLevelSnapshot\(liveWell, assignedAt.toMillis\(\)\)/);
 assert.match(page,/dispatchLevelSnapshot\(well, assignedAt.toMillis\(\)\)/);
 assert.doesNotMatch(page,/currentLevel: (?:assignTarget|well\?)\.currentLevel/);
});

test('shift request matches strict deployed keys and both pickers consume canonical authority', () => {
 assert.deepEqual(shiftResolveRequest([' canonical-driver ','canonical-driver','']),{driverIds:['canonical-driver']});
 const response=parseShiftResolveEnvelope({companyId:'fixture',results:[{driverId:'canonical-driver',state:'open'}]});
 assert.equal(shiftDotForDriver({canonicalDriverId:'canonical-driver',companyId:'fixture',resolvedCompanyId:response.companyId,resultsByDriverId:response.resultsByDriverId}).dot,'green');
 assert.equal(shiftDotForDriver({canonicalDriverId:'canonical-driver',companyId:'foreign',resolvedCompanyId:response.companyId,resultsByDriverId:response.resultsByDriverId}).dot,'gray');
 const wrapper=readFileSync(new URL('../resolveCompanyDriverShifts.ts',import.meta.url),'utf8');
 assert.match(wrapper,/const payload = shiftResolveRequest\(ids\)/);
 assert.doesNotMatch(wrapper,/payload\.companyId/);
 const page=readFileSync(new URL('../../app/dispatch/page.tsx',import.meta.url),'utf8');
 assert.match(page,/resolveCompanyDriverShifts\(driverCanonicalIds\)/);
 assert.match(page,/onShiftChange={updateDriverShiftPlan} shiftDot={driverShiftDot}/);
});

