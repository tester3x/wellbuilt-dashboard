import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '../../../..');
function src(rel: string) {
  return readFileSync(join(root, rel), 'utf8');
}

/**
 * Live comparison (2026-08-21):
 * RTDB: parent/child writes are false everywhere the live ruleset declares
 * a path (Dashboard email Auth has no wellbuiltAdmin/platformAdminEnabled
 * or staffCompanyId claims).
 * Firestore dispatches: create/update/delete false.
 * firestore.rules.secure (production-shaped lockdown) denies client writes
 * to companies, invoices, tickets, projects, chat, payroll, billing, routes.
 */
describe('complete Dashboard write inventory vs live deny', () => {
  const dispatchPage = src('src/app/dispatch/page.tsx');
  const adminPage = src('src/app/admin/page.tsx');
  const driversTab = src('src/components/admin/DriversTab.tsx');
  const gps = src('src/components/admin/GpsRoutesTab.tsx');
  const billing = src('src/lib/billing.ts');
  const payroll = src('src/lib/payroll.ts');
  const chat = src('src/app/chat/page.tsx');
  const wells = src('src/lib/wells.ts');

  it('dispatch mutations no longer use raw client writes against live deny', () => {
    expect(dispatchPage).not.toMatch(/addDoc\(collection\([^)]*'dispatches'/);
    expect(dispatchPage).not.toMatch(/updateDoc\(doc\([^)]*'dispatches'/);
    expect(dispatchPage).toContain('staffCreateDispatch');
    expect(dispatchPage).toContain('staffCancelDispatch');
    expect(dispatchPage).toContain('dismissDeclinedDispatch');
  });

  it('documents remaining denied RTDB client writes (not executed this pass)', () => {
    expect(adminPage).toMatch(/well_config\/\$\{/);
    expect(adminPage).toMatch(/packets\/processed/);
    expect(adminPage).toMatch(/packets\/outgoing/);
    expect(adminPage).toMatch(/performance\/\$\{/);
    expect(gps).toMatch(/well_config\/\$\{/);
    expect(driversTab).toMatch(/drivers\/approved\/\$\{/);
    expect(driversTab).toMatch(/drivers\/pending\/\$\{/);
    expect(driversTab).toMatch(/users\/\$\{/);
    expect(wells).toMatch(/packets\/incoming\/\$\{/);
  });

  it('project writes go through staffWriteProject; other Firestore writes remain client-denied', () => {
    expect(dispatchPage).toContain('staffCreateProject');
    expect(dispatchPage).toContain('staffUpdateProject');
    expect(dispatchPage).not.toMatch(/addDoc\(collection\(firestore, 'projects'/);
    expect(chat).toMatch(/chat_threads/);
    expect(billing).toMatch(/billing_invoices/);
    expect(payroll).toMatch(/deductions/);
  });

  it('documents remaining denied RTDB/Firestore writes still needing Phase 2 callables', () => {
    expect(chat).toMatch(/chat_threads/);
    expect(chat).toMatch(/chat_monitors/);
    expect(billing).toMatch(/billing_invoices/);
    expect(payroll).toMatch(/deductions/);
    expect(src('src/components/AddPullModal.tsx')).toMatch(/addDoc\(collection\(firestore, 'invoices'/);
    expect(src('src/components/admin/GpsRoutesTab.tsx')).toMatch(/well_config\/\$\{/);
    expect(src('src/lib/secureDriverAdmin.ts')).toContain('adminRejectPendingRegistration');
    expect(src('src/lib/secureDriverAdmin.ts')).toContain('adminCleanupTestIdentity');
    expect(src('functions/src/security/index.ts')).toContain('adminRejectPendingRegistration');
    expect(src('functions/src/security/index.ts')).toContain('adminCleanupTestIdentity');
    const cleanup = src('functions/src/security/adminIdentityCleanupCallable.ts');
    expect(cleanup).not.toMatch(/deleteUser\([^)]+\)\.catch\(\(\) => undefined\)/);
    expect(cleanup).not.toMatch(/pending_credentials[\s\S]{0,80}\.delete\(\)\.catch\(\(\) => undefined\)/);
    expect(cleanup).toContain('partial_cleanup_failed');
    expect(src('functions/src/security/operational/identityCleanup.ts')).toContain('operational_scan_failed');
  });

  it('jsonSafe no longer silently drops arbitrary toMillis objects', () => {
    const helper = src('src/lib/staffWriteDispatch.ts');
    expect(helper).toContain('decline_fields_immutable');
    expect(helper).toContain('seconds');
    expect(helper).toContain('nanoseconds');
    expect(helper).not.toMatch(/toMillis[\s\S]{0,80}continue;\s*out\[key\] = val/);
  });
});
