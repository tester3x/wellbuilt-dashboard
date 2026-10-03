import { buildAfrIntervals } from '../afr/buildAfrIntervals';
import { computeAfrAuto } from '../afr/afrAutoTransient';
import { AFR_V2_POLICY } from '../afr/afrV2Policy';
const t = Date.parse('2026-10-01T12:00:00Z');
const row = (hours: number, extra = {}) => ({dateTimeUTC: new Date(t + hours * 3600000).toISOString(), tankLevelFeet: 10, bblsTaken: 140, flowRateDays: 0.2, ...extra});
it('uses a zero-rate shutdown as the boundary and ignores its idempotency twin', () => {
  const intervals = buildAfrIntervals({a: row(0, {flowRateDays: 0, wellDown: true}), idem_a: row(0), b: row(24)}, 20);
  expect(intervals).toHaveLength(1);
  expect(intervals[0].priorWellDown).toBe(true);
  expect(computeAfrAuto(intervals, AFR_V2_POLICY).perInterval[0].weight).toBe(0);
});
it('rejects a derived seven-minute interval when its actual boundary is a day earlier', () => {
  const intervals = buildAfrIntervals({a: row(0), b: row(24, {timeDifDays: 7 / 1440})}, 20);
  expect(intervals[1].intervalMs).toBe(0);
});
it('does not append the same already-stored observation again', () => {
  expect(buildAfrIntervals({a: row(0)}, 20, {...row(0), timestamp: t})).toHaveLength(1);
});
it('uses the actual incoming time and the previous haul to evaluate recovery', () => {
  const intervals = buildAfrIntervals({a: row(0)}, 20, {...row(24), key: 'new', timestamp: t + 86400000});
  expect(intervals[1].timestamp).toBe(t + 86400000);
  expect(intervals[1].intervalMs).toBe(86400000);
  expect(intervals[1].bblsTaken).toBe(140);
});

it('starts a fresh operating history after a confirmed shutdown', () => {
  const intervals = buildAfrIntervals({old: row(-24, {flowRateDays: 50}), down: row(0, {wellDown: true, flowRateDays: 0}), restart: row(24), pull: row(48)}, 20);
  expect(intervals.map(i => i.key)).toEqual(['restart', 'pull']);
  const result = computeAfrAuto(intervals, AFR_V2_POLICY);
  expect(result.perInterval[0].weight).toBe(0);
  expect(result.afr).toBeCloseTo(0.2);
});
it('returns zero if every derived interval is unusable', () => {
  const result = computeAfrAuto([{key: 'bad', timestamp: t, flowRateDays: 50, wellDown: true}], AFR_V2_POLICY);
  expect(result.afr).toBe(0);
});
