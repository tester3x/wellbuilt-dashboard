import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePastedJobRequest } from '../independentRequestParser.ts';
import type { IndependentDirectory } from '../independentDispatchDirectory.ts';

const directory: IndependentDirectory = {
  ok: true, companyId: 'prairie', sectors: ['water-hauling', 'ltl', 'otr', 'hot-shot', 'aggregate'],
  communicationChannels: [], dispatchPhoneE164: '', customers: [
    { id: 'liquid', name: 'Liquid Gold', active: true, phoneE164: '', sectors: ['water-hauling', 'hot-shot'], jobNames: [], pickupLocations: [], deliveryLocations: [] },
    { id: 'freight', name: 'Prairie Freight', active: true, phoneE164: '', sectors: ['ltl', 'otr'], jobNames: [], pickupLocations: [], deliveryLocations: [] },
    { id: 'gravel', name: 'Red Mesa Gravel', active: true, phoneE164: '', sectors: ['aggregate'], jobNames: [], pickupLocations: [], deliveryLocations: [] },
    { id: 'bob', name: "Bob's Hot Shot LLC", alternateNames: ["Bob's", 'BHS'], active: true, phoneE164: '', sectors: ['hot-shot'], jobNames: [], pickupLocations: [], deliveryLocations: [] },
  ],
};

test('water request fills a known customer and leaves creation to the dispatcher', () => {
  const parsed = parsePastedJobRequest(`Customer: Liquid Gold\nSector: Water hauling\nJob: Well 12 production run
Pickup: Well 12 pad\nDrop-off: South SWD\nReference: LG-42\nWater type: Production water\n120 bbl\nPickup time: 11/22/2026 8:30 AM`, directory);
  assert.equal(parsed.customerId, 'liquid');
  assert.equal(parsed.sector, 'water-hauling');
  assert.equal(parsed.fields.title, 'Well 12 production run');
  assert.equal(parsed.fields.pickup, 'Well 12 pad');
  assert.equal(parsed.fields.destination, 'South SWD');
  assert.equal(parsed.fields.reference, 'LG-42');
  assert.equal(parsed.sectorFields.waterType, 'Production water');
  assert.equal(parsed.sectorFields.volumeBbl, '120');
  assert.equal(parsed.scheduledLocal, '2026-11-22T08:30');
  assert.deepEqual(parsed.missing, []);
});

test('extracts an explicit staffing request but never infers drivers from tank volume or a fill deadline', () => {
  const base = 'Customer: Liquid Gold\nSector: Water hauling\nJob: Fill 4 frac tanks\nPickup: Fresh water source\nDelivery: Frac pad\nWater type: Fresh water\nBarrels: 1840';
  assert.equal(parsePastedJobRequest(`${base}\nNeed 3 drivers to keep up with demand`, directory).fields.requestedDriverCount, 3);
  assert.equal(parsePastedJobRequest(`${base}\nRequested drivers: 2`, directory).fields.requestedDriverCount, 2);
  assert.equal(parsePastedJobRequest(`${base}\nSend 4 water trucks`, directory).fields.requestedDriverCount, 4);
  const conflicting = parsePastedJobRequest(`${base}\nNeed 3 drivers today\nNeed 2 drivers tomorrow`, directory);
  assert.equal(conflicting.fields.requestedDriverCount, undefined);
  assert.ok(conflicting.warnings.some(warning => warning.includes('different driver counts')));
  assert.equal(parsePastedJobRequest(`${base}\nFill by Sunday`, directory).fields.requestedDriverCount, undefined);
  assert.equal(parsePastedJobRequest(base, directory).fields.requestedDriverCount, undefined);
});

test('LTL, OTR, hot shot and aggregate use distinct sector fields', () => {
  const cases = [
    ['Customer: Prairie Freight\nSector: LTL\nJob: Parts\nFrom: Fargo dock\nTo: Bismarck yard\nPieces: 12\nPallets: 3\nFreight description: Pump parts', 'ltl', 'pieces', '12'],
    ['Customer: Prairie Freight\nSector: OTR\nJob: Long haul\nPickup: Fargo\nDelivery: Denver\nTrailer: Dry van\nCommodity: Pipe', 'otr', 'trailerType', 'Dry van'],
    ['Customer: Liquid Gold\nSector: Hot shot\nJob: Rush pump\nPickup: Shop\nDelivery: Rig\nUrgency: Same day\nCargo details: Pump skid', 'hot-shot', 'urgency', 'Same day'],
    ['Customer: Red Mesa Gravel\nJob: Gravel delivery\nPickup: Pit\nDelivery: Site\nMaterial: Gravel\nEstimated tons: 24', 'aggregate', 'estimatedTons', '24'],
  ] as const;
  for (const [message, sector, field, value] of cases) {
    const parsed = parsePastedJobRequest(message, directory);
    assert.equal(parsed.sector, sector);
    assert.equal(parsed.sectorFields[field], value);
    assert.deepEqual(parsed.missing, []);
  }
});

test('unknown customer and unclear fields stay unselected and require review', () => {
  const parsed = parsePastedJobRequest('Customer: Unknown Carrier\nSector: LTL\nPickup: Fargo\nPieces: 10', directory);
  assert.equal(parsed.customerId, '');
  assert.ok(parsed.missing.includes('Customer'));
  assert.ok(!parsed.missing.includes('Delivery location'));
  assert.ok(parsed.missing.includes('Job name'));
  assert.ok(parsed.warnings.some(message => message.includes('not in your customer list')));
  assert.equal(parsed.customerLabel, 'Unknown Carrier');
});

test('a unique saved alias fills the official company name', () => {
  for (const name of ["Bob's", 'BHS']) {
    const parsed = parsePastedJobRequest(`Customer: ${name}\nSector: Hot shot\nJob: Pump\nPickup: Yard\nDelivery: Rig\nUrgency: Same day\nCargo details: Pump skid`, directory);
    assert.equal(parsed.customerId, 'bob');
    assert.deepEqual(parsed.customerSuggestions, []);
    assert.ok(parsed.warnings.some(warning => warning.includes("Bob's Hot Shot LLC")));
  }
});

test('close names suggest the official company without silently selecting it', () => {
  const parsed = parsePastedJobRequest("Customer: Bob's Hot Shot\nSector: Hot shot\nJob: Pump\nPickup: Yard\nDelivery: Rig", directory);
  assert.equal(parsed.customerId, '');
  assert.deepEqual(parsed.customerSuggestions, [{ id: 'bob', name: "Bob's Hot Shot LLC", sectorMatch: true }]);
});

test('ROS fills its unique saved owner but remains ambiguous when another company shares it', () => {
  const customers = [...directory.customers,
    { id: 'rapid', name: 'Rapid Oilfield Supply', alternateNames: ['ROS'], active: true as const,
      sectors: ['water-hauling' as const], jobNames: [], pickupLocations: [], deliveryLocations: [] }];
  const one = parsePastedJobRequest('Customer: ROS\nSector: Water hauling\nJob: Load\nPickup: A\nDelivery: B', { ...directory, customers });
  assert.equal(one.customerId, 'rapid');
  assert.deepEqual(one.customerSuggestions, []);
  const real = { id: 'real-ros', name: 'R Oilfield Services', alternateNames: ['ROS'], active: true as const,
    sectors: ['hot-shot' as const], jobNames: [], pickupLocations: [], deliveryLocations: [] };
  const two = parsePastedJobRequest('Customer: ROS\nSector: Hot shot\nJob: Load\nPickup: A\nDelivery: B', { ...directory, customers: [...customers, real] });
  assert.equal(two.customerId, '');
  assert.deepEqual(two.customerSuggestions.map(item => item.id), ['real-ros', 'rapid']);
  assert.deepEqual(two.customerSuggestions.map(item => item.sectorMatch), [true, false]);
});

test('a saved company man and sector can identify the right ROS while preserving the phone received for this job', () => {
  const customers = [...directory.customers,
    { id: 'rapid', name: 'Rapid Oilfield Supply', alternateNames: ['ROS'], active: true as const,
      sectors: ['ltl' as const], contacts: [{ id: 'jane', name: 'Jane Doe', role: 'Company man', phoneE164: '+17015550110' }],
      jobNames: [], pickupLocations: [], deliveryLocations: [] },
    { id: 'workover', name: 'ROS Workover Rigs', active: true as const,
      sectors: ['hot-shot' as const], contacts: [{ id: 'john', name: 'John Wick', role: 'Company man', phoneE164: '+17015550111' }],
      jobNames: [], pickupLocations: [], deliveryLocations: [] },
  ];
  const parsed = parsePastedJobRequest('Customer: ROS\nSector: Hot shot\nCompany man: John Wick\nCompany man phone: 701-555-0199\nJob: Rig move\nPickup: Yard\nDelivery: Rig', { ...directory, customers });
  assert.equal(parsed.customerId, 'workover');
  assert.equal(parsed.fields.jobContactName, 'John Wick');
  assert.equal(parsed.fields.jobContactRole, 'Company man');
  assert.equal(parsed.fields.jobContactPhoneE164, '+17015550199');
  assert.ok(parsed.warnings.some(warning => warning.includes('Assumed +1')));
  const conflict = parsePastedJobRequest('Customer: ROS\nSector: LTL\nCompany man: John Wick\nJob: Freight\nPickup: Yard\nDelivery: Site', { ...directory, customers });
  assert.equal(conflict.customerId, '');
  assert.ok(conflict.warnings.some(warning => warning.includes('different sector')));
});

test('official names match directly unless another customer uses that name as an alias', () => {
  const exact = parsePastedJobRequest('Customer: Liquid Gold\nSector: Water hauling\nJob: Load\nPickup: A\nDelivery: B', directory);
  assert.equal(exact.customerId, 'liquid');
  const colliding = { ...directory, customers: [...directory.customers,
    { id: 'other', name: 'Other Company', alternateNames: ['Liquid Gold'], active: true as const,
      sectors: ['water-hauling' as const], jobNames: [], pickupLocations: [], deliveryLocations: [] }] };
  const ambiguous = parsePastedJobRequest('Customer: Liquid Gold\nSector: Water hauling\nJob: Load\nPickup: A\nDelivery: B', colliding);
  assert.equal(ambiguous.customerId, '');
  assert.deepEqual(ambiguous.customerSuggestions.map(item => item.id), ['liquid', 'other']);
});

test('a company mentioned in unlabelled notes never selects the customer', () => {
  const parsed = parsePastedJobRequest('Job: Deliver for Liquid Gold\nSector: Water hauling\nPickup: Yard\nDelivery: Pad\nWater type: Production water\nBarrels: 120', directory);
  assert.equal(parsed.customerId, '');
  assert.ok(parsed.missing.includes('Customer'));
  assert.equal(parsed.fields.title, 'Deliver for Liquid Gold');
});

test('sector conflicting with an exact customer name leaves the customer unselected for review', () => {
  const parsed = parsePastedJobRequest('Customer: Liquid Gold\nSector: Aggregate\nJob: Test\nPickup: A\nDelivery: B', directory);
  assert.equal(parsed.customerId, '');
  assert.equal(parsed.sector, 'aggregate');
  assert.ok(parsed.warnings.some(message => message.includes('not enabled')));
});

test('real one-line fresh-water request fills only stated facts and flags missing pickup and date', () => {
  const parsed = parsePastedJobRequest('Service : 100 bbls Fresh water from --- take to Thor 2, 3 at 6 am. For Dallas Entertech,Fresh water ticket.', directory);
  assert.equal(parsed.customerLabel, 'Dallas Entertech');
  assert.equal(parsed.customerId, '');
  assert.equal(parsed.sector, 'water-hauling');
  assert.equal(parsed.fields.title, 'Fresh water to Thor 2, 3');
  assert.equal(parsed.fields.pickup, undefined);
  assert.equal(parsed.fields.destination, 'Thor 2, 3');
  assert.equal(parsed.sectorFields.waterType, 'Fresh water');
  assert.equal(parsed.sectorFields.volumeBbl, '100');
  assert.equal(parsed.scheduledLocal, '');
  assert.ok(!parsed.missing.includes('Pickup location'));
  assert.equal(parsed.fields.scheduleText, 'Requested time: 6 am');
  assert.ok(parsed.warnings.some(warning => warning.includes('confirm the date')));
  assert.ok(parsed.fields.notes?.includes('Fresh water ticket'));
});

test('keeps arrival and start instructions in Schedule without inventing a date', () => {
  const parsed = parsePastedJobRequest('Customer: Liquid Gold\nSector: Hot shot\nJob: Hot oiler support\nDelivery: Thor 3\nBe there by 6 AM; job starts at 7 AM', directory);
  assert.equal(parsed.fields.scheduleText, 'Be there by 6 AM; job starts at 7 AM');
  assert.equal(parsed.scheduledLocal, '');
  assert.ok(parsed.warnings.some(warning => warning.includes('confirm the date')));
  assert.ok(!parsed.missing.includes('Job location'));
});

test('extracts a dated arrival time while preserving its meaning', () => {
  const parsed = parsePastedJobRequest('Customer: Liquid Gold\nSector: Hot shot\nJob: Hot oiler support\nDelivery: Thor 3\nBe there by: 11/25/2026 6 AM', directory);
  assert.equal(parsed.fields.scheduleText, 'Be there by: 11/25/2026 6 AM');
  assert.equal(parsed.scheduledLocal, '2026-11-25T06:00');
});

test('two company men and one phone remain unpaired for dispatcher review', () => {
  const parsed = parsePastedJobRequest('Customer: ROS\nCompany man: John Wick/Adam Samuels\nCompany man phone: 701-555-0199\nSector: Hot shot\nJob: Rig move\nPickup: Yard\nDelivery: Rig', directory);
  assert.equal(parsed.fields.jobContactName, undefined);
  assert.equal(parsed.fields.jobContactPhoneE164, undefined);
  assert.ok(parsed.fields.notes?.includes('John Wick/Adam Samuels'));
  assert.ok(parsed.warnings.some(warning => warning.includes('Multiple company men')));
  assert.ok(parsed.warnings.some(warning => warning.includes('could not be paired')));
});

test('mongoose split-ticket request keeps well names intact and does not invent a customer or sector', () => {
  const request = 'Can you help cover this job as soon as possible?\n\nService: 1 load from Daredevil Fed. 2-2-14H to Pad 390(Phazor Fed. 3-1-13H) to fill the treators. Ordered by Brad Holyoak. Pak Energy Split ticket load';
  const parsed = parsePastedJobRequest(request, directory);
  assert.equal(parsed.customerId, '');
  assert.equal(parsed.customerLabel, '');
  assert.equal(parsed.sector, '');
  assert.equal(parsed.fields.title, 'Load to Pad 390(Phazor Fed. 3-1-13H)');
  assert.equal(parsed.fields.pickup, 'Daredevil Fed. 2-2-14H');
  assert.equal(parsed.fields.destination, 'Pad 390(Phazor Fed. 3-1-13H)');
  assert.equal(parsed.fields.jobContactName, 'Brad Holyoak');
  assert.equal(parsed.fields.jobContactRole, 'Requester');
  assert.ok(parsed.fields.notes?.includes('Pak Energy Split ticket load'));
  assert.ok(parsed.fields.notes?.includes('as soon as possible'));
  assert.ok(parsed.missing.includes('Customer'));
  assert.ok(parsed.missing.includes('Transportation sector'));
});
