import {parsePullChat} from '../pullParser';
import {reviewPulls} from '../pullImportModel';
const parse=(body:string)=>parsePullChat(`[10/14/26, 1:17 PM] Route holder: Atlas 1 ${body}`,{wellNames:['Atlas 1'],levelNotation:'feet_inches',defaultBbls:165})[0];
test('Atlas off reading preserves top, no reported bottom and zero removal despite load defaults',()=>{
 expect(parse('@ 6′ 5″ off')).toMatchObject({wellName:'Atlas 1',tankLevelFeet:6+5/12,bottomLevelFeet:null,bblsTaken:0,levelOnly:true,measurementTimeSource:'posted'});
});
test('an untimed top-only reading asks for measurement time until verified sender ownership is checked',()=>{
 expect(parse('@ 6′ 5″ off').issues).toContain('Confirm measurement time for top-only reading');
 const row=parse('@ 6′ 5″ off\n11:17 am');
 expect(row.dateTimeUTC).toBe('2026-10-14T16:17:00.000Z'); expect(row.measurementTimeSource).toBe('stated');expect(row.issues).toEqual([]);
});
test('zero removal leaves the calculated after-level equal to the measured top',()=>{
 const row=parse('@ 6′ 5″ off\n1:17 pm');
 const [checked]=reviewPulls([row],{'Atlas 1':{bblPerFoot:120,tankHeight:25}}, {}, {}, new Set());
 expect(checked.status).toBe('ready');expect(checked.afterFeet).toBe(row.tankLevelFeet);
});
