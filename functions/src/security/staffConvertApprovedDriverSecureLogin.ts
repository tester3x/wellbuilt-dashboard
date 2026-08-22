/**
 * Dedicated recovery callable: convert ONE exact drivers/approved row
 * into a canonical secure login. Platform-admin only. Not a passcode
 * reset, not a legacyHash mint, not adminSetDriverPasscode.
 *
 * Request is only approvedKey, displayName, passcode, temporary.
 * Profile metadata is copied from the approved row. Success is returned
 * only after a live re-read proves the terminal identity. Passcodes and
 * approved-key fragments are never logged or returned.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { randomUUID } from 'crypto';
import { requirePlatformAdmin } from './adminAuth';
import { writeSecurityAudit } from './audit';
import {
  hashPasscodeScrypt,
  validateRegistrationFields,
} from './passcode';
import {
  clientOutcomeFor,
  runApprovedRowConversion,
} from './operational/approvedRowConversion';
import { productionConversionStore } from './operational/approvedRowConversionStore';

const ALLOWED = new Set([
  'approvedKey',
  'displayName',
  'passcode',
  'temporary',
]);

const FORBIDDEN = new Set([
  'legalName',
  'companyId',
  'companyName',
  'driverId',
  'legacyHash',
  'assignedRoutes',
  'assignedWells',
  'assignedCustomers',
  'roles',
  'isAdmin',
  'isViewer',
  'active',
]);

function mapValidationError(code: string): never {
  const map: Record<string, string> = {
    invalid_display_name: 'Display name is required (2–64 characters)',
    invalid_display_name_chars: 'Display name contains invalid characters',
    invalid_passcode_length: 'Passcode must be 6–128 characters',
  };
  throw new httpsV2.HttpsError('invalid-argument', map[code] || code);
}

export const staffConvertApprovedDriverSecureLogin = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const caller = await requirePlatformAdmin(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );
    const raw = (request.data || {}) as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (FORBIDDEN.has(key)) {
        throw new httpsV2.HttpsError(
          'invalid-argument',
          key === 'driverId' ? 'driverId_reset_forbidden'
            : key === 'legacyHash' ? 'legacyHash_forbidden'
            : `Unexpected field: ${key}`,
        );
      }
      if (!ALLOWED.has(key)) {
        throw new httpsV2.HttpsError('invalid-argument', `Unexpected field: ${key}`);
      }
    }

    let fields: ReturnType<typeof validateRegistrationFields>;
    try {
      fields = validateRegistrationFields({
        displayName: typeof raw.displayName === 'string' ? raw.displayName : undefined,
        passcode: typeof raw.passcode === 'string' ? raw.passcode : undefined,
      });
    } catch (e) {
      mapValidationError((e as Error).message);
    }

    if (/^\d{1,5}$/.test(fields.passcode)) {
      throw new httpsV2.HttpsError(
        'invalid-argument',
        'Passcode must be at least 6 characters; short numeric PINs are not allowed',
      );
    }

    const approvedKey = typeof raw.approvedKey === 'string' ? raw.approvedKey.trim() : '';
    if (!approvedKey) {
      throw new httpsV2.HttpsError('failed-precondition', 'legacy_link_required');
    }

    const temporary = raw.temporary === true;
    const opId = randomUUID();
    const passcodeRecord = await hashPasscodeScrypt(fields.passcode);

    const converted = await runApprovedRowConversion(
      productionConversionStore(admin.firestore(), admin.database()),
      {
        approvedKey,
        displayName: fields.displayName,
        passcodeRecord,
        temporary,
        callerUid: caller.uid,
        opId,
      },
    );

    const outcome = clientOutcomeFor(converted);
    await writeSecurityAudit({
      action: outcome.success
        ? 'staffConvertApprovedDriverSecureLogin'
        : 'staffConvertApprovedDriverSecureLogin_fail',
      actorUid: caller.uid,
      driverId: converted.driverId,
      detail: {
        status: converted.status,
        reason: converted.reason,
        terminalProven: converted.terminalProven,
      },
    });

    if (!outcome.success) {
      const code = outcome.code === 'ok' ? 'internal' : outcome.code;
      throw new httpsV2.HttpsError(
        code,
        outcome.reason === 'approved_conversion_rolled_back'
          ? 'Could not create the driver profile; no identity was created'
          : outcome.reason,
      );
    }

    return {
      driverId: converted.driverId,
      displayName: fields.displayName,
      mustChangePasscode: temporary,
    };
  },
);
