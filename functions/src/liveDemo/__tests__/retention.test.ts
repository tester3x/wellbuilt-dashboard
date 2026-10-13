import { demoScenariosToPrune, MAX_COMPLETED_DEMO_JOBS } from '../retention';

test('retains at most 24 completed job cards and deletes whole older scenarios', () => {
  const runs = Array.from({ length: 30 }, (_, i) => ({
    id: `demo-${String(i + 1).padStart(6, '0')}`,
    jobCount: i % 7 === 0 ? 3 : i % 5 === 0 ? 2 : 1,
  }));
  const remove = new Set(demoScenariosToPrune(runs));
  expect(runs.filter(run => !remove.has(run.id)).reduce((sum, run) => sum + run.jobCount, 0))
    .toBeLessThanOrEqual(MAX_COMPLETED_DEMO_JOBS);
  expect(remove.has('demo-000001')).toBe(true);
  expect(remove.has('demo-000030')).toBe(false);
});

test('exact cap retains all 24 jobs', () => {
  const runs = Array.from({ length: 24 }, (_, i) => ({ id: `demo-${String(i + 1).padStart(6, '0')}`, jobCount: 1 }));
  expect(demoScenariosToPrune(runs)).toEqual([]);
});
