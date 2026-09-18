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
    const cleanEntry: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(entry)) {
      if (v !== undefined) cleanEntry[k] = v;
    }
    await admin.firestore().collection('security_audit').add({
      ...cleanEntry,
      ts: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.warn('[security_audit] write failed (non-fatal):', (err as Error)?.message);
  }
}
