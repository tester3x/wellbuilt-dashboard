/**
 * Separate audited retirement of the legacy approved-row login.
 *
 * Does not delete history, does not remove the server-controlled binding
 * used for trusted history alias resolution, and does not accept a
 * client-supplied approved key. The bound key is loaded from the binding.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requirePlatformAdmin } from './adminAuth';
import { writeSecurityAudit } from './audit';
import { DRIVER_UUID_RE, BINDING_BY_DRIVER, BINDING_BY_APPROVED, decideRetireLegacyLogin, parseBinding } from './operational/identityBinding';
import { isServerScryptRecord } from './operational/approvedRowConversion';

export const staffRetireLegacyDriverLogin = httpsV2.onCall(
  { timeoutSeconds: 20, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const caller = await requirePlatformAdmin(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );
    const raw = (request.data || {}) as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (key !== 'driverId') {
        throw new httpsV2.HttpsError('invalid-argument', `Unexpected field: ${key}`);
      }
    }
    const driverId = typeof raw.driverId === 'string' ? raw.driverId.trim() : '';
    if (!DRIVER_UUID_RE.test(driverId)) {
      throw new httpsV2.HttpsError('invalid-argument', 'driver_id_malformed');
    }

    const rtdb = admin.database();
    const binding = parseBinding(
      (await rtdb.ref(BINDING_BY_DRIVER(driverId)).once('value')).val(),
    );
    const cred = await admin.firestore().collection('driver_credentials').doc(driverId).get();
    const profile = await rtdb.ref(`drivers/profiles/${driverId}`).once('value');
    const decision = decideRetireLegacyLogin({
      binding,
      secureLoginProven: cred.exists
        && cred.data()?.active !== false
        && isServerScryptRecord(cred.data()?.passcode),
      hydrationProven: profile.exists() && profile.val()?.active !== false,
    });
    if (decision.action === 'refuse') {
      await writeSecurityAudit({
        action: 'staffRetireLegacyDriverLogin_fail',
        actorUid: caller.uid,
        driverId,
        detail: { reason: decision.reason },
      });
      throw new httpsV2.HttpsError('failed-precondition', decision.reason);
    }
    if (decision.action === 'already_retired') {
      return { ok: true, driverId, status: 'legacy_login_retired' as const, already: true };
    }

    const next = { ...binding!, status: 'legacy_login_retired' as const, retiredAt: Date.now(), retiredBy: caller.uid };
    await rtdb.ref(BINDING_BY_DRIVER(driverId)).update({
      status: 'legacy_login_retired',
      retiredAt: Date.now(),
      retiredBy: caller.uid,
    });
    await rtdb.ref(BINDING_BY_APPROVED(binding!.approvedKey)).update({
      status: 'legacy_login_retired',
      retiredAt: Date.now(),
      retiredBy: caller.uid,
    });
    await rtdb.ref(`drivers/approved/${binding!.approvedKey}`).update({
      legacyLoginRetired: true,
    });

    await writeSecurityAudit({
      action: 'staffRetireLegacyDriverLogin',
      actorUid: caller.uid,
      driverId,
      detail: { status: next.status },
    });
    return { ok: true, driverId, status: 'legacy_login_retired' as const, already: false };
  },
);
