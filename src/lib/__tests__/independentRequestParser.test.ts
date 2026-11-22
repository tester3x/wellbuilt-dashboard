import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePastedJobRequest } from '../independentRequestParser.ts';
import type { IndependentDirectory } from '../independentDispatchDirectory.ts';

const directory: IndependentDirectory = {
  ok: true, companyId: 'prairie', sectors: ['water-hauling', 'ltl', 'otr', 'hot-shot', 'aggregate'],
  customers: [
    { id: 'liquid', name: 'Liquid Gold', active: true, phoneE164: '', sectors: ['water-hauling', 'hot-shot'], jobNames: [], pickupLocations: [], deliveryLocations: [] },
    { id: 'freight', name: 'Prairie Freight', active: true, phoneE164: '', sectors: ['ltl', 'otr'], jobNames: [], pickupLocations: [], deliveryLocations: [] },
    { id: 'gravel', name: 'Red Mesa Gravel', active: true, phoneE164: '', sectors: ['aggregate'], jobNames: [], pickupLocations: [], deliveryLocations: [] },
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
  assert.ok(parsed.missing.includes('Delivery location'));
  assert.ok(parsed.missing.includes('Job name'));
  assert.ok(parsed.warnings.some(message => message.includes('not an exact match')));
});

test('sector conflicting with the selected customer is not applied', () => {
  const parsed = parsePastedJobRequest('Customer: Liquid Gold\nSector: Aggregate\nJob: Test\nPickup: A\nDelivery: B', directory);
  assert.equal(parsed.sector, '');
  assert.ok(parsed.warnings.some(message => message.includes('not enabled')));
});
