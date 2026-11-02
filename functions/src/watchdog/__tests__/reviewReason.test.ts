import {normalizeReviewReason,applyReviewCorrections} from '../reviewCorrections';
const row:any={dateTimeUTC:'2026-10-07T20:29:17.000Z',tankLevelFeet:12,bottomLevelFeet:9.25,bblsTaken:185,issues:[]};
const review={confirmed:true,dateTimeUTC:'2026-10-07T20:29:00.000Z',tankLevelFeet:12,bottomLevelFeet:9.25,bblsTaken:185,reason:''};
test('unchanged confirmation needs no user reason and preserves original seconds',()=>{expect(normalizeReviewReason(row,review)).toMatchObject({reason:'Confirmed unchanged values',dateTimeUTC:row.dateTimeUTC});expect(applyReviewCorrections(row,review).dateTimeUTC).toBe(row.dateTimeUTC);});
test.each([{bblsTaken:175},{bottomLevelFeet:9},{tankLevelFeet:13},{dateTimeUTC:'2026-10-07T20:30:00.000Z'}])('correction requires a reason: %j',change=>{expect(()=>normalizeReviewReason(row,{...review,...change})).toThrow();expect(normalizeReviewReason(row,{...review,...change,reason:'Verified correction'}).reason).toBe('Verified correction');});

test('explicit review can discard impossible reported bottom without inventing a replacement',()=>{
 const bad={...row,tankLevelFeet:12.25,bottomLevelFeet:19.75,bblsTaken:165,issues:['Labelled bottom exceeds top']};
 const checked=applyReviewCorrections(bad,{confirmed:true,dateTimeUTC:row.dateTimeUTC,bblsTaken:165,bottomLevelFeet:null,reason:'Owner confirms 165 BBL; disregard bottom typo; calibrated math applies'});
 expect(checked.bottomLevelFeet).toBeNull();expect(checked.issues).toEqual([]);expect(checked.tankLevelFeet).toBe(12.25);expect(checked.bblsTaken).toBe(165);expect(bad.bottomLevelFeet).toBe(19.75);
 expect(()=>applyReviewCorrections(bad,{confirmed:true,dateTimeUTC:row.dateTimeUTC,bblsTaken:165,reason:'No bottom correction'})).toThrow('invalid_review_bottom');
});
