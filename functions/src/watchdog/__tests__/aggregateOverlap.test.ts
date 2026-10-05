import {possibleAggregateOverlap} from '../aggregateOverlap';
const row={wellName:'Example',dateTimeUTC:'2026-10-05T15:00:00Z',tankLevelFeet:9+1/12,bottomLevelFeet:6.25,bblsTaken:170};
const aggregate={wellName:'Example',packetId:'combined',dateTimeUTC:'2026-10-05T13:30:00Z',tankLevelFeet:11+11/12,tankAfterInches:75,bblsTaken:340,driverId:'driver'};
test('individual second load inside manual aggregate is held despite different amount/top/time',()=>expect(possibleAggregateOverlap(row,{combined:aggregate},'driver')).toEqual(['combined']));
test('different driver, unrelated levels, out-of-window and watchdog packets do not match',()=>{
 expect(possibleAggregateOverlap(row,{combined:aggregate},'other')).toEqual([]);
 for(const patch of [{tankAfterInches:120},{dateTimeUTC:'2026-10-04T13:30:00Z'},{source:'whatsapp_watchdog'},{deleted:true}])expect(possibleAggregateOverlap(row,{combined:{...aggregate,...patch}},'driver')).toEqual([]);
});
test('equal volume remains the responsibility of exact duplicate checks',()=>expect(possibleAggregateOverlap(row,{combined:{...aggregate,bblsTaken:170}},'driver')).toEqual([]));
test('missing reported bottom cannot establish containment',()=>expect(possibleAggregateOverlap({...row,bottomLevelFeet:null},{combined:aggregate},'driver')).toEqual([]));
