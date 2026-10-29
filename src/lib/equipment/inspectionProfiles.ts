import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from '../firebase';

export type ProfileImage = { imageId: string; storagePath: string; sha256: string; byteLength: number; contentType: 'image/jpeg' | 'image/png' };
export type InspectionProfile = {
  schemaVersion: 1; profileId: string; revision: string; title: string; equipmentType: string;
  source: 'wellbuilt' | 'company'; supportedModes: ('truck_only' | 'tractor_tanker')[];
  catalog: { catalogId: string; version: string; label?: string; areas: Array<{
    areaId: string; label: string; assetRole: 'truck' | 'trailer'; sortOrder: number;
    items: Array<{ itemId: string; componentLabel: string; description?: string; legacyCategoryId?: string; federalCategoryIds?: string[] }>;
  }> };
  areaImages: Record<string, string>; images: ProfileImage[];
};
export type ProfileSummary = { profileId: string; title: string; equipmentType: string; revision: string;
  source: 'wellbuilt' | 'company'; supportedModes: ('truck_only' | 'tractor_tanker')[] };
export type ProfileSettings = { schemaVersion: 1; companyId: string; canManage: boolean; settingsRevision: string;
  selectedProfileIds: string[]; defaultProfileId: string | null; truckAssignments: Record<string, string>; available: ProfileSummary[] };

async function call<T>(name: string, companyId: string, data: Record<string, unknown> = {}): Promise<T> {
  const response = await httpsCallable(getFirebaseFunctions(), name)({ schemaVersion: 1, companyId, ...data });
  return response.data as T;
}
export const listInspectionProfiles = (companyId: string) => call<ProfileSettings>('listEquipmentInspectionProfiles', companyId);
export const getInspectionProfile = (companyId: string, profileId: string, revision?: string) =>
  call<{ manifest: InspectionProfile; downloads: Record<string, { url: string; expiresAt: string }> }>(
    'getEquipmentInspectionProfile', companyId, { profileId, ...(revision ? { revision } : {}) });
export const saveInspectionSettings = (companyId: string, input: Pick<ProfileSettings, 'settingsRevision' | 'selectedProfileIds' | 'defaultProfileId' | 'truckAssignments'>) =>
  call<ProfileSettings>('saveEquipmentInspectionSettings', companyId, { expectedRevision: input.settingsRevision,
    selectedProfileIds: input.selectedProfileIds, defaultProfileId: input.defaultProfileId, truckAssignments: input.truckAssignments });
export const saveInspectionDraft = (companyId: string, manifest: InspectionProfile, profileId: string | undefined, baseRevision: string | null) =>
  call<{ draftId: string; draftRevision: string }>('saveEquipmentInspectionDraft', companyId,
    { ...(profileId ? { profileId } : {}), baseRevision, manifest });
export const publishInspectionDraft = (companyId: string, draftId: string, expectedDraftRevision: string) =>
  call<{ profileId: string; revision: string }>('publishEquipmentInspectionProfile', companyId,
    { draftId, expectedDraftRevision });

export async function uploadInspectionPhoto(companyId: string, file: File): Promise<ProfileImage> {
  if (file.type !== 'image/jpeg' && file.type !== 'image/png') throw new Error('Use a JPEG or PNG photo');
  if (!file.size || file.size > 8 * 1024 * 1024) throw new Error('Photo must be under 8 MiB');
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const result = await call<{ image: ProfileImage; upload: { url: string; method: 'PUT' } }>(
    'beginEquipmentInspectionPhotoUpload', companyId,
    { contentType: file.type, byteLength: file.size, sha256 });
  const response = await fetch(result.upload.url, { method: 'PUT', body: file,
    headers: { 'Content-Type': file.type, 'x-goog-if-generation-match': '0', 'x-goog-meta-sha256': sha256 } });
  if (!response.ok) throw new Error('Photo upload failed');
  return result.image;
}
