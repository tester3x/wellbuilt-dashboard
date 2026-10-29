import * as httpsV2 from 'firebase-functions/v2/https';
import * as service from './service';

const options = { region: 'us-central1', timeoutSeconds: 60, memory: '512MiB' as const };
const publishOptions = { region: 'us-central1', timeoutSeconds: 540, memory: '1GiB' as const };
export const listEquipmentInspectionProfiles = httpsV2.onCall(options, request => service.listEquipmentInspectionProfiles(request));
export const getEquipmentInspectionProfile = httpsV2.onCall(options, request => service.getEquipmentInspectionProfile(request));
export const saveEquipmentInspectionSettings = httpsV2.onCall(options, request => service.saveEquipmentInspectionSettings(request));
export const saveEquipmentInspectionDraft = httpsV2.onCall(options, request => service.saveEquipmentInspectionDraft(request));
export const publishEquipmentInspectionProfile = httpsV2.onCall(publishOptions, request => service.publishEquipmentInspectionProfile(request));
export const beginEquipmentInspectionPhotoUpload = httpsV2.onCall(options, request => service.beginEquipmentInspectionPhotoUpload(request));
