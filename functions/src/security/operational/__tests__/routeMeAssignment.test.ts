import {
  resolveWellAssignment,
  DispatchLike,
} from '../routeMeAssignment';

describe('Route Me Well Assignment State Resolver', () => {
  const well = {
    wellName: 'Federal 4-18',
    wellId: 'well-fed-4-18',
    companyId: 'company-a',
  };

  const callingDriverId = 'drv-123';

  it('resolves unassigned when no active dispatches exist', () => {
    const res = resolveWellAssignment(well, [], callingDriverId);
    expect(res.assignmentState).toBe('unassigned');
    expect(res.muted).toBe(false);
    expect(res.assignee).toBeUndefined();
  });

  it('resolves unassigned if dispatches exist but none are active (e.g. completed)', () => {
    const dispatches: DispatchLike[] = [
      {
        companyId: 'company-a',
        wellId: 'well-fed-4-18',
        driverId: 'drv-456',
        status: 'completed',
      },
    ];
    const res = resolveWellAssignment(well, dispatches, callingDriverId);
    expect(res.assignmentState).toBe('unassigned');
  });

  it('resolves assigned_self when active dispatch matches calling driver', () => {
    const dispatches: DispatchLike[] = [
      {
        companyId: 'company-a',
        wellId: 'well-fed-4-18',
        driverId: callingDriverId,
        driverFirstName: 'Mike',
        status: 'accepted',
      },
    ];
    const res = resolveWellAssignment(well, dispatches, callingDriverId);
    expect(res.assignmentState).toBe('assigned_self');
    expect(res.assignee).toBe('Mike');
    expect(res.muted).toBe(false);
  });

  it('resolves in_ddjd when active dispatch for calling driver has in_ddjd flag', () => {
    const dispatches: DispatchLike[] = [
      {
        companyId: 'company-a',
        wellId: 'well-fed-4-18',
        driverId: callingDriverId,
        driverFirstName: 'Mike',
        status: 'pending',
        in_ddjd: true,
      },
    ];
    const res = resolveWellAssignment(well, dispatches, callingDriverId);
    expect(res.assignmentState).toBe('in_ddjd');
    expect(res.muted).toBe(false);
  });

  it('resolves assigned_other and mutes when active dispatch is for another driver', () => {
    const dispatches: DispatchLike[] = [
      {
        companyId: 'company-a',
        wellId: 'well-fed-4-18',
        driverId: 'drv-999',
        driverFirstName: 'Sarah',
        status: 'in_progress',
      },
    ];
    const res = resolveWellAssignment(well, dispatches, callingDriverId);
    expect(res.assignmentState).toBe('assigned_other');
    expect(res.assignee).toBe('Sarah');
    expect(res.muted).toBe(true);
  });

  it('does not match active dispatch from another company (tenant isolation)', () => {
    const dispatches: DispatchLike[] = [
      {
        companyId: 'company-b',
        wellName: 'Federal 4-18',
        driverId: 'drv-999',
        status: 'accepted',
      },
    ];
    const res = resolveWellAssignment(well, dispatches, callingDriverId);
    expect(res.assignmentState).toBe('unassigned');
  });
});
