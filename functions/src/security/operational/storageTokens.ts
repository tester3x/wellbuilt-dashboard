/**
 * Issue short-lived scoped storage paths for driver uploads.
 * Clients upload directly to Storage with Auth; rules enforce path == claims.
 * This callable validates ownership and returns the allowed object path.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import { requireSecureDriver, assertSameCompany } from '../requireDriverAuth';
import { writeSecurityAudit } from '../audit';

const MAX_PHOTO_BYTES = 12 * 1024 * 1024;

export const requestStorageUploadPath = httpsV2.onCall(
  { timeoutSeconds: 15, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const data = (request.data || {}) as {
      kind?: 'ticket_photo' | 'chat_photo' | 'jsa_pdf' | 'ewallet_doc';
      companyId?: string;
      invoiceId?: string;
      threadId?: string;
      docId?: string;
      contentType?: string;
      byteSize?: number;
      driverHash?: string;
    };

    const driver = await requireSecureDriver(request, {
      allowLegacyHash: true,
      legacyDriverHash: data.driverHash,
    });

    const kind = data.kind || 'ticket_photo';
    const contentType = (data.contentType || '').toLowerCase();
    const byteSize = typeof data.byteSize === 'number' ? data.byteSize : 0;
    if (byteSize > MAX_PHOTO_BYTES) {
      throw new httpsV2.HttpsError('invalid-argument', 'file too large');
    }

    const companyId = data.companyId || driver.companyId;
    if (companyId) assertSameCompany(driver.companyId, companyId);

    let path: string;
    switch (kind) {
      case 'ticket_photo': {
        if (!companyId || !data.invoiceId) {
          throw new httpsV2.HttpsError('invalid-argument', 'companyId and invoiceId required');
        }
        if (contentType && !contentType.startsWith('image/')) {
          throw new httpsV2.HttpsError('invalid-argument', 'image contentType required');
        }
        const photoId = `${Date.now()}_${driver.driverId.slice(0, 8)}`;
        path = `photos/${companyId}/${data.invoiceId}/${photoId}.jpg`;
        break;
      }
      case 'chat_photo': {
        if (!data.threadId) {
          throw new httpsV2.HttpsError('invalid-argument', 'threadId required');
        }
        path = `chat_photos/${data.threadId}/${Date.now()}_${driver.driverId.slice(0, 8)}.jpg`;
        break;
      }
      case 'jsa_pdf': {
        if (!companyId) {
          throw new httpsV2.HttpsError('invalid-argument', 'companyId required');
        }
        const day = new Date().toISOString().slice(0, 10);
        path = `jsa/${companyId}/${day}/${driver.driverId}_${Date.now()}.pdf`;
        break;
      }
      case 'ewallet_doc': {
        path = `ewallet/${driver.driverId}/${data.docId || Date.now()}.jpg`;
        break;
      }
      default:
        throw new httpsV2.HttpsError('invalid-argument', 'unknown kind');
    }

    await writeSecurityAudit({
      action: 'requestStorageUploadPath',
      actorUid: driver.uid,
      driverId: driver.driverId,
      detail: { kind, path },
    });

    return {
      path,
      maxBytes: MAX_PHOTO_BYTES,
      driverId: driver.driverId,
      companyId: companyId || null,
    };
  },
);
