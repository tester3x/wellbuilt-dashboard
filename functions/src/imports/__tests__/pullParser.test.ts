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
    expect(parsePullChat(msg('Kahuna 5- 7.8.6.9\n165 bbls'))[0].issues).toContain('Unreadable levels');
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
