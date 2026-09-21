import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';

const ROOT = join(__dirname, '../../../..');
const SRC = join(ROOT, 'functions', 'src');

function walk(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (/\.ts$/.test(entry.name) && !entry.name.includes('.test.')) acc.push(full);
  }
  return acc;
}

describe('G-011 remaining legacy-authority census', () => {
  it('no Production Water staff callable still uses requireManageDrivers', () => {
    const hits: string[] = [];
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes('requireManageDrivers')) continue;
      hits.push(relative(SRC, file).replace(/\\/g, '/'));
    }
    expect(hits).toEqual(['security/adminAuth.ts']);
    expect(hits.join('\n')).not.toMatch(/dismissDispatch/);
    expect(hits.join('\n')).not.toMatch(/staffWriteDispatch/);
    expect(hits.join('\n')).not.toMatch(/staffWriteDriverAssignment/);
    expect(hits.join('\n')).not.toMatch(/adminDashboardCatalog/);
    expect(hits.join('\n')).not.toMatch(/inviteEmployee/);
    expect(hits.join('\n')).not.toMatch(/companyOnboarding/);
    expect(hits.join('\n')).not.toMatch(/companyBinding/);
    expect(hits.join('\n')).not.toMatch(/driverAuthCallables/);
  });

  it('requirePlatformAdmin remains only on identity-conversion / test-cleanup paths', () => {
    const hits: string[] = [];
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes('requirePlatformAdmin')) continue;
      hits.push(relative(SRC, file).replace(/\\/g, '/'));
    }
    expect(hits.sort()).toEqual([
      'security/adminAuth.ts',
      'security/driverAuthCallables.ts',
      'security/staffConvertApprovedDriverSecureLogin.ts',
      'security/staffHydrateCanonicalIdentity.ts',
      'security/staffRetireLegacyDriverLogin.ts',
    ].sort());
  });

  it('inventory stays empty and packets/incoming client grant is gone', () => {
    const inventory = readFileSync(join(SRC, 'security/operational/jobPacketEffectInventory.ts'), 'utf8');
    expect(inventory).toMatch(/export const POLICY_INVENTORY: readonly PolicyRecord\[\] = freezeDeep\(\[\] as PolicyRecord\[\]\);/);
    expect(inventory).toMatch(/export const IMPLEMENTED_EFFECT_IDS: readonly \[\] = freezeDeep\(\[\] as \[\]\);/);
    const store = readFileSync(join(SRC, 'security/operational/jobPacketRevisionStore.ts'), 'utf8');
    expect(store).toMatch(/export const SERVER_IMPLEMENTED_EFFECTS: readonly string\[\] = Object\.freeze\(\[\]\);/);
    const rules = readFileSync(join(ROOT, 'database.rules.json'), 'utf8');
    expect(rules).toMatch(/"incoming"[\s\S]*?"\.write": false/);
    expect(rules).not.toMatch(/requestType'\.val\(\) === 'pull'/);
  });
});
