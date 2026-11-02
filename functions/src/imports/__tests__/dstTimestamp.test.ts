import {chatTimestamp,parsePullChat} from '../pullParser';
test('repeated hour requires a real matching offset; nonexistent time stays held',()=>{
 expect(()=>chatTimestamp('11/01/2026','01:09:31')).toThrow('Ambiguous');
 expect(chatTimestamp('11/01/2026','01:09:31 UTC-05:00')).toBe('2026-11-01T06:09:31.000Z');
 expect(chatTimestamp('11/01/2026','01:09:31 UTC-06:00')).toBe('2026-11-01T07:09:31.000Z');
 expect(()=>chatTimestamp('11/01/2026','01:09:31 UTC-04:00')).toThrow();
 expect(()=>chatTimestamp('03/08/2026','02:09:31 UTC-06:00')).toThrow();
});
test.each([['-05:00','06'],['-06:00','07']])('stated time follows known post occurrence %s',(offset,hour)=>{
 const [row]=parsePullChat(`[11/01/2026, 01:41:26 UTC${offset}] Test Driver: Gunslinger 3\n9.1\n6.9\n185 bbls\n1:41 am`,{levelNotation:'feet_inches'});
 expect(row.postedAt).toBe(`2026-11-01T${hour}:41:26.000Z`);expect(row.dateTimeUTC).toBe(`2026-11-01T${hour}:41:00.000Z`);expect(row.issues).toEqual([]);
});
