import { assertIndependentJobMutable, independentJobTransition, parseIndependentJob } from '../independentDispatchJobs';

describe('Independent Dispatch job validation and lifecycle', () => {
  const job = { title: 'Pipe delivery', customer: 'Customer', pickup: 'Yard', destination: 'Site' };
  it('supports jobs without wells, water, accounts, or ticket fields', () => {
    expect(parseIndependentJob(job)).toEqual({ ...job, reference: '', cargo: '', scheduledAt: '', notes: '' });
  });
  it('rejects injected tenant, status, and identity fields', () => {
    for (const field of ['companyId', 'driverId', 'status', 'revision', 'wellName', '__proto__']) {
      const raw = JSON.parse(JSON.stringify(job));
      Object.defineProperty(raw, field, { value: 'forged', enumerable: true });
      expect(() => parseIndependentJob(raw)).toThrow();
    }
  });
  it('requires actual locations and customer, limits notes, and validates UTC dates', () => {
    expect(() => parseIndependentJob({ ...job, pickup: '  ' })).toThrow('required_pickup');
    expect(() => parseIndependentJob({ ...job, notes: 'a'.repeat(4001) })).toThrow();
    expect(() => parseIndependentJob({ ...job, scheduledAt: '2026-02-30T12:00:00.000Z' })).toThrow();
    expect(parseIndependentJob({ ...job, scheduledAt: '2026-11-20T12:00:00.000Z' }).scheduledAt).toContain('2026-11-20');
  });
  it('cannot complete unassigned work or reopen terminal jobs', () => {
    expect(independentJobTransition('unassigned', 'completed')).toBe(false);
    expect(independentJobTransition('assigned', 'in_progress')).toBe(true);
    expect(independentJobTransition('in_progress', 'completed')).toBe(true);
    expect(independentJobTransition('completed', 'assigned')).toBe(false);
    expect(independentJobTransition('cancelled', 'assigned')).toBe(false);
    expect(() => assertIndependentJobMutable('in_progress')).toThrow();
  });
});
