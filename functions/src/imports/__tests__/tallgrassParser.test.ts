import { parsePullChat } from '../pullParser';
const message = (body: string) => `[10/26/26, 6:49:39 AM] Driver: ${body}`;
const options = { wellNames: ['Granli', 'Dwyer'], levelNotation: 'feet_inches' as const };
describe('shared Tallgrass pad reports', () => {
  test.each(['Granli pad', 'GRENLI', 'Granil', 'Dwyer pad', 'Dwyer CTB'])('%s retains levels and canonical identity', heading => {
    const [row] = parsePullChat(message(`${heading}\n15.8\n13.0\n140 bbls`), options);
    expect(row.wellName).toBe(/^dwyer/i.test(heading) ? 'Dwyer' : 'Granli');
    expect(row.tankLevelFeet).toBeCloseTo(15 + 8 / 12);
    expect(row.bblsTaken).toBe(140);
    expect(row.issues).toEqual([]);
    expect(row.dateTimeUTC).toBe('2026-10-26T11:49:39.000Z');
    expect(row.source).toBe(`${heading}\n15.8\n13.0\n140 bbls`);
  });
  test('aliases do not gain scope in another channel', () => {
    const rows = parsePullChat(message('GRENLI\n15.8\n13.0\n140 bbls'), { wellNames: ['Dwyer'] });
    expect(rows.some(row => row.wellName === 'Granli')).toBe(false);
  });
  test('dispatch instructions do not become pulls', () => {
    expect(parsePullChat(message('Granli pad needs 140 bbls pulled'), options)).toEqual([]);
  });
});
