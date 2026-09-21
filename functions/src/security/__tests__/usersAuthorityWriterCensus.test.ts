import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../../..');
function src(rel: string) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

describe('G-010 users authority writers', () => {
  it('registerWithEmail no longer sets users/{uid} role/companyId', () => {
    const auth = src('src/lib/auth.ts');
    expect(auth).toMatch(/requestCompanyOnboarding/);
    expect(auth).not.toMatch(/set\(ref\(db,\s*`users\/\$\{[^}/]+\}`\s*,/);
    expect(auth).not.toMatch(/role: 'viewer'/);
    expect(auth).toMatch(/requestCompanyOnboarding/);
  });

  it('DriversTab role save uses staffWriteUserRoles', () => {
    const tab = src('src/components/admin/DriversTab.tsx');
    expect(tab).toMatch(/staffWriteUserRoles/);
    expect(tab).not.toMatch(/update\(ref\(db,\s*`users\/\$\{uid\}`\)/);
    expect(tab).not.toMatch(/update\(ref\(db,\s*`users\/\$\{driver\.dashboardUid\}`\)/);
  });

  it('CompaniesTab activate uses adminApproveCompanyOnboarding', () => {
    const tab = src('src/components/admin/CompaniesTab.tsx');
    expect(tab).toMatch(/adminApproveCompanyOnboarding/);
    expect(tab).not.toMatch(/users\/\$\{p\.uid\}/);
  });

  it('no Dashboard client writes drivers/profiles', () => {
    const files = [
      'src/lib/auth.ts',
      'src/components/admin/DriversTab.tsx',
      'src/components/admin/CompaniesTab.tsx',
      'src/app/admin/page.tsx',
    ];
    for (const f of files) {
      expect(src(f)).not.toMatch(/drivers\/profiles/);
    }
  });

  it('login backfill writes only child email/displayName paths', () => {
    const auth = src('src/lib/auth.ts');
    expect(auth).toMatch(/users\/\$\{user\.uid\}\/\$\{field\}/);
    expect(auth).not.toMatch(/update\(userRef/);
  });

  it('admin well identity mutations use callables; route uses child set', () => {
    const page = src('src/app/admin/page.tsx');
    expect(page).toMatch(/staffRenameWellConfig/);
    expect(page).toMatch(/staffDeleteWellConfig/);
    expect(page).toMatch(/well_config\/\$\{wellName\}\/route/);
    expect(page).not.toMatch(/update\(ref\(db\),\s*updates\)/);
    expect(page).not.toMatch(/set\(ref\(db,\s*`well_config\/\$\{selectedWell\}`\)/);
    expect(page).not.toMatch(/remove\(ref\(db,\s*`well_config\/\$\{/);
  });

  it('DriversTab role save awaits callable, shows error, has no users RTDB fallback', () => {
    const tab = src('src/components/admin/DriversTab.tsx');
    const save = tab.slice(tab.indexOf('const saveEmployeeRoles'), tab.indexOf('const toggleDriverActive'));
    expect(save).toMatch(/await staffWriteUserRoles/);
    expect(save.indexOf('await staffWriteUserRoles')).toBeGreaterThan(-1);
    expect(save.indexOf("setMessage('Roles updated')")).toBeGreaterThan(save.indexOf('await staffWriteUserRoles'));
    expect(save).toMatch(/classifyUserRolesError/);
    expect(save).not.toMatch(/update\(ref\(db/);
    expect(save).not.toMatch(/set\(ref\(db/);
    const revoke = tab.slice(tab.indexOf('const handleRolePick'), tab.indexOf('const handleInviteSubmit'));
    expect(revoke).toMatch(/staffWriteUserRoles\(\{ targetUid: driver\.dashboardUid, roles: \['driver'\] \}\)/);
    expect(revoke.indexOf("setMessage(`Dashboard access removed")).toBeGreaterThan(revoke.indexOf('staffWriteUserRoles'));
    expect(revoke).toMatch(/Failed to remove dashboard access/);
    const client = src('src/lib/staffWriteUserRoles.ts');
    expect(client).toMatch(/targetUid: input\.targetUid/);
    expect(client).toMatch(/roles: input\.roles/);
    expect(client).not.toMatch(/companyId: input/);
    expect(client).not.toMatch(/targetCompanyId/);
    expect(client).not.toMatch(/firebase\/database/);
  });
});
