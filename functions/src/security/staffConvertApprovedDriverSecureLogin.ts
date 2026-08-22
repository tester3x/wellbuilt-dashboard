/**
 * SUPERSEDED. Admin-entered passwords and history separation are
 * unacceptable for customer identities.
 *
 * Use upgradeOwnLegacyDriverLogin (customer-owned password on-device) and
 * staffHydrateCanonicalIdentity (bind + copy, no password). This callable
 * refuses every invocation and never hashes, writes, or logs a passcode.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import { requirePlatformAdmin } from './adminAuth';
import { writeSecurityAudit } from './audit';

export const SUPERSEDED_REASON = 'superseded_by_customer_owned_upgrade';

export const staffConvertApprovedDriverSecureLogin = httpsV2.onCall(
  { timeoutSeconds: 15, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const caller = await requirePlatformAdmin(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );
    await writeSecurityAudit({
      action: 'staffConvertApprovedDriverSecureLogin_superseded',
      actorUid: caller.uid,
      detail: { reason: SUPERSEDED_REASON },
    });
    throw new httpsV2.HttpsError('failed-precondition', SUPERSEDED_REASON);
  },
);
