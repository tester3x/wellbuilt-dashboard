import { parsePullChat, parseFeet, chatTimestamp } from '../pullParser';
const msg = (body: string, time = '3:41:19 PM') => `[9/20/26, ${time}] Driver: ${body}`;
describe('historical pull parser', () => {
  test('decimal feet and feet/inches remain distinct', () => {
    expect(parseFeet('7.11')).toBe(7.11);
    expect(parseFeet('7’11')).toBeCloseTo(7 + 11 / 12);
    expect(parseFeet('7 11')).toBeCloseTo(7 + 11 / 12);
    expect(parseFeet('7-12')).toBeNull();
  });
  test('labelled pull uses written volume, not a channel default', () => {
    const [row] = parsePullChat(msg('Cyclone 2-21-16H\nTop: 8.6\nBottom: 6.4\n140 bbls'), { defaultBbls: 165 });
    expect(row.tankLevelFeet).toBe(8.6);
    expect(row.bblsTaken).toBe(140);
    expect(row.issues).toEqual([]);
    expect(row.dateTimeUTC).toBe('2026-09-20T20:41:19.000Z');
  });
  test('channel default fills unnamed shorthand but never overrides an explicit other well', () => {
    const rows = parsePullChat(msg('8 8\n7 8\n185.             341p') + '\n' + msg('Cyclone 2- 9.4/8.2\n185bbls'), { defaultWell: 'Kahuna 5' });
    expect(rows[0].wellName).toBe('Kahuna 5');
    expect(rows[0].bblsTaken).toBe(185);
    expect(rows[0].dateTimeUTC).toBe('2026-09-20T20:41:00.000Z');
    expect(rows[1].wellName).toBe('Cyclone 2');
  });
  test('separate 24-hour pull time wins over message time', () => {
    const [row] = parsePullChat(msg('9’1\n8’1\n185\n1422'), { defaultWell: 'Kahuna 5' });
    expect(row.dateTimeUTC).toBe('2026-09-20T19:22:00.000Z');
    expect(row.tankLevelFeet).toBeCloseTo(9 + 1 / 12);
  });
  test('ambiguous shorthand without mapping is review-only', () => {
    expect(parsePullChat(msg('9’1\n8’1\n185\n1422'))[0].issues).toContain('Choose the well for this shorthand message');
  });
  test('dispatch, deleted posts and tank descriptions do not become pulls', () => {
    const text = [msg('Service: 130 bbls Heavy water from Kahuna 5-6-7H take to another pad'), msg('This message was deleted'), msg('6 TANK SETUP\n400 Bbls/20 FT High\nONLY 4 tanks active')].join('\n');
    expect(parsePullChat(text)).toEqual([]);
  });
  test('malformed slash levels are surfaced instead of guessed', () => {
    expect(parsePullChat(msg('Kahuna 5- 7.8.6.9\n165 bbls'))[0].issues).toContain('Inferred level separator needs historical validation');
  });
  test('date filtering keeps an auditable excluded row', () => {
    expect(parsePullChat(msg('Kahuna 5- 8.2/7.2\n185 bbls'), { startDate: '2026-09-21' })[0].excluded).toBe(true);
  });
  test('DST gaps and duplicate wall times require review', () => {
    expect(() => chatTimestamp('3/8/26', '2:30 AM')).toThrow();
    expect(() => chatTimestamp('11/1/26', '1:30 AM')).toThrow();
  });
  test('Android export and day-first dates', () => {
    const [row] = parsePullChat('20/9/26, 15:41 - Driver: Kahuna 5- 8.2/7.2\n185 bbls', { dateOrder: 'dmy' });
    expect(row.dateTimeUTC).toBe('2026-09-20T20:41:00.000Z');
  });
});

test('inline bottom-level clock and punctuation preserve driver shorthand',()=>{const [r]=parsePullChat('[10/2/26, 10:29:52 PM] Driver: Gunslinger 3\n13 4\n10 10.          1029p',{defaultBbls:165});expect(r.tankLevelFeet).toBeCloseTo(13+4/12);expect(r.bottomLevelFeet).toBeCloseTo(10+10/12);expect(r.bblsTaken).toBe(165);expect(r.dateTimeUTC).toBe('2026-10-03T03:29:00.000Z');expect(r.issues).toEqual([]);});
test('T/B gauge abbreviations and written barrels are pulls',()=>{const [r]=parsePullChat('[10/2/26, 11:26 PM] Driver: Gunslinger 5\nT 13.0\nB 10.5\n170 bbl',{defaultBbls:165});expect(r.tankLevelFeet).toBe(13);expect(r.bottomLevelFeet).toBe(10.5);expect(r.bblsTaken).toBe(170);expect(r.issues).toEqual([]);});


test.each(['10 3/9.3','10.3/9.3','10 3/9 3'])('slash pair accepts supported level formats: %s', pair => {
 const [row] = parsePullChat(msg('Kahuna 5- '+pair+'\n165 bbls'));
 expect(row.tankLevelFeet).toBeCloseTo(pair.startsWith('10.3') ? 10.3 : 10.25);
 expect(row.bottomLevelFeet).toBeCloseTo(pair.endsWith('9 3') ? 9.25 : 9.3);
 expect(row.bblsTaken).toBe(165);
 expect(row.issues).toEqual([]);
});

test('bare compact time attached to bottom resolves against post without consuming spaced inches',()=>{
 const [row]=parsePullChat('[10/4/2026, 4:21:08 PM] Driver: Kahuna 5\n12\n11.    420\n185 bbls');
 expect(row.tankLevelFeet).toBe(12);expect(row.bottomLevelFeet).toBe(11);expect(row.bblsTaken).toBe(185);expect(row.dateTimeUTC).toBe('2026-10-04T21:20:00.000Z');expect(row.issues).toEqual([]);
 const [spaced]=parsePullChat('[10/4/2026, 4:21:08 PM] Driver: Kahuna 5\n12 3\n11 4\n185 bbls');expect(spaced.tankLevelFeet).toBe(12.25);expect(spaced.bottomLevelFeet).toBeCloseTo(11+4/12);expect(spaced.dateTimeUTC).toBe(spaced.postedAt);
 const [far]=parsePullChat('[10/4/2026, 10:21:08 PM] Driver: Kahuna 5\n12\n11.    420\n185 bbls');expect(far.issues).toContain('Pull time lacks AM/PM; confirm');
});

test.each(['11’ 11”','11\' 11"','11′ 11″','11 ft 11 in'])('spaced feet and inch marks parse without confusing decimal feet: %s',value=>{
 expect(parseFeet(value)).toBeCloseTo(11+11/12);
});
test('Watford post with spaced curly quotes preserves top bottom written barrels and posting time',()=>{
 const [row]=parsePullChat('[10/5/2026, 4:17:08 PM] Driver: Kahuna 1\n11’ 11”\n4’ 11”\n140 bbl',{wellNames:['Kahuna 1'],defaultBbls:165});
 expect(row.wellName).toBe('Kahuna 1');expect(row.tankLevelFeet).toBeCloseTo(11+11/12);expect(row.bottomLevelFeet).toBeCloseTo(4+11/12);expect(row.bblsTaken).toBe(140);expect(row.dateTimeUTC).toBe('2026-10-05T21:17:08.000Z');expect(row.issues).toEqual([]);
 expect(parseFeet('11’ 12”')).toBeNull();expect(parseFeet('11’ 11” junk')).toBeNull();
});

test('bare one oclock resolves to a nearby afternoon post; inferred separator remains provisional',()=>{
 const [r]=parsePullChat('[10/6/26, 1:19:44 PM] Driver: Kahuna 5\n8.8\n7.7\n185\n1:00');expect(r.dateTimeUTC).toBe('2026-10-06T18:00:00.000Z');expect(r.issues).toEqual([]);
 const [typo]=parsePullChat('[10/6/26, 1:19:44 PM] Driver: Kahuna 5- 8.8.6.9\n165 bbls');expect(typo.tankLevelFeet).toBe(8.8);expect(typo.bottomLevelFeet).toBe(6.9);expect(typo.inferredSeparator).toBe(true);
});

test('clock after T/B levels is time, never barrels; driver default beats group fallback',()=>{
 const chat='[10/07/2026, 12:52:55] Test Driver: Gunslinger 3\nT 15-1\nB 12-5\n12:22 pm';
 const [row]=parsePullChat(chat,{defaultBbls:165,driverDefaultBbls:{'Test Driver':185}});
 expect(row.bblsTaken).toBe(185);expect(row.dateTimeUTC).toBe('2026-10-07T17:22:00.000Z');expect(row.issues).toEqual([]);
 expect(parsePullChat(chat)[0].bblsTaken).toBeNull();
 expect(parsePullChat(chat.replace('12:22 pm','170 bbls\n12:22 pm'),{driverDefaultBbls:{'Test Driver':185}})[0].bblsTaken).toBe(170);
});

 test('Pesek shorthand resolves only to the configured Pesek 10 well',()=>{
 const chat='[10/09/2026, 10:27:38] Anthony: Pesek\n12’ 3”\n3’ 9”\n170 bbl';
 const rows=parsePullChat(chat,{wellNames:['Pesek 10']});
 expect(rows).toHaveLength(1);expect(rows[0].wellName).toBe('Pesek 10');expect(rows[0].tankLevelFeet).toBe(12.25);expect(rows[0].bblsTaken).toBe(170);
 expect(parsePullChat(chat,{wellNames:['Atlas 1']})).toHaveLength(0);
 expect(parsePullChat(chat.replace('Pesek\n','Pesek 12\n'),{wellNames:['Pesek 10']})).toHaveLength(0);
 });
