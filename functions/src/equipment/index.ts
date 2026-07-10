import * as httpsV2 from 'firebase-functions/v2/https';
import { handleDocumentRequest, DocumentRequest } from './services/documentService';

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