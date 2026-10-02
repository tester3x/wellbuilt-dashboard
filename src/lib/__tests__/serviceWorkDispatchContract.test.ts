import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalJobTypeIdForServiceType,
  executeServiceWorkWorkflow,
  createServiceWorkWorkflow,
} from '../serviceWorkWorkflowCore';
import { buildCreatePayload, DispatchCreationCoordinator } from '../staffWriteDispatchCore';
import { matchWellInPool, WellResponse } from '../wellPoolCore';

test('SW dispatch contract: canonicalJobTypeIdForServiceType maps standard service subtypes to service-work', () => {
  // All standard service subtypes must map to 'service-work' for water-hauling revision 4 compatibility
  assert.equal(canonicalJobTypeIdForServiceType('Hot Shot'), 'service-work');
  assert.equal(canonicalJobTypeIdForServiceType('Equipment Delivery'), 'service-work');
  assert.equal(canonicalJobTypeIdForServiceType('Tank Cleanout'), 'service-work');
  assert.equal(canonicalJobTypeIdForServiceType('Rig Move'), 'service-work');
  assert.equal(canonicalJobTypeIdForServiceType('Other'), 'service-work');
  assert.equal(canonicalJobTypeIdForServiceType('Maintenance'), 'service-work');

  // Built-in package types stay themselves
  assert.equal(canonicalJobTypeIdForServiceType('pw'), 'pw');
  assert.equal(canonicalJobTypeIdForServiceType('fresh-water'), 'fresh-water');
  assert.equal(canonicalJobTypeIdForServiceType('flowback-water'), 'flowback-water');
  assert.equal(canonicalJobTypeIdForServiceType('service-work'), 'service-work');
});

test('SW dispatch contract: custom job types from company configuration are respected', () => {
  const customTypes = [
    { label: 'Hot Oiler', slug: 'hot-oiler' },
    { label: 'Chemical Treater', id: 'chem-treater' },
    'Winch Truck',
  ];

  assert.equal(canonicalJobTypeIdForServiceType('Hot Oiler', customTypes), 'hot-oiler');
  assert.equal(canonicalJobTypeIdForServiceType('Chemical Treater', customTypes), 'chem-treater');
  assert.equal(canonicalJobTypeIdForServiceType('Winch Truck', customTypes), 'winch-truck');
  // Unregistered subtype still falls back to 'service-work'
  assert.equal(canonicalJobTypeIdForServiceType('Hot Shot', customTypes), 'service-work');
});

test('SW dispatch contract: buildCreatePayload normalizes custom packageId to water-hauling and sets service-work jobTypeId', () => {
  const payload = buildCreatePayload({
    jobType: 'service',
    wellName: 'Gabriel 5',
    ndicWellName: 'GABRIEL 5-28-33H',
    serviceType: 'Hot Shot',
    packageId: 'custom',
    driverHash: 'hash123',
    driverName: 'Mike Burger',
    assignedBy: 'dispatcher@test.com',
  });

  assert.equal((payload.packetRef as any)?.packageId, 'water-hauling', 'Package custom must normalize to water-hauling');
  const rec = payload.record as Record<string, unknown>;
  assert.equal(rec.jobType, 'service');
  assert.equal(rec.serviceType, 'Hot Shot');
  assert.equal(rec.jobTypeId, 'service-work');
  assert.equal(rec.wellName, 'Gabriel 5');
  assert.equal(rec.driverHash, 'hash123');
});

test('SW dispatch contract: executeServiceWorkWorkflow produces single-driver payload with correct WB-T shape', async () => {
  const workflow = createServiceWorkWorkflow();
  const dispatchesCreated: Array<{ payload: Record<string, unknown> }> = [];

  const mockInvoke = async (params: Record<string, unknown>) => {
    dispatchesCreated.push({ payload: params });
    return { ok: true, dispatchId: 'disp_1' };
  };

  const coordinator = new DispatchCreationCoordinator();

  let completed = false;

  await executeServiceWorkWorkflow({
    workflow,
    coordinator,
    invoke: mockInvoke as any,
    selectedDrivers: [{ key: 'drv_hash_1', id: 'drv_1', legalName: 'John Doe', displayName: 'John' }],
    wellName: 'Gabriel 5',
    ndicWellName: 'GABRIEL 5-28-33H',
    serviceType: 'Equipment Delivery',
    packageId: 'custom',
    dropoff: 'Charlson SWD',
    onsiteBy: '2026-10-02T14:00',
    notes: 'Haul casing tools',
    isSplitTicket: false,
    isHeavyWater: false,
    assignedBy: 'lead@test.com',
    onUiComplete: async () => { completed = true; },
  });

  assert.equal(completed, true);
  assert.equal(dispatchesCreated.length, 1);
  const sent = dispatchesCreated[0].payload;
  assert.equal(sent.op, 'create');
  assert.equal((sent.packetRef as any)?.packageId, 'water-hauling');
  const rec = sent.record as Record<string, unknown>;
  assert.equal(rec.jobType, 'service');
  assert.equal(rec.serviceType, 'Equipment Delivery');
  assert.equal(rec.jobTypeId, 'service-work');
  assert.equal(rec.wellName, 'Gabriel 5');
  assert.equal(rec.ndicWellName, 'GABRIEL 5-28-33H');
  assert.equal(rec.disposal, 'Charlson SWD');
  assert.equal(rec.onsiteBy, '2026-10-02T14:00');
  assert.equal(rec.notes, 'Haul casing tools');
});

test('SW dispatch contract: multi-driver workflow generates shared serviceGroupId across all drivers', async () => {
  const workflow = createServiceWorkWorkflow();
  const dispatchesCreated: Array<{ payload: Record<string, unknown> }> = [];

  const mockInvoke = async (params: Record<string, unknown>) => {
    dispatchesCreated.push({ payload: params });
    return { ok: true, dispatchId: `disp_${dispatchesCreated.length}` };
  };

  const coordinator = new DispatchCreationCoordinator();

  const drivers = [
    { key: 'drv_1', id: 'driver_a', displayName: 'Driver A' },
    { key: 'drv_2', id: 'driver_b', displayName: 'Driver B' },
  ];

  await executeServiceWorkWorkflow({
    workflow,
    coordinator,
    invoke: mockInvoke as any,
    selectedDrivers: drivers,
    wellName: 'Thor 1',
    ndicWellName: 'THOR 1-24-13H',
    serviceType: 'Tank Cleanout',
    assignedBy: 'lead@test.com',
    onUiComplete: async () => {},
  });

  assert.equal(dispatchesCreated.length, 2);
  const rec1 = dispatchesCreated[0].payload.record as Record<string, unknown>;
  const rec2 = dispatchesCreated[1].payload.record as Record<string, unknown>;

  assert.ok(rec1.serviceGroupId, 'Driver 1 must have serviceGroupId');
  assert.equal(rec1.serviceGroupId, rec2.serviceGroupId, 'Both drivers must share serviceGroupId');
  assert.equal(rec1.jobType, 'service');
  assert.equal(rec2.jobType, 'service');
  assert.equal(rec1.jobTypeId, 'service-work');
  assert.equal(rec2.jobTypeId, 'service-work');
  assert.equal(rec1.serviceType, 'Tank Cleanout');
  assert.equal(rec2.serviceType, 'Tank Cleanout');
});

test('Unrouted and Slawson ticket filtering: tickets performed outside active routes are retained', () => {
  const poolWells: WellResponse[] = [
    {
      wellName: 'Gabriel 5',
      ndicName: 'GABRIEL 5-28-33H',
      route: 'East Route',
      currentLevel: '10\'0"',
      etaToMax: '',
      flowRate: '1.2',
      timestamp: '',
      tanks: 2,
      pullBbls: 140,
    },
    {
      wellName: 'Federal 1',
      ndicName: 'FEDERAL 1-12-14H',
      route: 'North Route',
      currentLevel: '8\'0"',
      etaToMax: '',
      flowRate: '0.8',
      timestamp: '',
      tanks: 1,
      pullBbls: 140,
    },
    {
      wellName: 'Nelson 1-12',
      ndicName: 'NELSON 1-12H',
      route: 'Unrouted', // In well_config, but on Unrouted route
      currentLevel: '5\'0"',
      etaToMax: '',
      flowRate: '0.5',
      timestamp: '',
      tanks: 1,
      pullBbls: 140,
    },
    {
      wellName: 'Standby 4',
      route: '', // Blank route = unrouted
      currentLevel: '--',
      etaToMax: '',
      flowRate: '',
      timestamp: '',
      tanks: 1,
      pullBbls: 140,
    },
  ];

  // Active routed wells (exclude 'Unrouted' and empty/blank routes)
  const routedWells = poolWells.filter(
    (w) => w.route && w.route.trim() && w.route.trim().toLowerCase() !== 'unrouted'
  );

  assert.equal(routedWells.length, 2, 'Only East Route and North Route are active routes');

  const tickets = [
    { id: 't1', ticketNumber: '1001', location: 'Gabriel 5' },
    { id: 't2', ticketNumber: '1002', location: 'GABRIEL 5-28-33H' },
    { id: 't3', ticketNumber: '1003', location: 'Nelson 1-12' },
    { id: 't4', ticketNumber: '1004', location: 'Slawson Federal 2-14H' },
    { id: 't5', ticketNumber: '1005', location: 'Slawson Wolverine 1-22' },
    { id: 't6', ticketNumber: '1006', location: 'Standby 4' },
    { id: 't7', ticketNumber: '1007', location: 'Federal 1' },
  ];

  const unroutedTickets = tickets.filter((t) => {
    if (!t.location || !t.location.trim()) return false;
    const isRouted = Boolean(matchWellInPool(routedWells, t.location));
    return !isRouted;
  });

  const unroutedTicketNumbers = unroutedTickets.map((t) => t.ticketNumber);

  // Tickets for routed wells (Gabriel 5, Federal 1) must be excluded
  assert.equal(unroutedTicketNumbers.includes('1001'), false, 'Gabriel 5 on East Route must be excluded');
  assert.equal(unroutedTicketNumbers.includes('1002'), false, 'GABRIEL 5 NDIC on East Route must be excluded');
  assert.equal(unroutedTicketNumbers.includes('1007'), false, 'Federal 1 on North Route must be excluded');

  // Tickets for Unrouted wells (Nelson 1-12, Standby 4) must be INCLUDED
  assert.equal(unroutedTicketNumbers.includes('1003'), true, 'Nelson 1-12 on Unrouted route must be included');
  assert.equal(unroutedTicketNumbers.includes('1006'), true, 'Standby 4 with no route must be included');

  // Tickets for unconfigured wells (Slawson wells) must be INCLUDED
  assert.equal(unroutedTicketNumbers.includes('1004'), true, 'Slawson Federal 2-14H must be included');
  assert.equal(unroutedTicketNumbers.includes('1005'), true, 'Slawson Wolverine 1-22 must be included');
});

test('Tenant containment safety: missing companyId cannot yield unscoped cross-company list for non-platform admin', async () => {
  const { isPlatformAdmin } = await import('../auth');

  // Scoped user missing companyId (e.g. pending setup or loading glitch)
  const nonAdminUser = { uid: 'u1', role: 'viewer' as const, email: 'viewer@test.com' };
  assert.equal(isPlatformAdmin(nonAdminUser as any), false);

  // Derive query companyId using the exact mobile page gate
  const isPlatform = isPlatformAdmin(nonAdminUser as any);
  const queryCompanyId = (nonAdminUser as any).companyId || (isPlatform ? undefined : '__forbidden_no_company__');
  assert.equal(queryCompanyId, '__forbidden_no_company__', 'Must refuse unscoped cross-company query');

  // Platform admin without companyId
  const adminUser = { uid: 'admin1', role: 'admin' as const, email: 'admin@wellbuilt.com' };
  assert.equal(isPlatformAdmin(adminUser as any), true);
  const adminIsPlatform = isPlatformAdmin(adminUser as any);
  const adminQueryId = (adminUser as any).companyId || (adminIsPlatform ? undefined : '__forbidden_no_company__');
  assert.equal(adminQueryId, undefined, 'Platform admin is permitted global query');

  // Tenant-scoped carrier admin
  const carrierUser = { uid: 'c1', role: 'admin' as const, companyId: 'home-hauling', email: 'boss@homehauling.com' };
  assert.equal(isPlatformAdmin(carrierUser as any), false, 'Tenant admin is NOT platform admin');
  const carrierIsPlatform = isPlatformAdmin(carrierUser as any);
  const carrierQueryId = carrierUser.companyId || (carrierIsPlatform ? undefined : '__forbidden_no_company__');
  assert.equal(carrierQueryId, 'home-hauling', 'Carrier user queries only their companyId');
});
