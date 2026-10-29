import { validateManifest, validateImageBytes } from '../validation';

const image = {
  imageId: 'image1', storagePath: 'companies/acme/equipment-inspection-media/image1.jpg',
  sha256: 'a'.repeat(64), byteLength: 400, contentType: 'image/jpeg',
};
const manifest = () => ({
  schemaVersion: 1, profileId: 'hot-oiler-v1', revision: 'r1', title: 'Hot Oiler',
  equipmentType: 'hot_oiler', source: 'company', supportedModes: ['truck_only'],
  catalog: { catalogId: 'hot-oiler-v1', version: 'r1', areas: [{ areaId: 'heater', label: 'Heater',
    assetRole: 'truck', sortOrder: 10, items: [{ itemId: 'burner', componentLabel: 'Burner' }] }] },
  areaImages: { heater: 'image1' }, images: [{ ...image }],
});

test('valid company profile references only its own uploaded media', () => {
  expect(validateManifest(manifest(), { ownerCompanyId: 'acme', published: true }).profileId).toBe('hot-oiler-v1');
  expect(() => validateManifest(manifest(), { ownerCompanyId: 'other', published: true })).toThrow('Invalid image storagePath');
});

test('company fork may retain a versioned WellBuilt photo', () => {
  const fork = manifest();
  fork.images[0].storagePath = 'equipment-inspection-defaults/hot-oiler-v1/r1/image1.jpg';
  expect(validateManifest(fork, { ownerCompanyId: 'acme', published: true }).images[0].imageId).toBe('image1');
  fork.images[0].storagePath = 'equipment-inspection-defaults/hot-oiler-v1/r1/image1.png';
  expect(() => validateManifest(fork, { ownerCompanyId: 'acme' })).toThrow('Invalid image storagePath');
});

test('published areas cannot silently lose photo or inspection items', () => {
  const missing = manifest();
  missing.areaImages = {} as typeof missing.areaImages;
  expect(() => validateManifest(missing, { ownerCompanyId: 'acme', published: true })).toThrow('Every area needs an image');
  const empty = manifest();
  empty.catalog.areas[0].items = [];
  expect(() => validateManifest(empty, { ownerCompanyId: 'acme', published: true })).toThrow('Area requires items');
});

test('rejects duplicate item IDs and arbitrary image paths', () => {
  const duplicate = manifest();
  duplicate.catalog.areas[0].items.push({ itemId: 'burner', componentLabel: 'Duplicate' });
  expect(() => validateManifest(duplicate, { ownerCompanyId: 'acme' })).toThrow('Duplicate itemId');
  const foreign = manifest();
  foreign.images[0].storagePath = 'companies/other/equipment-inspection-media/image1.jpg';
  expect(() => validateManifest(foreign, { ownerCompanyId: 'acme' })).toThrow('Invalid image storagePath');
});

test('item IDs are globally unique across areas', () => {
  const value = manifest();
  value.catalog.areas.push({ areaId: 'pump', label: 'Pump', assetRole: 'truck', sortOrder: 20,
    items: [{ itemId: 'burner', componentLabel: 'Another component' }] });
  expect(() => validateManifest(value, { ownerCompanyId: 'acme' })).toThrow('Duplicate itemId');
});

test('rejects object prototype keys as profile, area, item, and image IDs', () => {
  const makers = [
    () => { const value = manifest(); value.profileId = '__proto__'; value.catalog.catalogId = '__proto__'; return value; },
    () => { const value = manifest(); value.catalog.areas[0].areaId = 'constructor'; return value; },
    () => { const value = manifest(); value.catalog.areas[0].items[0].itemId = 'prototype'; return value; },
    () => { const value = manifest(); value.images[0].imageId = '__proto__'; return value; },
  ];
  for (const make of makers) expect(() => validateManifest(make(), { ownerCompanyId: 'acme' })).toThrow(/Invalid/);
});

test('every supported mode retains applicable truck and trailer coverage', () => {
  const truckMissing = manifest();
  truckMissing.supportedModes = ['truck_only', 'tractor_tanker'];
  truckMissing.catalog.areas[0].assetRole = 'trailer';
  expect(() => validateManifest(truckMissing, { ownerCompanyId: 'acme' })).toThrow('Truck checklist');
  const trailerMissing = manifest();
  trailerMissing.supportedModes = ['tractor_tanker'];
  expect(() => validateManifest(trailerMissing, { ownerCompanyId: 'acme' })).toThrow('Tractor/tanker checklist');
});

test('rejects baked hotspot coordinates in profile rows', () => {
  const value = manifest();
  (value.catalog.areas[0].items[0] as Record<string, unknown>).hotspotId = 'old_number_1';
  expect(() => validateManifest(value, { ownerCompanyId: 'acme' })).toThrow('Unsupported item field');
});

test('rejects arbitrary bytes disguised as JPEG or PNG', () => {
  expect(() => validateImageBytes(Buffer.from('not an image'), 'image/jpeg')).toThrow('Invalid image bytes');
  expect(() => validateImageBytes(Buffer.from([255, 216, 255, 1]), 'image/jpeg')).not.toThrow();
});
