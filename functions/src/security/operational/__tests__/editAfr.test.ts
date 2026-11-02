import {calculateEditedAfr} from '../editAfr';

describe('edited pull AFR', () => {
  test('Thor 1 shut-in and one-inch outlier do not poison the rate', () => {
    const samples = [
      {dateTimeUTC: '2026-10-24T00:40:19Z', flowRateDays: 0.1560066},
      {dateTimeUTC: '2026-10-25T22:56:20Z', flowRateDays: 0.1637282},
      {dateTimeUTC: '2026-10-26T16:00:00Z', flowRateDays: 0.1609527},
      {dateTimeUTC: '2026-10-27T17:49:20Z', flowRateDays: 0.1986332},
      {dateTimeUTC: '2026-10-29T17:21:51Z', flowRateDays: 23.7709814, wellDown: true},
      {dateTimeUTC: '2026-10-31T15:00:00Z', flowRateDays: 0},
      {dateTimeUTC: '2026-11-01T15:30:00Z', flowRateDays: 0.1317204},
      {dateTimeUTC: '2026-11-01T21:07:51Z', flowRateDays: 0.7038542},
    ];
    const afr = calculateEditedAfr(samples);
    expect(afr * 24).toBeGreaterThan(3);
    expect(afr * 24).toBeLessThan(5);
  });
});
