import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  REQUIRED_CLIENT_ROOT_IDS,
  resolveRequiredClientRoots,
  scanClientCallableUsage,
  scanClientRoots,
  scanDeployedExports,
} from '../scanDeployedExports';
import { scanHttpsExports } from '../scanHttpsExports';
import { completeInventory, HTTPS_INVENTORY } from '../httpsInventory';

const INDEX = join(__dirname, '..', '..', 'index.ts');

describe('authoritative deployed export graph', () => {
  const indexSrc = readFileSync(INDEX, 'utf8');
  const deployed = scanDeployedExports(indexSrc);

  it('includes field-command, SSO, wrap() admin, and comment-hidden re-exports', () => {
    expect(deployed).toEqual(expect.arrayContaining([
      'submitFieldCommand',
      'ssoExchangeAuthorizationCode',
      'inviteEmployee',
      'finalizeStorageUpload',
      'issueStorageReadUrl',
      'adminSyncStaffClaims',
      'upsertPhotoRequirementSpec',
      'adminBindDriverCompany',
      'ingestDriverPacket',
      'verifyDriverSession',
      'adminCreatePlan',
      'adminRetroCloseDriverShift',
    ]));
  });

  it('does not include undeployed client-local names', () => {
    for (const name of [
      'acceptTransferRequest',
      'assignInvoiceBlock',
      'assignTicketBlock',
      'enableRouteRecording',
      'removeSplitLeg',
      'resequenceSplitFamily',
      'resolveTransferRequest',
      'submitTicket',
      'updateTicket',
      'jsaGetReadRequest',
      'jsaCompleteReadRequest',
      'jsaPersistGovernedArtifact',
    ]) {
      expect(deployed).not.toContain(name);
    }
  });

  it('inventory names equal the index.ts export surface', () => {
    const scanned = scanHttpsExports(join(__dirname, '..', '..')).map((s) => s.name).sort();
    expect(scanned).toEqual([...deployed].sort());
    const inventoryNames = completeInventory(deployed).map((e) => e.name).sort();
    const missingFromInventory = deployed.filter((n) => !inventoryNames.includes(n));
    const extraInInventory = HTTPS_INVENTORY.filter((e) => !deployed.includes(e.name)).map((e) => e.name);
    expect({ missingFromInventory, extraInInventory }).toEqual({
      missingFromInventory: [],
      extraInInventory: [],
    });
  });

  it('fails if a reachable client calls a non-exported name', () => {
    const roots = resolveRequiredClientRoots(__dirname);
    const result = scanClientRoots(roots);
    expect(result.skippedMissing).toEqual([]);
    for (const id of REQUIRED_CLIENT_ROOT_IDS) {
      expect(result.scannedRoots).toContain(id);
      expect(result.fileCountByRoot[id]).toBeGreaterThan(0);
    }
    const libFiles = result.fileCountByRoot['dashboard-src-lib'];
    expect(libFiles).toBeGreaterThan(0);
    const missing = result.used.filter((n) => !deployed.includes(n)).sort();
    expect(missing).toEqual([]);
  });

  it('fails if a configured client root is silently skipped', () => {
    const result = scanClientRoots([
      { id: 'missing-root', path: 'D:/dev/does-not-exist-16j' },
    ]);
    expect(result.skippedMissing).toEqual(['missing-root']);
  });

  it('index.ts file exists for the graph', () => {
    expect(existsSync(INDEX)).toBe(true);
    expect(deployed.length).toBeGreaterThan(88);
  });

  it('detects nested multiline httpsCallable(getFunctions(getApp()), name)', () => {
    const suiteish = `
      const callable = httpsCallable(
        getFunctions(getApp()),
        'ssoIssueAuthorizationCode',
        { timeout: 15000 },
      );
    `;
    const jsaish = `
      const callable = httpsCallable(
        getFunctions(getApp()),
        'verifyDriverSession',
        { timeout: JSA_GET_TIMEOUT_MS },
      );
    `;
    expect(scanClientCallableUsage(suiteish)).toContain('ssoIssueAuthorizationCode');
    expect(scanClientCallableUsage(jsaish)).toContain('verifyDriverSession');
  });

  it('fails closed when an export lacks explicit inventory metadata', () => {
    expect(() => completeInventory([...deployed, 'notARealExport_16k'])).toThrow(
      /inventory_missing_explicit_metadata/,
    );
  });
});
