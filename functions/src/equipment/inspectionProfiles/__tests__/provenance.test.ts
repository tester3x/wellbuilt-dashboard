import { validateInspectionProfileProvenance } from '../provenance';
import type { ProfileManifest } from '../validation';

const published: ProfileManifest = {
  schemaVersion: 1, profileId: 'hot-oiler-v1', revision: 'old_revision', title: 'Hot Oiler',
  equipmentType: 'hot_oiler', source: 'wellbuilt', supportedModes: ['truck_only'],
  catalog: { catalogId: 'hot-oiler-v1', version: 'old_revision', areas: [{ areaId: 'heater',
    label: 'Heater', assetRole: 'truck', sortOrder: 1, items: [{ itemId: 'burner', componentLabel: 'Burner' }] }] },
  areaImages: { heater: 'image1' }, images: [{ imageId: 'image1',
    storagePath: 'equipment-inspection-defaults/hot-oiler-v1/old_revision/image1.jpg',
    sha256: 'a'.repeat(64), byteLength: 400, contentType: 'image/jpeg' }],
};
const reference = () => ({ schemaVersion: 1, companyId: 'acme', profileId: published.profileId,
  revision: published.revision, areaImages: { ...published.areaImages },
  images: published.images.map(image => ({ ...image })) });

test('preserves an exact historical published profile reference', () => {
  expect(validateInspectionProfileProvenance(reference(), 'acme', published)).toEqual(reference());
});

test('rejects foreign company and substituted image content or URL fields', () => {
  expect(() => validateInspectionProfileProvenance(reference(), 'other', published)).toThrow('identity mismatch');
  const changed = reference(); changed.images[0].sha256 = 'b'.repeat(64);
  expect(() => validateInspectionProfileProvenance(changed, 'acme', published)).toThrow('image mismatch');
  const extra = reference() as Record<string, unknown>; extra.downloadUrl = 'https://example.test/secret';
  expect(() => validateInspectionProfileProvenance(extra, 'acme', published)).toThrow('Unsupported inspectionProfile field');
});
