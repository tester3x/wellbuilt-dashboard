import { hasDriverAssignmentConflict } from '../independentDriverAvailability';

const now = Date.parse('2026-11-22T10:00:00.000Z');
const target = { id: 'new', scheduledAt: '2026-11-23T08:00:00.000Z', estimatedEndAt: '2026-11-23T12:00:00.000Z' };
const current = { id: 'first', status: 'in_progress', externalDriverId: 'driver-a',
  scheduledAt: '2026-11-22T08:00:00.000Z', estimatedEndAt: '2026-11-23T07:00:00.000Z' };

describe('Independent Dispatch driver assignment conflicts', () => {
  it('allows a later job only after a known finish', () => {
    expect(hasDriverAssignmentConflict(target, 'outside:driver-a', [current], now)).toBe(false);
    expect(hasDriverAssignmentConflict({ ...target, scheduledAt: '2026-11-23T06:00:00.000Z' }, 'outside:driver-a', [current], now)).toBe(true);
  });
  it('allows planning after a known pending finish and blocks a known overlap', () => {
    expect(hasDriverAssignmentConflict(target, 'outside:driver-a', [{ ...current, status: 'assigned' }], now)).toBe(false);
    expect(hasDriverAssignmentConflict({ ...target, scheduledAt: '2026-11-23T06:00:00.000Z' },
      'outside:driver-a', [{ ...current, status: 'assigned' }], now)).toBe(true);
    expect(hasDriverAssignmentConflict(target, 'outside:driver-a', [{ ...current, status: 'assigned', estimatedEndAt: '' }], now)).toBe(false);
    expect(hasDriverAssignmentConflict(target, 'outside:driver-a', [{ ...current, status: 'assigned', ongoing: true }], now)).toBe(true);
  });
  it('holds a driver with an unknown, passed, or ongoing finish until completion', () => {
    expect(hasDriverAssignmentConflict(target, 'outside:driver-a', [{ ...current, estimatedEndAt: '' }], now)).toBe(true);
    expect(hasDriverAssignmentConflict(target, 'outside:driver-a', [{ ...current, estimatedEndAt: '2026-11-22T09:00:00.000Z' }], now)).toBe(true);
    expect(hasDriverAssignmentConflict(target, 'outside:driver-a', [{ ...current, ongoing: true }], now)).toBe(true);
    expect(hasDriverAssignmentConflict(target, 'outside:driver-a', [{ ...current, ongoing: true, status: 'completed' }], now)).toBe(false);
  });
  it('checks WellBuilt drivers and ignores other drivers and the target job', () => {
    const linked = { ...current, externalDriverId: '', wbDriverId: 'wb-a', status: 'in_progress', estimatedEndAt: '' };
    expect(hasDriverAssignmentConflict(target, 'wellbuilt:wb-a', [linked], now)).toBe(true);
    expect(hasDriverAssignmentConflict(target, 'outside:driver-a', [linked], now)).toBe(false);
    expect(hasDriverAssignmentConflict({ ...target, id: 'first' }, 'wellbuilt:wb-a', [linked], now)).toBe(false);
  });
});
