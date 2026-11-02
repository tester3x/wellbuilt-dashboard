import {parsePullChat} from '../pullParser';
const parse=(name:string)=>parsePullChat('[10/16/2026, 15:07] Driver: '+name+'\n7.9/4.5\n140\n3:07',{wellNames:['Bootleg 4','Ironbank 4','Matilda 2'],levelNotation:'feet_inches'});
test.each([['Bootleg4','Bootleg 4'],['Ironbank4','Ironbank 4'],['Matilda bay 2','Matilda 2']])('scoped name %s', (input,expected)=>{const rows=parse(input);expect(rows).toHaveLength(1);expect(rows[0].wellName).toBe(expected);expect(rows[0].issues).toEqual([]);});
test('unknown load goes to review and never guesses a numbered well',()=>{for(const name of ['Bootleg6','Unknown 9']){const rows=parse(name);expect(rows).toHaveLength(1);expect(rows[0].wellName).toBe('');expect(rows[0].issues).toContain('Choose the well for this shorthand message');}});
test('conversation is not a load',()=>expect(parsePullChat('[10/16/2026, 15:07] Driver: See you tomorrow')).toEqual([]));
test('unknown name overrides a default well only into review',()=>{const rows=parsePullChat('[10/16/2026, 15:07] Driver: Unknown 9\n7 9\n4 5\n140',{defaultWell:'Bootleg 4',wellNames:['Bootleg 4'],levelNotation:'feet_inches'});expect(rows).toHaveLength(1);expect(rows[0].wellName).toBe('');expect(rows[0].issues).toContain('Choose the well for this shorthand message');});

test('whole-line pad name may omit its number only with one channel-scoped candidate',()=>{
 const chat='[10/24/2026, 19:16:13] Driver: Matilda\n10.8/3.8\n140\n7:16';
 const [row]=parsePullChat(chat,{wellNames:['Matilda 2','Bootleg 4','Ironbank 4'],levelNotation:'feet_inches'});
 expect(row.wellName).toBe('Matilda 2');expect(row.tankLevelFeet).toBeCloseTo(10+8/12);expect(row.bottomLevelFeet).toBeCloseTo(3+8/12);expect(row.bblsTaken).toBe(140);expect(row.dateTimeUTC).toBe('2026-10-25T00:16:00.000Z');expect(row.issues).toEqual([]);
 for(const names of [['Matilda 2','Matilda 3'],['Bootleg 4']]){
  const [held]=parsePullChat(chat,{wellNames:names,levelNotation:'feet_inches'});
  expect(held.wellName).toBe('');expect(held.issues).toContain('Choose the well for this shorthand message');
 }
 expect(parsePullChat(chat.replace('Matilda\n','Matilda 3\n'),{wellNames:['Matilda 2'],levelNotation:'feet_inches'})[0].wellName).toBe('');
});
test('unique family lookup is general and does not absorb unrelated prose',()=>{
 const chat='[10/24/2026, 19:16:13] Driver: Fixture\n10.8/3.8\n140\n7:16';
 expect(parsePullChat(chat,{wellNames:['Fixture 8'],levelNotation:'feet_inches'})[0].wellName).toBe('Fixture 8');
 expect(parsePullChat(chat.replace('Fixture\n','Water from Fixture\n'),{wellNames:['Fixture 8'],levelNotation:'feet_inches'})[0].wellName).toBe('');
});
