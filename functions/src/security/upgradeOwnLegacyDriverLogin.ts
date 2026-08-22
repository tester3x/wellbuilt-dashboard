/**
 * Customer-owned security upgrade.
 *
 * The customer proves the existing legacy login (name + current passcode)
 * and enters the new password on their own device. The administrator never
 * types, sees, receives, or logs it. Clients cannot supply an approvedKey.
 *
 * Old login remains available. Retirement is a separate audited action.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { randomUUID } from 'crypto';
import {
  hashPasscodeScrypt,
  legacySha256NamePasscode,
  validateRegistrationFields,
} from './passcode';
import { checkRateLimit, hashIp } from './rateLimit';
import { writeSecurityAudit } from './audit';
import { runCustomerOwnedUpgrade } from './operational/customerOwnedUpgrade';
import { productionUpgradeStore } from './operational/customerOwnedUpgradeStore';
import { BINDING_BY_APPROVED, parseBinding } from './operational/identityBinding';

const GENERIC_AUTH = 'Invalid name or passcode';
const GENERIC_FAIL = 'Could not complete upgrade';

const ENFORCE_APPCHECK = process.env.SECURITY_ENFORCE_APPCHECK === 'true';

function assertAppCheck(request: httpsV2.CallableRequest): void {
  if (!ENFORCE_APPCHECK) return;
  if (!request.app) {
    throw new httpsV2.HttpsError('failed-precondition', 'App Check required');
  }
}

function clientMeta(request: httpsV2.CallableRequest) {
  const ip =
    (request.rawRequest?.headers?.['x-forwarded-for'] as string)?.split(',')[0]?.trim()
    || request.rawRequest?.ip
    || undefined;
  return { ipHash: hashIp(ip), appCheckPresent: !!request.app, appId: request.app?.appId || null };
}

export const upgradeOwnLegacyDriverLogin = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    assertAppCheck(request);
    const raw = (request.data || {}) as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (!['displayName', 'currentPasscode', 'newPasscode'].includes(key)) {
        throw new httpsV2.HttpsError('invalid-argument', GENERIC_FAIL);
      }
    }

    const meta = clientMeta(request);
    const displayName = typeof raw.displayName === 'string' ? raw.displayName.trim() : '';
    const currentPasscode = typeof raw.currentPasscode === 'string' ? raw.currentPasscode : '';
    const newPasscode = typeof raw.newPasscode === 'string' ? raw.newPasscode : '';

    const allowed = await checkRateLimit({
      bucket: 'legacy_upgrade',
      key: `${displayName.toLowerCase()}:${meta.ipHash}`,
      limit: 5,
      windowMs: 15 * 60 * 1000,
    });
    if (!allowed) {
      throw new httpsV2.HttpsError('resource-exhausted', 'Too many attempts. Try later.');
    }

    let fields: ReturnType<typeof validateRegistrationFields>;
    try {
      fields = validateRegistrationFields({ displayName, passcode: newPasscode });
    } catch {
      throw new httpsV2.HttpsError('permission-denied', GENERIC_AUTH);
    }
    if (!currentPasscode) {
      throw new httpsV2.HttpsError('permission-denied', GENERIC_AUTH);
    }

    const provenApprovedKey = legacySha256NamePasscode(fields.displayName, currentPasscode);
    const rowSnap = await admin.database().ref(`drivers/approved/${provenApprovedKey}`).once('value');
    if (!rowSnap.exists()) {
      await writeSecurityAudit({
        action: 'upgradeOwnLegacyDriverLogin_fail',
        ipHash: meta.ipHash,
        detail: { reason: 'unknown_or_mismatch' },
      });
      throw new httpsV2.HttpsError('permission-denied', GENERIC_AUTH);
    }
    const row = rowSnap.val() as Record<string, unknown>;
    const byApproved = parseBinding(
      (await admin.database().ref(BINDING_BY_APPROVED(provenApprovedKey)).once('value')).val(),
    );
    if (
      row.active !== true
      || row.legacyLoginRetired === true
      || byApproved?.status === 'legacy_login_retired'
    ) {
      throw new httpsV2.HttpsError('permission-denied', GENERIC_AUTH);
    }

    const passcodeRecord = await hashPasscodeScrypt(fields.passcode);
    const opId = randomUUID();
    const converted = await runCustomerOwnedUpgrade(
      productionUpgradeStore(admin.firestore(), admin.database()),
      {
        provenApprovedKey,
        displayName: fields.displayName,
        passcodeRecord,
        callerUid: 'customer',
        opId,
      },
    );

    await writeSecurityAudit({
      action: converted.status === 'ok'
        ? 'upgradeOwnLegacyDriverLogin'
        : 'upgradeOwnLegacyDriverLogin_fail',
      driverId: converted.driverId,
      ipHash: meta.ipHash,
      detail: {
        status: converted.status,
        reason: converted.reason,
        terminalProven: converted.terminalProven,
        conflictCount: converted.preview?.conflicts.length ?? 0,
      },
    });

    if (converted.status !== 'ok' || !converted.terminalProven || !converted.driverId) {
      throw new httpsV2.HttpsError(
        converted.status === 'rolled_back' ? 'internal' : 'failed-precondition',
        GENERIC_FAIL,
      );
    }

    return {
      driverId: converted.driverId,
      displayName: fields.displayName,
      conflicts: converted.preview?.conflicts ?? [],
      preserved: converted.preview?.preserved ?? [],
      copiedFields: Object.keys(converted.preview?.copy || {}),
    };
  },
);
