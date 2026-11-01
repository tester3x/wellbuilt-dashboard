import {parsePullChat} from '../../imports/pullParser';
import {reportedWellOff} from '../reportedWellState';
const row=(body:string)=>parsePullChat('[10/31/2026, 15:39:34] Test Driver: '+body,{wellNames:['Kahuna 1'],levelNotation:'feet_inches'})[0];
test.each(['Kahuna 1 @ 6’ 5” off','Kahuna 1\n@ 6\'5" OFF'])('verified explicit shutdown: %s',body=>{
 expect(reportedWellOff(row(body),true)).toBe(true);
 expect(reportedWellOff(row(body),false)).toBe(false);
});
test.each(['Kahuna 1 @ 6’ 5”','Kahuna 1 @ 6’ 5”\nDrop off at disposal','Kahuna 1 @ 6’ 5”\nTank off','Kahuna 1 @ 6’ 5” off\nnot sure','Kahuna 1\n9\'0"\n2\'0"\n140 bbl'])('ordinary reports and prose cannot change state: %s',body=>{
 const parsed=row(body);expect(parsed).toBeDefined();expect(reportedWellOff(parsed,true)).toBe(false);
});
test('a report for another well, mismatched gauge or a loaded report cannot change state',()=>{
 const parsed=row('Kahuna 1 @ 6’ 5” off');
 expect(reportedWellOff({...parsed,wellName:'Kahuna 5'},true)).toBe(false);
 expect(reportedWellOff({...parsed,tankLevelFeet:8},true)).toBe(false);
 expect(reportedWellOff({...parsed,bblsTaken:140},true)).toBe(false);
});
