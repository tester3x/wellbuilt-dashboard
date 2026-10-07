import {normalizeReviewReason,applyReviewCorrections} from '../reviewCorrections';
const row:any={dateTimeUTC:'2026-10-07T20:29:17.000Z',tankLevelFeet:12,bottomLevelFeet:9.25,bblsTaken:185,issues:[]};
const review={confirmed:true,dateTimeUTC:'2026-10-07T20:29:00.000Z',tankLevelFeet:12,bottomLevelFeet:9.25,bblsTaken:185,reason:''};
test('unchanged confirmation needs no user reason and preserves original seconds',()=>{expect(normalizeReviewReason(row,review)).toMatchObject({reason:'Confirmed unchanged values',dateTimeUTC:row.dateTimeUTC});expect(applyReviewCorrections(row,review).dateTimeUTC).toBe(row.dateTimeUTC);});
test.each([{bblsTaken:175},{bottomLevelFeet:9},{tankLevelFeet:13},{dateTimeUTC:'2026-10-07T20:30:00.000Z'}])('correction requires a reason: %j',change=>{expect(()=>normalizeReviewReason(row,{...review,...change})).toThrow();expect(normalizeReviewReason(row,{...review,...change,reason:'Verified correction'}).reason).toBe('Verified correction');});
