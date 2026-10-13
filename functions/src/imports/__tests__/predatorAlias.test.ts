import { parsePullChat } from '../pullParser';

const chat = (name: string) => `[10/13/2026, 07:51:55] Adan: ${name}\n12.9/3.8\n185\n6:51`;
test('bare Predator resolves to the configured Predator 1 and retains measurements', () => {
  const rows = parsePullChat(chat('Predator'), { wellNames: ['Predator 1'], levelNotation: 'feet_inches' });
  expect(rows).toHaveLength(1);
  expect(rows[0].wellName).toBe('Predator 1');
  expect(rows[0].tankLevelFeet).toBeCloseTo(12.75);
  expect(rows[0].bottomLevelFeet).toBeCloseTo(3 + 8 / 12);
  expect(rows[0].bblsTaken).toBe(185);
  expect(rows[0].source).toContain('Predator\n12.9/3.8');
});
test('explicit Predator 2 and missing catalogue authority are not mapped to Predator 1', () => {
  for (const name of ['Predator 2', 'Predator-2', 'Predator #2']) {
    expect(parsePullChat(chat(name), { wellNames: ['Predator 1'] }).some(r => r.wellName === 'Predator 1')).toBe(false);
  }
  expect(parsePullChat(chat('Predator'), {}).some(r => r.wellName === 'Predator 1')).toBe(false);
  expect(parsePullChat(chat('Predator'), { wellNames: ['Predator', 'Predator 1'] })[0].wellName).toBe('Predator');
});
