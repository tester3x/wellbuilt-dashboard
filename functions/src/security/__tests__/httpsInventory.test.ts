import { readFileSync } from 'fs';
import { completeInventory, HTTPS_INVENTORY, inventoryByName } from '../httpsInventory';
import { scanHttpsExports } from '../scanHttpsExports';
import { scanDeployedExports } from '../scanDeployedExports';
import { join } from 'path';

describe('HTTPS inventory vs exported functions', () => {
  const srcRoot = join(__dirname, '..', '..');
  const scanned = scanHttpsExports(srcRoot);
  const deployed = scanDeployedExports(readFileSync(join(srcRoot, 'index.ts'), 'utf8'));
  const inventory = completeInventory(deployed);

  it('includes every exported Cloud Function', () => {
    const names = new Set(inventory.map((e) => e.name));
    const missing = scanned.filter((s) => !names.has(s.name)).map((s) => s.name);
    expect(missing).toEqual([]);
  });

  it('does not list names that are not exported', () => {
    const exported = new Set(scanned.map((s) => s.name));
    const extra = inventory.filter((e) => !exported.has(e.name)).map((e) => e.name);
    expect(extra).toEqual([]);
    const staleStatic = HTTPS_INVENTORY.filter((e) => !exported.has(e.name)).map((e) => e.name);
    expect(staleStatic).toEqual([]);
  });

  it('describes addSplitLeg as driver/staff-createDispatch/platform dual', () => {
    const row = inventoryByName('addSplitLeg');
    expect(row?.auth).toBe('callable_auth_required');
    expect(row?.tenant).toBe('driver_or_staff_createDispatch_or_platform_dual');
    expect(row?.status).toBe('secured');
  });

  it('describes issueStorageReadUrl caller classes explicitly', () => {
    const row = inventoryByName('issueStorageReadUrl');
    expect(row?.auth).toBe('callable_auth_required');
    expect(row?.tenant).toBe('driver_or_staff_viewTickets_or_platform_dual');
    expect(row?.status).toBe('secured');
  });

  it('classifies public protocol entry points correctly', () => {
    expect(inventoryByName('authenticateDriver')?.status).toBe('protocol_exception');
    expect(inventoryByName('requestDriverRegistration')?.status).toBe('protocol_exception');
    expect(inventoryByName('ssoExchangeAuthorizationCode')?.status).toBe('protocol_exception');
    expect(inventoryByName('authenticateDriver')?.auth).toBe('public_protocol');
    expect(inventoryByName('demoClassifyLocations')?.auth).toBe('public_protocol');
    expect(inventoryByName('demoClassifyLocations')?.tenant).toBe('public_protocol');
  });

  it('fails closed on previously public mutation surfaces', () => {
    for (const name of [
      'backfillTransferredTickets',
      'createOrFindDispatchThread',
      'triggerDieselFetch',
      'writeDiagnosticLog',
    ]) {
      expect(inventoryByName(name)?.status).toBe('fail_closed_blocker');
    }
  });

  it('has at least 72 entries and matches the index.ts graph', () => {
    expect(inventory.length).toBeGreaterThanOrEqual(72);
    expect(scanned.length).toBe(inventory.length);
    expect(inventory.length).toBe(deployed.length);
  });
});
