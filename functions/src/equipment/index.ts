import * as httpsV2 from 'firebase-functions/v2/https';
import { handleDocumentRequest, DocumentRequest } from './services/documentService';
import { handleEquipmentRequest, EquipmentRequest } from './services/equipmentService';

/**
 * WB eQuipment — Document Service callable.
 * Driver: driver.list | driver.uploadImage | driver.upsert | driver.delete
 * Dashboard: equipment.uploadDocument | equipment.removeDocument
 */
export const eQuipmentDocuments = httpsV2.onCall(
  { timeoutSeconds: 60, memory: '256MiB' },
  async (request) => {
    const data = (request.data || {}) as DocumentRequest;
    return handleDocumentRequest(data, { authUid: request.auth?.uid });
  },
);

/**
 * WB eQuipment — Equipment registry callable.
 * registry.seedTypes | registerEquipment | updateEquipment | getEquipment |
 * listEquipment | resolveByUnit | defineEquipmentType
 */
export const eQuipmentEquipment = httpsV2.onCall(
  { timeoutSeconds: 60, memory: '256MiB' },
  async (request) => {
    const data = (request.data || {}) as EquipmentRequest;
    return handleEquipmentRequest(data, { authUid: request.auth?.uid });
  },
);