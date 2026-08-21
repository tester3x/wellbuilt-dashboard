import { readFileSync } from 'fs';
import { join } from 'path';

describe('adminGetDashboardCatalog recovery surface', () => {
  const callable = readFileSync(join(__dirname, '../adminDashboardCatalog.ts'), 'utf8');
  const drivers = readFileSync(join(__dirname, '../../../../src/components/admin/DriversTab.tsx'), 'utf8');
  const adminPage = readFileSync(join(__dirname, '../../../../src/app/admin/page.tsx'), 'utf8');
  const gps = readFileSync(join(__dirname, '../../../../src/components/admin/GpsRoutesTab.tsx'), 'utf8');
  const helper = readFileSync(join(__dirname, '../../../../src/lib/adminDashboardCatalog.ts'), 'utf8');
  const dispatchPage = readFileSync(join(__dirname, '../../../../src/app/dispatch/page.tsx'), 'utf8');
  const billingPage = readFileSync(join(__dirname, '../../../../src/app/billing/page.tsx'), 'utf8');
  const payrollPage = readFileSync(join(__dirname, '../../../../src/app/payroll/page.tsx'), 'utf8');
  const driverLogs = readFileSync(join(__dirname, '../../../../src/app/driverlogs/page.tsx'), 'utf8');

  it('uses Admin SDK parent reads and manageDrivers, not client RTDB', () => {
    expect(callable).toMatch(/requireManageDrivers/);
    expect(callable).toMatch(/drivers\/approved/);
    expect(callable).toMatch(/well_config/);
    expect(callable).toMatch(/ref\('users'\)/);
  });

  it('captures the caller and projects through the scoped allowlist', () => {
    expect(callable).toMatch(/const caller = await requireManageDrivers/);
    expect(callable).toMatch(/const projected = projectDashboardCatalog/);
    expect(callable).toMatch(/caller,/);
    expect(callable).toMatch(/\.\.\.projected/);
    expect(callable).toMatch(/drivers\/pending/);
    expect(callable).toMatch(/packets\/outgoing/);
  });

  it('Employees / Wells / GPS Routes distinguish load failure from empty', () => {
    expect(drivers).toContain('adminGetDashboardCatalog');
    expect(drivers).toMatch(/Failed to load employees \[\$\{catalogErrorCode/);
    expect(adminPage).toContain('Failed to load well catalog');
    expect(gps).toContain('Failed to load GPS route wells');
    expect(helper).toContain("return 'unauthenticated'");
    expect(helper).toContain("return 'permission-denied'");
    expect(helper).toContain("return 'missing-callable'");
    expect(helper).toContain('classifiedReadFailure');
  });

  it('passes dismissDeclinedDispatch into ActiveDispatchPanel and the declined card consumes it', () => {
    expect(dispatchPage).toMatch(/onDismissDeclined=\{dismissDeclinedDispatch\}/);
    expect(dispatchPage).toMatch(/onDismissDeclined\?:\s*\(jobId: string\) => void/);
    expect(dispatchPage).toMatch(/onDismissDeclined\?\.\(job\.id\)/);
    expect(dispatchPage).not.toMatch(/dismissDeclinedDispatch\(job\.id\)/);
  });

  it('remaining Dashboard loaders classify read failure instead of silent zero', () => {
    expect(dispatchPage).toContain('adminGetDashboardCatalog');
    expect(dispatchPage).toContain('classifiedReadFailure');
    expect(billingPage).toContain('adminGetDashboardCatalog');
    expect(billingPage).toContain('classifiedReadFailure');
    expect(payrollPage).toContain('adminGetDashboardCatalog');
    expect(payrollPage).toContain('classifiedReadFailure');
    expect(driverLogs).toContain('adminGetDashboardCatalog');
    expect(driverLogs).toContain('classifiedReadFailure');
  });
});
