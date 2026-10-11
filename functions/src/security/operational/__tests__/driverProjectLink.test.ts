import { driverMayJoinProject, pickDriverCreateFields } from '../createDriverDispatch';

const caller = { companyId: 'customer-one', driverId: 'driver-one' };
const project = {
  companyId: 'customer-one', status: 'active', operatorName: 'Operator A',
  dayDriverHashes: ['driver-one'], nightDriverHashes: ['driver-two'],
};

describe('driver-created project dispatch', () => {
  it('carries only the selected project id, then requires active same-company roster membership', () => {
    const picked = pickDriverCreateFields({ projectId: 'proj_123', wellName: 'Pickup', operator: 'Operator A' });
    expect(picked.ok).toBe(true);
    if (!picked.ok) return;
    expect(picked.fields.projectId).toBe('proj_123');
    expect(driverMayJoinProject(project, caller, picked.fields)).toBe(true);
    expect(driverMayJoinProject({ ...project, companyId: 'other' }, caller, picked.fields)).toBe(false);
    expect(driverMayJoinProject({ ...project, status: 'completed' }, caller, picked.fields)).toBe(false);
    expect(driverMayJoinProject({ ...project, dayDriverHashes: [] }, caller, picked.fields)).toBe(false);
    expect(driverMayJoinProject({ ...project, dayDriverHashes: ['old-approved-key'], dayDriverIds: ['driver-one'] }, caller, picked.fields)).toBe(true);
    expect(driverMayJoinProject(project, caller, { ...picked.fields, operator: 'Operator B' })).toBe(false);
  });
});
