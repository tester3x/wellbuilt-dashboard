import { evaluateStaffWriteDispatch, isDriverBuiltDispatch } from '../staffWriteDispatch';

const access = { callerCompanyId: 'company-test', isPlatformAdmin: false };
const base = { companyId: 'company-test', driverId: 'driver-original', driverHash: 'driver-original', driverName: 'Original Driver', status: 'pending' };

test.each([
  { source: 'driver', assignedBy: 'office@example.test' },
  { assignedBy: 'driver' },
  { assignedBy: 'driver:driver-original' },
])('driver-built ownership survives queue state and origin aliases: %j', origin => {
  for (const status of ['pending', 'accepted', 'declined', 'cancelled', 'in_progress', 'paused']) {
    const job = { ...base, ...origin, status };
    expect(isDriverBuiltDispatch(job)).toBe(true);
    for (const patch of [{ driverId: 'driver-target' }, { driverHash: 'driver-target' },
      { driverName: 'Target Driver' }, { driverFirstName: 'Target' }, { assignedDrivers: ['driver-target'] },
      { reassignedTo: 'Target Driver' }, { intendedDriverHash: 'driver-target' }, { assignedBy: 'office@example.test' }]) {
      // An identical origin value is a no-op, not an origin-stripping attempt.
      if (Object.keys(patch).every(k => (patch as any)[k] === (job as any)[k])) continue;
      expect(evaluateStaffWriteDispatch({ op: 'update', job, record: patch, ...access })).toMatchObject({ ok: false, reason: 'driver_built_job_owned_by_builder' });
      expect(evaluateStaffWriteDispatch({ op: 'update', job, record: patch, ...access, isPlatformAdmin: true })).toMatchObject({ ok: false, reason: 'driver_built_job_owned_by_builder' });
    }
  }
});

test('dispatch-built queued jobs remain reassignable and tenant checks still precede ownership checks', () => {
  expect(evaluateStaffWriteDispatch({ op: 'update', job: { ...base, assignedBy: 'office@example.test' }, record: { driverId: 'driver-target' }, ...access }).ok).toBe(true);
  expect(evaluateStaffWriteDispatch({ op: 'update', job: { ...base, source: 'driver', companyId: 'foreign' }, record: { driverId: 'driver-target' }, ...access })).toMatchObject({ ok: false, reason: 'cross_company' });
  expect(evaluateStaffWriteDispatch({ op: 'update', job: { ...base, source: 'driver' }, record: { driverId: base.driverId }, ...access }).ok).toBe(true);
});
