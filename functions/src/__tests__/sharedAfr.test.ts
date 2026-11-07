import {averageFlowRates, recentFlowSamples} from '../flowAverage';

const hour = 3_600_000;
const start = Date.parse('2026-11-01T00:00:00Z');
const observation = (at: number, minutesPerInch: number, fields = {}) => ({
  dateTimeUTC: new Date(start + at * hour).toISOString(),
  flowRateDays: minutesPerInch / 120,
  recoveryInches: 12,
  timeDifDays: 1,
  ...fields,
});
const baseline = [0, 12, 24, 36, 48].map(at => observation(at, 20));
const samples = (rows: ReturnType<typeof observation>[]) => recentFlowSamples(
  Object.fromEntries(rows.map((row, index) => [String(index), row])));
const estimate = (...rows: ReturnType<typeof observation>[]) => averageFlowRates(samples(rows)) * 120;

test('three distinct, recent and consistent slow recoveries still reset AFR', () => {
  expect(estimate(...baseline, observation(60, 80), observation(72, 90), observation(84, 100)))
    .toBeCloseTo(90.4);
});

test('three slow strikes spread across more than 72 hours cannot reset AFR', () => {
  expect(estimate(...baseline, observation(72, 80), observation(120, 90), observation(168, 100)))
    .toBeCloseTo(20);
});

test('three consecutive same-direction outliers must agree in size', () => {
  expect(estimate(...baseline, observation(60, 491.6), observation(72, 59.75), observation(84, 600.52)))
    .toBeCloseTo(20);
});

test('a shallow gauge rise or an overlong interval breaks the strike streak', () => {
  const slow = [observation(60, 80), observation(72, 90)];
  expect(estimate(...baseline, ...slow, observation(84, 100, {recoveryInches: 2}))).toBeCloseTo(20);
  expect(estimate(...baseline, ...slow, observation(84, 100, {timeDifDays: 5}))).toBeCloseTo(20);
});

test.each([[12, 24], [36, 48]])(
  'an outage lasting %s hours requires %s hours to settle before a full recovery interval',
  (downtime, settling) => {
    const restart = 60 + downtime;
    const rows = [...baseline,
      observation(60, 0, {afrWellDown: true}),
      observation(restart, 490, {afrWellDown: false}),
      observation(restart + settling - 1, 5, {timeDifDays: 0.25}),
      observation(restart + settling, 0, {timeDifDays: 1 / 24}),
      observation(restart + settling + 12, 25, {timeDifDays: 0.5}),
    ];
    expect(samples(rows).slice(baseline.length).map(sample => sample.rate * 120)).toEqual([25]);
  },
);

test('duplicate readings cannot provide multiple strikes', () => {
  expect(estimate(...baseline, observation(60, 80), observation(72, 90), observation(72, 90)))
    .toBeCloseTo(20);
});
