import { resolveTankBblPerFoot } from '../tankCalibration';
import * as fs from 'fs';
import * as path from 'path';

describe('production tank calibration regressions', () => {
  test.each([
    ['Barnstormer 3', 1000, 30, 2, 18.75, 185, 191.7],
    ['Gunslinger 3', 740, 22, 2, 9.5, 170, 83.6756756757],
    ['Gunslinger 5', 740, 22, 2, 133/12, 170, 102.6756756757],
    ['Predator 1', 500, 20, 1, 14, 140, 100.8],
    ['Cyclone 2', 400, 20, 3, 89/12, 165, 56],
    ['Kahuna 2', 500, 25, 6, 82/12, 165, 65.5],
    ['Daredevil 1', 1000, 30, 6, 10, 200, 108],
  ])('%s uses tank dimensions', (_name, tankCapacity, tankHeight, tanks, top, bbls, bottom) => {
    const rate = resolveTankBblPerFoot({ tankCapacity, tankHeight, tanks });
    expect((top - bbls/rate)*12).toBeCloseTo(bottom, 8);
  });
  test('stored bank calibration wins and is not multiplied by tanks twice', () => {
    expect(resolveTankBblPerFoot({bblPerFoot:'66.66666666666667',tanks:2,tankCapacity:400,tankHeight:20})).toBeCloseTo(200/3);
  });
  test('dimension fallback respects active tanks and numeric strings', () => {
    expect(resolveTankBblPerFoot({tankCapacity:'1000',tankHeight:'30',tanks:6,activeTanks:'2'})).toBeCloseTo(200/3);
    expect(resolveTankBblPerFoot({tankCapacity:400,tankHeight:20,numTanks:3})).toBe(60);
  });
  test.each([{}, {tanks:2}, {tankCapacity:1000,tankHeight:0,tanks:2}, {tankCapacity:1000,tankHeight:30,tanks:2,activeTanks:0}, {bblPerFoot:Infinity}])('missing or invalid calibration never invents a rate: %j', cfg => {
    expect(()=>resolveTankBblPerFoot(cfg)).toThrow('bbl_per_foot_unavailable');
  });
  test('new pull handler uses calibration before writes and for all volume conversions', () => {
    const source=fs.readFileSync(path.join(__dirname,'../index.ts'),'utf8');
    const pull=source.slice(source.indexOf('export const processIncomingPull ='),source.indexOf('export const processEditRequest ='));
    expect(pull).toContain('resolveTankBblPerFoot(config)');
    expect(pull).toContain('(data.bblsTaken / bblPerFoot) * 12');
    expect(pull).toContain('(pullBbls / bblPerFoot) * 12');
    expect(pull).toContain('(1 / afr) * bblPerFoot');
    expect(pull).not.toMatch(/tanks \* 20|20 \* tanks|\/ 20 \/ tanks/);
    expect(pull.indexOf('resolveTankBblPerFoot(config)')).toBeLessThan(pull.indexOf('.set('));
    expect(pull).toContain('sendLevelToChat(data, packetId, { tankAfterInches, tanks, bblPerFoot })');
  });
});
