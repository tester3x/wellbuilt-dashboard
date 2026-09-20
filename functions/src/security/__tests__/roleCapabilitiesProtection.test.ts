import { readFileSync } from 'fs';
import { join } from 'path';
import { PROTECTED_COMPANY_KEYS } from '../../admin/adminHandlers';

const ROOT = join(__dirname, '..', '..', '..', '..');

describe('roleCapabilities cannot self-grant manageDrivers', () => {
  it('is present in protectedCompanyKeys / PROTECTED_COMPANY_KEYS', () => {
    const rules = readFileSync(join(ROOT, 'firestore.rules'), 'utf8');
    expect(rules).toMatch(/function protectedCompanyKeys\(\) \{[\s\S]*'roleCapabilities'/);
    expect(PROTECTED_COMPANY_KEYS).toContain('roleCapabilities');
    const pin = readFileSync(join(ROOT, 'firestore-rules-tests', 'protected-company-keys.mjs'), 'utf8');
    expect(pin).toMatch(/'roleCapabilities'/);
  });

  it('existing protected contract keys remain protected', () => {
    expect(PROTECTED_COMPANY_KEYS[0]).toBe('wellbuiltContract');
    for (const key of [
      'contractVersion', 'planId', 'entitlement', 'entitlementOverrides',
      'workPeriodMode', 'workPeriodConfiguration', 'effectiveCapabilities',
      'configurationVersion', 'contractEnforced',
    ]) {
      expect(PROTECTED_COMPANY_KEYS).toContain(key);
    }
  });

  it('G-008 publisher is gated by trusted company-scoped authority, not RTDB roleCapabilities', () => {
    const callable = readFileSync(
      join(ROOT, 'functions', 'src', 'security', 'jobPacketPublishCallable.ts'),
      'utf8',
    );
    expect(callable).toMatch(/requireTrustedCompanyCapability/);
    expect(callable).not.toMatch(/requireManageDrivers/);
    expect(callable).not.toMatch(/roleCapabilities/);
    expect(callable).not.toMatch(/users\/\$\{/);
  });

  it('requireManageDrivers still exists for unrelated paths and still reads RTDB roleCapabilities', () => {
    const auth = readFileSync(join(ROOT, 'functions', 'src', 'security', 'adminAuth.ts'), 'utf8');
    expect(auth).toMatch(/roleCapabilities/);
    expect(auth).toMatch(/requireManageDrivers/);
    expect(auth).toMatch(/users\/\$\{authUid\}/);
    const publisher = readFileSync(
      join(ROOT, 'functions', 'src', 'security', 'jobPacketPublishCallable.ts'),
      'utf8',
    );
    expect(publisher).not.toMatch(/from '\.\/adminAuth'/);
  });

  it('no alternate Firestore company field remains client-writable for manageDrivers', () => {
    const rules = readFileSync(join(ROOT, 'firestore.rules'), 'utf8');
    const start = rules.indexOf('function protectedCompanyKeys()');
    const fn = rules.slice(start, start + 900);
    expect(fn).toMatch(/'roleCapabilities'/);
    expect(rules).toMatch(/allow update: if request\.auth != null\s*&& !request\.resource\.data\.diff\(resource\.data\)\s*\.affectedKeys\(\)\.hasAny\(protectedCompanyKeys\(\)\)/);
  });

  it('reachable RolesCard writer uses the governed callable, not updateDoc', () => {
    const card = readFileSync(join(ROOT, 'src', 'components', 'settings', 'RolesCard.tsx'), 'utf8');
    expect(card).toMatch(/staffWriteRoleCapabilities\(/);
    expect(card).not.toMatch(/updateCompanyFields/);
    expect(card).not.toMatch(/updateDoc/);
    expect(card).toMatch(/roleCapabilities:/);
  });

  it('G-006 inventory remains dormant', () => {
    const store = readFileSync(
      join(ROOT, 'functions', 'src', 'security', 'operational', 'jobPacketRevisionStore.ts'),
      'utf8',
    );
    expect(store).toMatch(/export const SERVER_IMPLEMENTED_EFFECTS: readonly string\[\] = Object\.freeze\(\[\]\);/);
  });
});
