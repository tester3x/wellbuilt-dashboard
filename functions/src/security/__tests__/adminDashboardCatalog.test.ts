import { readFileSync } from 'fs';
import { join } from 'path';

describe('adminGetDashboardCatalog recovery surface', () => {
  const callable = readFileSync(join(__dirname, '../adminDashboardCatalog.ts'), 'utf8');
  const drivers = readFileSync(join(__dirname, '../../../../src/components/admin/DriversTab.tsx'), 'utf8');
  const adminPage = readFileSync(join(__dirname, '../../../../src/app/admin/page.tsx'), 'utf8');
  const gps = readFileSync(join(__dirname, '../../../../src/components/admin/GpsRoutesTab.tsx'), 'utf8');
  const helper = readFileSync(join(__dirname, '../../../../src/lib/adminDashboardCatalog.ts'), 'utf8');

  it('uses Admin SDK parent reads and manageDrivers, not client RTDB', () => {
    expect(callable).toMatch(/requireManageDrivers/);
    expect(callable).toMatch(/drivers\/approved/);
    expect(callable).toMatch(/well_config/);
    expect(callable).toMatch(/ref\('users'\)/);
  });

  it('Employees / Wells / GPS Routes distinguish load failure from empty', () => {
    expect(drivers).toContain('adminGetDashboardCatalog');
    expect(drivers).toMatch(/Failed to load employees \[\$\{catalogErrorCode/);
    expect(adminPage).toContain('Failed to load well catalog');
    expect(gps).toContain('Failed to load GPS route wells');
    expect(helper).toContain("return 'unauthenticated'");
    expect(helper).toContain("return 'permission-denied'");
    expect(helper).toContain("return 'missing-callable'");
  });
});
