import { readFileSync } from 'fs';
import { join } from 'path';

describe("Gabriel's FW pilot configuration", () => {
  const groups = JSON.parse(readFileSync(join(
    __dirname, '../../../../../release/fresh-water/gabriels-fw-20261027.json',
  ), 'utf8')) as Record<string, {
    routeName: string;
    wellNames: string[];
    config: {
      tankCount: number;
      tankHeightFeet: number;
      bblPerFootPerTank: number;
      equalization: string;
      dailyUseBbl: number | null;
    };
  }>;

  it('contains only the three authorized shared-pad cards', () => {
    expect(Object.keys(groups).sort()).toEqual(['gabriel-1-4-5-6', 'gabriel-2', 'gabriel-3-7']);
    expect(new Set(Object.values(groups).map(group => group.routeName))).toEqual(new Set(["Gabriel's FW"]));
    expect(groups['gabriel-1-4-5-6'].wellNames).toEqual(['Gabriel 1', 'Gabriel 4', 'Gabriel 5', 'Gabriel 6']);
    expect(groups['gabriel-3-7'].wellNames).toEqual(['Gabriel 3', 'Gabriel 7']);
    expect(groups['gabriel-2'].wellNames).toEqual(['Gabriel 2']);
  });

  it('matches nominal capacity and preserves unknown field facts', () => {
    expect(groups['gabriel-1-4-5-6'].config).toMatchObject({
      tankCount: 3, tankHeightFeet: 20, bblPerFootPerTank: 20,
      equalization: 'unverified', dailyUseBbl: null,
    });
    expect(groups['gabriel-3-7'].config.tankCount
      * groups['gabriel-3-7'].config.tankHeightFeet
      * groups['gabriel-3-7'].config.bblPerFootPerTank).toBe(400);
    expect(groups['gabriel-2'].config.tankCount
      * groups['gabriel-2'].config.tankHeightFeet
      * groups['gabriel-2'].config.bblPerFootPerTank).toBe(400);
    expect(groups['gabriel-1-4-5-6'].config.tankCount
      * groups['gabriel-1-4-5-6'].config.tankHeightFeet
      * groups['gabriel-1-4-5-6'].config.bblPerFootPerTank).toBe(1200);
    expect(Object.values(groups).every(group => group.config.dailyUseBbl === null)).toBe(true);
  });
});
