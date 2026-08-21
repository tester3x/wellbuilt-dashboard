import { readFileSync } from 'fs';
import { join } from 'path';

const functionsRoot = join(__dirname, '../../../..');
const dashboardRoot = join(functionsRoot, '..');

function read(rel: string) {
  return readFileSync(join(functionsRoot, rel), 'utf8');
}

describe('WB-M callable export / contract matrix', () => {
  const index = read('src/index.ts');
  const securityIndex = read('src/security/index.ts');
  const ingest = read('src/security/operational/packetIngest.ts');
  const wellCfg = read('src/security/operational/getDriverWellConfig.ts');
  const driversTab = readFileSync(join(dashboardRoot, 'src/components/admin/DriversTab.tsx'), 'utf8');

  it('exports getDriverWellConfig, ingestDriverPacket, and staffWriteDriverAssignment', () => {
    expect(index).toMatch(/getDriverWellConfig,/);
    expect(index).toMatch(/ingestDriverPacket,/);
    expect(index).toMatch(/ingestWbmPull,/);
    expect(index).toMatch(/staffWriteDriverAssignment,/);
    expect(securityIndex).toMatch(/getDriverWellConfig/);
    expect(securityIndex).toMatch(/ingestDriverPacket/);
    expect(securityIndex).toMatch(/staffWriteDriverAssignment/);
  });

  it('does not export nonexistent production callables', () => {
    expect(index).not.toMatch(/submitFieldCommand/);
    expect(index).not.toMatch(/getFieldCommandStatus/);
    expect(index).not.toMatch(/bootstrapDriverSession/);
    expect(securityIndex).not.toMatch(/submitFieldCommand/);
    expect(securityIndex).not.toMatch(/getFieldCommandStatus/);
    expect(securityIndex).not.toMatch(/bootstrapDriverSession/);
  });

  it('preserves ingestDriverPacket request envelope { packet, driverHash? }', () => {
    expect(ingest).toMatch(/packet\?: Record<string, unknown>/);
    expect(ingest).toMatch(/driverHash\?: string/);
    expect(ingest).toMatch(/packet\.driverId = driver\.driverId/);
    expect(ingest).toMatch(/packets\/incoming\/\$\{key\}/);
    expect(ingest).toMatch(/duplicate: true/);
  });

  it('getDriverWellConfig uses claims + canonical authority, never drivers/approved', () => {
    expect(wellCfg).toMatch(/requireSecureDriver\(request, \{ allowLegacyHash: false \}\)/);
    expect(wellCfg).toMatch(/loadCanonicalDriverAuthority/);
    expect(wellCfg).toMatch(/evaluateWbmWellScope/);
    expect(wellCfg).not.toMatch(/drivers\/approved/);
    expect(wellCfg).toMatch(/HttpsError\('failed-precondition', scope\.reason/);
  });

  it('Dashboard route editing cannot write a legacy row while leaving canonical stale', () => {
    const start = driversTab.indexOf('const assignDriverRoutes');
    const body = driversTab.slice(start, start + 1800);
    expect(driversTab).toMatch(/interface CanonicalWbmDriver/);
    expect(driversTab).toMatch(/LEGACY — NOT WB-M AUTHORITY/);
    expect(body).toMatch(/staffWriteDriverAssignment/);
    expect(body).toMatch(/dry-run/);
    expect(body).toMatch(/expectedAssignmentDigest/);
    expect(body).not.toMatch(/mirrorLegacy/);
    expect(body).not.toMatch(/update\(ref\(/);
    expect(body).not.toMatch(/drivers\/approved\/\$\{/);
  });

  it('WB-T dispatch write modules are untouched on this branch', () => {
    const dispatch = read('src/security/operational/staffWriteDispatch.ts');
    expect(dispatch).toMatch(/evaluateStaffWriteDispatch/);
    expect(dispatch).not.toMatch(/assignedRoutes/);
    expect(dispatch).not.toMatch(/getDriverWellConfig/);
  });
});
