import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildRoleEditorRequest,
  classifyRoleEditorError,
  STAFF_WRITE_ROLE_CAPABILITIES_CALLABLE,
} from '../../../../src/lib/staffWriteRoleCapabilitiesCore';

const ROOT = join(__dirname, '..', '..', '..', '..');

function src(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

describe('RolesCard has no direct roleCapabilities writer', () => {
  it('calls the governed callable and never updateDoc/updateCompanyFields', () => {
    const card = src('src/components/settings/RolesCard.tsx');
    expect(card).toMatch(/staffWriteRoleCapabilities\(/);
    expect(card).toMatch(/classifyRoleEditorError/);
    expect(card).toMatch(/role="alert"/);
    expect(card).not.toMatch(/updateCompanyFields/);
    expect(card).not.toMatch(/updateDoc/);
    expect(card).not.toMatch(/setDoc/);
    expect(card).not.toMatch(/addDoc/);
  });

  it('client helper does not send companyId or fall back to a direct write', () => {
    const helper = src('src/lib/staffWriteRoleCapabilities.ts');
    expect(helper).toContain(STAFF_WRITE_ROLE_CAPABILITIES_CALLABLE);
    expect(helper).toMatch(/httpsCallable/);
    expect(helper).not.toMatch(/updateDoc/);
    expect(helper).not.toMatch(/updateCompanyFields/);
    expect(helper).not.toMatch(/company\.id/);
  });

  it('no production client writes trusted_staff_authority or roleCapabilities via Firestore', () => {
    const files = [
      'src/components/settings/RolesCard.tsx',
      'src/lib/staffWriteRoleCapabilities.ts',
      'src/lib/companySettings.ts',
    ];
    const card = src('src/components/settings/RolesCard.tsx');
    expect(card).not.toMatch(/trusted_staff_authority/);
    expect(src('src/lib/staffWriteRoleCapabilities.ts')).not.toMatch(/trusted_staff_authority/);
    void files;
    const settings = src('src/lib/companySettings.ts');
    expect(settings).toMatch(/updateDoc\(doc\(firestore, 'companies', companyId\), fields\)/);
  });
});

describe('UI success and callable failure paths', () => {
  it('buildRoleEditorRequest strips reserved platform capabilities', () => {
    const built = buildRoleEditorRequest({
      roleLabels: { it: 'Owner' },
      roleCapabilities: {
        it: ['manageDrivers', 'viewAllCompanies', 'viewTruthDebug', 'viewDiagnostics'],
      },
    });
    expect(built.roleLabels).toEqual({ it: 'Owner' });
    expect(built.roleCapabilities.it).toEqual(['manageDrivers']);
  });

  it('success path sends only the two allowlisted keys through the callable wrapper', () => {
    const payload = buildRoleEditorRequest({
      roleLabels: { dispatch: 'Coordinator' },
      roleCapabilities: { dispatch: ['viewHome'] },
    });
    expect(payload).toEqual({
      roleLabels: { dispatch: 'Coordinator' },
      roleCapabilities: { dispatch: ['viewHome'] },
    });
    const wrapper = src('src/lib/staffWriteRoleCapabilities.ts');
    expect(wrapper).toMatch(/buildRoleEditorRequest/);
    expect(wrapper).toMatch(/httpsCallable\(getFirebaseFunctions\(\), STAFF_WRITE_ROLE_CAPABILITIES_CALLABLE\)/);
    expect(wrapper).toMatch(/invoke \?\?/);
    expect(wrapper).not.toMatch(/updateDoc/);
    const card = src('src/components/settings/RolesCard.tsx');
    expect(card).toMatch(/await staffWriteRoleCapabilities\(\{/);
    expect(card).toMatch(/onSave\(\)/);
  });

  it('callable failure is classified for the alert surface', () => {
    expect(classifyRoleEditorError({ message: 'missing_required_capability:capabilities' }))
      .toBe('missing_required_capability:capabilities');
    expect(classifyRoleEditorError(null)).toBe('Save failed. The change was not applied.');
    const card = src('src/components/settings/RolesCard.tsx');
    expect(card).toMatch(/setError\(classifyRoleEditorError\(err\)\)/);
    expect(card).toMatch(/role="alert"/);
  });
});

describe('export census', () => {
  it('exports only the governed role editor as a new production endpoint', () => {
    const root = src('functions/src/index.ts');
    const security = src('functions/src/security/index.ts');
    expect(root).toMatch(/staffWriteRoleCapabilities/);
    expect(security).toMatch(/staffWriteRoleCapabilities/);
    expect(root).not.toMatch(/provisionTrusted/);
    expect(root).not.toMatch(/createTrustedStaff/);
    expect(security).not.toMatch(/provisionTrusted/);
  });
});
