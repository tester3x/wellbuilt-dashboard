import {historicalReviewCommitted} from '../historicalReview';
const review={bblsTaken:185,tankLevelFeet:13,bottomLevelFeet:10.5,dateTimeUTC:'2026-10-20T11:23:34Z'};
const entry={packetId:'original',wellName:'Well',pendingReview:{eventId:'edit',review}};
const packet={companyId:'liquid-gold',wellName:'Well',canonicalProcessingComplete:true,watchdogProvenance:{observationDigest:'identity'},activeEditEventId:'edit',editCount:1,...review,tankAfterInches:126};
const outbox={companyId:'liquid-gold',wellName:'Well',completed:true,stage:'done',isLatestPull:false,eventId:'edit',originalPacketId:'original',sequence:1,measurements:{...review,tankAfterInches:126}};
test('exact historical correction can finalize without a latest outgoing-view marker',()=>{expect(historicalReviewCommitted(outbox,packet,entry,'identity')).toBe(true);});
test('unfinished, wrong event, foreign owner and latest edits cannot use historical proof',()=>{
 for(const change of [{completed:false},{stage:'pending'},{isLatestPull:true},{eventId:'other'},{originalPacketId:'other'},{companyId:'foreign'},{sequence:2}])expect(historicalReviewCommitted({...outbox,...change},packet,entry,'identity')).toBe(false);
 expect(historicalReviewCommitted(outbox,packet,entry,'foreign')).toBe(false);
});
test('packet and completed outbox must match the exact corrected measurements',()=>{
 for(const change of [{bblsTaken:168},{tankLevelFeet:12},{dateTimeUTC:'other'},{tankAfterInches:125},{activeEditEventId:'other'},{canonicalProcessingComplete:false}])expect(historicalReviewCommitted(outbox,{...packet,...change},entry,'identity')).toBe(false);
 expect(historicalReviewCommitted({...outbox,measurements:{...outbox.measurements,bblsTaken:168}},packet,entry,'identity')).toBe(false);
});
