import * as admin from 'firebase-admin';
import * as httpsV2 from 'firebase-functions/v2/https';
import { ImageRef, ProfileManifest, safeId, validateManifest } from './validation';

export type InspectionProfileProvenance = {
  schemaVersion: 1;
  companyId: string;
  profileId: string;
  revision: string;
  areaImages: Record<string, string>;
  images: ImageRef[];
};

const invalid = (message: string): never => { throw new httpsV2.HttpsError('invalid-argument', message); };

/** Match a frozen report reference to an immutable published revision, never its live pointer. */
export function validateInspectionProfileProvenance(
  raw: unknown, companyId: string, published: ProfileManifest,
): InspectionProfileProvenance {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('Invalid inspectionProfile');
  const ref = raw as Record<string, unknown>;
  if (Object.keys(ref).some(key => !['schemaVersion', 'companyId', 'profileId', 'revision', 'areaImages', 'images'].includes(key)))
    invalid('Unsupported inspectionProfile field');
  if (ref.schemaVersion !== 1 || ref.companyId !== companyId
    || ref.profileId !== published.profileId || ref.revision !== published.revision)
    invalid('Inspection profile identity mismatch');
  if (!ref.areaImages || typeof ref.areaImages !== 'object' || Array.isArray(ref.areaImages))
    invalid('Invalid inspectionProfile areaImages');
  const areaImages = ref.areaImages as Record<string, unknown>;
  const expectedAreas = Object.keys(published.areaImages);
  if (Object.keys(areaImages).length !== expectedAreas.length
    || expectedAreas.some(areaId => areaImages[areaId] !== published.areaImages[areaId]))
    invalid('Inspection profile areaImages mismatch');
  if (!Array.isArray(ref.images) || ref.images.length !== published.images.length)
    invalid('Inspection profile images mismatch');
  const expectedImages = new Map(published.images.map(image => [image.imageId, image]));
  const seen = new Set<string>();
  for (const entry of ref.images as unknown[]) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) invalid('Invalid inspectionProfile image');
    const image = entry as Record<string, unknown>;
    if (Object.keys(image).some(key => !['imageId', 'storagePath', 'sha256', 'byteLength', 'contentType'].includes(key)))
      invalid('Unsupported inspectionProfile image field');
    const imageId = safeId(image.imageId, 'imageId');
    const expected = expectedImages.get(imageId);
    if (seen.has(imageId) || !expected || image.storagePath !== expected.storagePath
      || image.sha256 !== expected.sha256 || image.byteLength !== expected.byteLength
      || image.contentType !== expected.contentType) invalid('Inspection profile image mismatch');
    seen.add(imageId);
  }
  return {
    schemaVersion: 1, companyId, profileId: published.profileId, revision: published.revision,
    areaImages: { ...published.areaImages }, images: published.images.map(image => ({ ...image })),
  };
}

export async function loadInspectionProfileProvenance(raw: unknown, companyId: string): Promise<InspectionProfileProvenance> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('Invalid inspectionProfile');
  const ref = raw as Record<string, unknown>;
  if (ref.companyId !== companyId) invalid('Inspection profile company mismatch');
  const profileId = safeId(ref.profileId, 'profileId');
  const revision = safeId(ref.revision, 'revision');
  const db = admin.firestore();
  const own = db.collection('equipment_inspection_companies').doc(companyId).collection('profiles').doc(profileId);
  const shared = db.collection('equipment_inspection_defaults').doc(profileId);
  const [ownVersion, sharedVersion] = await Promise.all([
    own.collection('revisions').doc(revision).get(),
    shared.collection('revisions').doc(revision).get(),
  ]);
  const version = ownVersion.exists ? ownVersion : sharedVersion;
  if (!version.exists) throw new httpsV2.HttpsError('not-found', 'Published inspection profile revision not found');
  const published = validateManifest(version.data()?.manifest,
    { ownerCompanyId: ownVersion.exists ? companyId : undefined, published: true });
  return validateInspectionProfileProvenance(raw, companyId, published);
}
