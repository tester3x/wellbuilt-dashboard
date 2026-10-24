import {previousPullBottomInches} from '../previousPullLevel';

describe('AFR previous measurement precision', () => {
  test('does not turn 3.5 inches of recovery into 4 inches', () => {
    const bottom = previousPullBottomInches({tankAfterInches: 89.5}, 89);
    const elapsedDays = 0.25;
    expect(93 - bottom).toBe(3.5);
    expect(elapsedDays / (93 - bottom) * 12).toBeCloseTo(6 / 7);
  });
  test('keeps precision on successive pulls, including sub-inch recovery', () => {
    for (const [bottom, top] of [[89.5, 93], [92.75, 93], [0, 12]]) {
      expect(top - previousPullBottomInches({tankAfterInches: bottom}, Math.floor(bottom)))
        .toBeCloseTo(top - bottom);
    }
  });
  test.each([null, {}, {tankAfterInches: NaN}, {tankAfterInches: -1}, {tankAfterInches: '89.5'}])(
    'retains legacy projection fallback when exact source is unavailable: %p', packet => {
      expect(previousPullBottomInches(packet, 89)).toBe(89);
    });
});
