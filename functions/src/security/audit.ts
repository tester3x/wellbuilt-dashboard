import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';

export async function writeSecurityAudit(entry: {
  action: string;
  actorUid?: string | null;
  driverId?: string | null;
  pendingId?: string | null;
  appId?: string | null;
  appCheckPresent?: boolean;
  ipHash?: string | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    await admin.firestore().collection('security_audit').add({
      ...entry,
      ts: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.warn('[security_audit] write failed (non-fatal):', (err as Error)?.message);
  }
}
