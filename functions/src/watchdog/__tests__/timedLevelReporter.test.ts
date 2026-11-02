import {isTimedLevelReporter} from '../timedLevelReporter';
const row={levelOnly:true,measurementTimeSource:'stated',bblsTaken:0,bottomLevelFeet:null,postedAt:'2026-10-22T22:41:57Z',dateTimeUTC:'2026-10-22T22:30:00Z'};
const channel={timedLevelReporters:{sender:{enabled:true,startAt:'2026-10-22T22:30:00Z'}}};
test('only the scoped enabled sender with explicit measurement time qualifies',()=>{
 expect(isTimedLevelReporter(channel,'sender',row)).toBe(true);
 for(const key of [null,'other'])expect(isTimedLevelReporter(channel,key,row)).toBe(false);
 expect(isTimedLevelReporter({},'sender',row)).toBe(false);
 for(const patch of [{measurementTimeSource:'posted'},{bblsTaken:165},{bottomLevelFeet:2},{levelOnly:false},{dateTimeUTC:'2026-10-22T22:29:00Z'},{dateTimeUTC:'2026-10-22T23:00:00Z'},{dateTimeUTC:'invalid'}])expect(isTimedLevelReporter(channel,'sender',{...row,...patch})).toBe(false);
 expect(isTimedLevelReporter({timedLevelReporters:{sender:{enabled:false,startAt:row.dateTimeUTC}}},'sender',row)).toBe(false);
});
