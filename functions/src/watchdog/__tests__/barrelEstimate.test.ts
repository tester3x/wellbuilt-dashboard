import { barrelEstimate } from '../barrelEstimate';
const base={top:12,bottom:10,bank:60,rateMinutesPerFoot:120,isDown:false,rateMeasuredAt:'2026-10-04T12:00:00Z',measuredAt:'2026-10-04T14:00:00Z'};
test('bounds production without inventing load duration or changing barrels',()=>{expect(barrelEstimate(base)).toMatchObject({mode:'comparison_only',estimatedBbls:130,lowBbls:125,highBbls:135});});
test('invalid bottom cannot produce an estimate',()=>{expect(barrelEstimate({...base,bottom:13})).toBeNull();expect(barrelEstimate({...base,bottom:null})).toBeNull();});
test('future, old, stopped and invalid AFR cannot supply production',()=>{for(const patch of [{isDown:true},{rateMinutesPerFoot:0},{rateMeasuredAt:'2026-10-04T15:00:00Z'},{rateMeasuredAt:'2026-10-01T12:00:00Z'}])expect(barrelEstimate({...base,...patch})).toMatchObject({lowBbls:120,highBbls:null,rateMinutesPerFoot:null});});
