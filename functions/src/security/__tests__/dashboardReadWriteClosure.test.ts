import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '../../../..');

function src(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

describe('remaining RTDB parent-read closure', () => {
  it('does not parent-get drivers/approved from Chat, Mobile, Well, Billing, Payroll, Logs, or Dispatch', () => {
    const files = [
      'src/app/chat/page.tsx',
      'src/app/mobile/page.tsx',
      'src/app/well/page.tsx',
      'src/app/billing/page.tsx',
      'src/app/payroll/page.tsx',
      'src/app/driverlogs/page.tsx',
      'src/app/dispatch/page.tsx',
    ];
    for (const file of files) {
      expect(src(file)).not.toMatch(/['"]drivers\/approved['"]/);
    }
  });

  it('well pool and live status go through Admin callables', () => {
    expect(src('src/lib/wells.ts')).toContain('adminGetWellPool');
    expect(src('src/lib/wells.ts')).toContain('adminGetWellHistory');
    expect(src('src/lib/wells.ts')).toContain('adminGetWellPerformance');
    expect(src('functions/src/security/adminDashboardCatalog.ts')).toContain('adminGetWellPool');
    expect(src('functions/src/security/adminDashboardCatalog.ts')).toContain('packets/outgoing');
  });

  it('pending driver parent reads have a catalog fallback', () => {
    expect(src('src/components/admin/DriversTab.tsx')).toContain('catalog.pending');
    expect(src('src/components/AppHeader.tsx')).toContain('adminGetDashboardCatalog');
    expect(src('src/components/NotificationBell.tsx')).toContain('adminGetDashboardCatalog');
  });
});

describe('dispatch direct-write inventory', () => {
  const page = src('src/app/dispatch/page.tsx');

  it('does not write dispatches through client updateDoc/addDoc/setDoc/deleteDoc', () => {
    expect(page).not.toMatch(/updateDoc\(doc\(firestore, 'dispatches'/);
    expect(page).not.toMatch(/addDoc\(collection\(firestore, 'dispatches'/);
    expect(page).not.toMatch(/setDoc\(doc\(firestore, 'dispatches'/);
    expect(page).not.toMatch(/deleteDoc\(doc\(firestore, 'dispatches'/);
    expect(page).not.toMatch(/status: 'dismissed'[\s\S]{0,80}\.catch\(\(\) => \{\}\)/);
  });

  it('uses governed staffWriteDispatch and dismissDispatch callables', () => {
    expect(page).toContain('staffCreateDispatch');
    expect(page).toContain('staffUpdateDispatch');
    expect(page).toContain('staffCancelDispatch');
    expect(page).toContain('onDismissDeclined={dismissDeclinedDispatch}');
    expect(page).toContain('onDismiss={onDismissDeclined}');
  });
});

describe('well-config allowlist contract', () => {
  it('projects wellConfig through canViewGlobalWellPool, not tenant companyId', () => {
    const projection = src('functions/src/security/dashboardCatalogProjection.ts');
    expect(projection).toContain('callerCanViewGlobalWellPool');
    expect(projection).toContain('activeTanks');
    expect(projection).toContain('equalizedTanks');
    expect(projection).toContain('requireActualBottom');
    expect(projection).toMatch(/const wellConfig = canViewWellPool/);
  });
});
