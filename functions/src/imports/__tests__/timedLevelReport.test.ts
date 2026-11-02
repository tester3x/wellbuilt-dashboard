import {parsePullChat} from '../pullParser';
test.each(['Gunslinger 3','Gunslinger 5','Atlas 1','Ironbank 4'])('timed level report tolerates a level label and trailing note for %s',well=>{
 for(const gauge of ['levels 5-6 @5:30pm','level: 5-6 @ 5:30pm','5-6@5:30pm','5-6 5:30pm']){
  const rows=parsePullChat(`[10/06/2026, 17:41:57] Reporter: ${well} ${gauge}\nAdditional field note`,{wellNames:[well],defaultBbls:185,levelNotation:'feet_inches'});
  expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({wellName:well,levelOnly:true,tankLevelFeet:5.5,bottomLevelFeet:null,bblsTaken:0,dateTimeUTC:'2026-10-06T22:30:00.000Z',measurementTimeSource:'stated',issues:[]});
 }
});
test('a timed instruction without a gauge is not an observation',()=>{
 expect(parsePullChat('[10/06/2026, 17:41:57] Reporter: Gunslinger 3 water go hot oiler @5:30pm')).toEqual([]);
});
test('invalid inches and unknown leading prose are not accepted as clean gauges',()=>{
 for(const text of ['levels 5-16 @5:30pm','send 5-6 @5:30pm']){
  expect(parsePullChat('[10/06/2026, 17:41:57] Reporter: Gunslinger 3 '+text).some(row=>row.levelOnly&&row.issues.length===0)).toBe(false);
 }
});
