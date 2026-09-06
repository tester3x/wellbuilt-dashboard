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

  it('exports getDriverWellConfig, ingestDriverPacket, staffWriteDriverAssignment, and customer-safe identity callables', () => {
    expect(index).toMatch(/getDriverWellConfig,/);
    expect(index).toMatch(/getDriverOutgoingStatus,/);
    expect(index).toMatch(/getDriverWellPerformance,/);
    expect(index).toMatch(/bootstrapWbmSession,/);
    expect(index).toMatch(/ingestDriverPacket,/);
    expect(index).toMatch(/ingestWbmPull,/);
    expect(index).toMatch(/ingestWbmEdit,/);
    expect(index).toMatch(/resolveWbtWellConfig,/);
    expect(index).toMatch(/staffWriteDriverAssignment,/);
    expect(index).toMatch(/staffConvertApprovedDriverSecureLogin,/);
    expect(index).toMatch(/upgradeOwnLegacyDriverLogin,/);
    expect(index).toMatch(/staffHydrateCanonicalIdentity,/);
    expect(index).toMatch(/staffRetireLegacyDriverLogin,/);
    expect(index).toMatch(/getOwnDriverHydration,/);
    expect(securityIndex).toMatch(/getDriverWellConfig/);
    expect(securityIndex).toMatch(/getDriverOutgoingStatus/);
    expect(securityIndex).toMatch(/getDriverWellPerformance/);
    expect(securityIndex).toMatch(/ingestWbmEdit/);
    expect(securityIndex).toMatch(/ingestDriverPacket/);
    expect(securityIndex).toMatch(/resolveWbtWellConfig/);
    expect(securityIndex).toMatch(/staffWriteDriverAssignment/);
    expect(securityIndex).toMatch(/staffConvertApprovedDriverSecureLogin/);
    expect(securityIndex).toMatch(/upgradeOwnLegacyDriverLogin/);
    expect(securityIndex).toMatch(/getOwnDriverHydration/);
  });

  it('does not export nonexistent production callables', () => {
    expect(index).not.toMatch(/submitFieldCommand/);
    expect(index).not.toMatch(/getFieldCommandStatus/);
    expect(index).not.toMatch(/bootstrapDriverSession/);
    expect(index).not.toMatch(/staffProvisionCanonicalWbmDriver/);
    expect(securityIndex).not.toMatch(/submitFieldCommand/);
    expect(securityIndex).not.toMatch(/getFieldCommandStatus/);
    expect(securityIndex).not.toMatch(/bootstrapDriverSession/);
  });

  it('preserves ingestDriverPacket request envelope { packet, driverHash? } with canonical mint key', () => {
    expect(ingest).toMatch(/packet\?: Record<string, unknown>/);
    expect(ingest).toMatch(/driverHash\?: string/);
    expect(ingest).toMatch(/driverId: driver\.driverId/);
    expect(ingest).toMatch(/wbtIncomingPath/);
    expect(ingest).toMatch(/duplicate: true/);
    expect(ingest).not.toMatch(/idem_\$\{/);
  });

  it('getDriverWellConfig uses claims + canonical authority, never drivers/approved', () => {
    expect(wellCfg).toMatch(/requireSecureDriver\(request, \{ allowLegacyHash: false \}\)/);
    const outgoing = read('src/security/operational/getDriverOutgoingStatus.ts');
    expect(outgoing).toMatch(/requireSecureDriver\(request, \{ allowLegacyHash: false \}\)/);
    expect(outgoing).toMatch(/packets\/outgoing/);
    expect(outgoing).toMatch(/authorizedWells/);
    expect(outgoing).not.toMatch(/orderByChild\('companyId'\)/);
    const performance = read('src/security/operational/getDriverWellPerformance.ts');
    expect(performance).toMatch(/requireSecureDriver\(request, \{ allowLegacyHash: false \}\)/);
    expect(performance).toMatch(/enforceAppCheck: false/);
    expect(performance).toMatch(/buildWbmBootstrapSnapshot/);
    expect(performance).toMatch(/performance\/\$\{wellKey\}/);
    expect(performance).not.toMatch(/ref\('performance'\)/);
    expect(performance).not.toMatch(/drivers\/approved/);
    expect(wellCfg).toMatch(/loadCanonicalDriverAuthority/);
    expect(wellCfg).toMatch(/buildWbmBootstrapSnapshot/);
    expect(wellCfg).not.toMatch(/drivers\/approved/);
    expect(wellCfg).toMatch(/HttpsError\('failed-precondition', snap\.eligibilityReason/);
  });

  it('Dashboard route editing cannot write a legacy row while leaving canonical stale', () => {
    const start = driversTab.indexOf('const assignDriverRoutes');
    const body = driversTab.slice(start, start + 1800);
    expect(driversTab).toMatch(/interface CanonicalWbmDriver/);
    expect(driversTab).toMatch(/LEGACY — NOT WB-M AUTHORITY/);
    expect(body).toMatch(/staffWriteDriverAssignment/);
    expect(body).toMatch(/dry-run/);
    expect(body).toMatch(/expectedPreviewContextDigest/);
    expect(driversTab).not.toMatch(/staffConvertApprovedDriverSecureLogin/);
    expect(driversTab).not.toMatch(/set\(ref\(db, `drivers\/approved\/\$\{driver\.key\}`\)/);
    expect(driversTab).toMatch(/shouldInstallPreview/);
    expect(driversTab).toMatch(/applyEnabled\(/);
    expect(body).not.toMatch(/mirrorLegacy/);
    expect(body).not.toMatch(/update\(ref\(/);
    expect(body).not.toMatch(/drivers\/approved\/\$\{/);
  });

  it('staffWriteDriverAssignment apply uses a path-scoped primed transaction, not once() snapshot', () => {
    const body = read('src/security/staffWriteDriverAssignmentCallable.ts');
    const helper = read('src/security/operational/assignmentApplyTransaction.ts');
    expect(body).toMatch(/commitCanonicalAssignmentWrite/);
    expect(body).toMatch(/expectedPreviewContextDigest: expectedContext/);
    expect(body).not.toMatch(/profileRef\.off\('value'\)/);
    expect(helper).toMatch(/profileRef\.on\('value', listener/);
    expect(helper).toMatch(/profileRef\.off\('value', listener\)/);
    expect(helper).not.toMatch(/profileRef\.off\('value'\);/);
    expect(helper.indexOf('try {')).toBeLessThan(helper.indexOf("profileRef.on('value', listener"));
    expect(helper.indexOf("profileRef.on('value', listener")).toBeLessThan(
      helper.indexOf('profileRef.transaction('),
    );
    expect(helper.indexOf('profileRef.transaction(')).toBeLessThan(
      helper.indexOf("profileRef.off('value', listener)"),
    );
    expect(helper.indexOf("profileRef.off('value', listener)")).toBeGreaterThan(helper.indexOf('} finally {'));
    expect(helper).toMatch(/evaluateAssignmentTransaction/);
    expect(helper).not.toMatch(/drivers\/approved/);
    expect(helper).not.toMatch(/let lastDigest|cachedProfile|globalThis/);
  });

  it('WB-T dispatch write modules are untouched on this branch', () => {
    const dispatch = read('src/security/operational/staffWriteDispatch.ts');
    expect(dispatch).toMatch(/evaluateStaffWriteDispatch/);
    expect(dispatch).not.toMatch(/assignedRoutes/);
    expect(dispatch).not.toMatch(/getDriverWellConfig/);
  });

  it('customer-safe hydration never treats UUID as drivers/approved and never accepts client aliases', () => {
    const hydration = read('src/security/getOwnDriverHydration.ts');
    const upgrade = read('src/security/upgradeOwnLegacyDriverLogin.ts');
    const retire = read('src/security/staffRetireLegacyDriverLogin.ts');
    const convert = read('src/security/staffConvertApprovedDriverSecureLogin.ts');
    expect(hydration).toMatch(/drivers\/profiles\/\$\{driver\.driverId\}/);
    expect(hydration).toMatch(/alias_spoof/);
    expect(hydration).toMatch(/allowLegacyHash: false/);
    expect(hydration).not.toMatch(/drivers\/approved\/\$\{driver/);
    expect(upgrade).toMatch(/legacySha256NamePasscode/);
    expect(upgrade).not.toMatch(/raw\.approvedKey/);
    expect(upgrade).toMatch(/currentPasscode/);
    expect(upgrade).toMatch(/newPasscode/);
    expect(retire).toMatch(/evaluateRetirementPreview/);
    expect(retire).toMatch(/evaluateRetirementApplyGate/);
    expect(retire).toMatch(/retirementTerminalAllowsApprovedStamp/);
    expect(retire).toMatch(/commitApprovedRetirementStamp/);
    expect(retire).toMatch(/expectedRowFingerprint/);
    expect(retire).toMatch(/proveRetirementCommit/);
    expect(retire).toMatch(/byApprovedOwnedByDriver/);
    const apply = retire.slice(retire.indexOf("mode === 'dry-run'"));
    expect(apply.indexOf('retirementTerminalAllowsApprovedStamp')).toBeLessThan(
      apply.indexOf('commitApprovedRetirementStamp'),
    );
    expect(apply.indexOf('commitApprovedRetirementStamp')).toBeLessThan(
      apply.indexOf('proveRetirementCommit'),
    );
    expect(retire).not.toMatch(/\.update\(/);
    expect(retire).not.toMatch(/raw\.approvedKey/);
    expect(convert).toMatch(/superseded_by_customer_owned_upgrade/);
    expect(convert).not.toMatch(/runApprovedRowConversion/);
  });
});
