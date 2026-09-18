/**
 * Canonical Driver Reset Design — Phase 0 Pure Validators
 *
 * Side-effect-free, deterministic validators for canonical driver reset contracts.
 *
 * BOUNDARY RULES:
 * - Pure TypeScript only.
 * - Zero Firebase SDK or external library imports.
 * - Zero input mutation (immutable reads).
 * - Zero leakage of passcodes, salts, or hashes in error messages or results.
 * - Strictly fails closed on missing, malformed, unexpected, or coerced fields.
 */

import {
  PASSCODE_DIGIT_MIN_LEN,
  PASSCODE_DIGIT_MAX_LEN,
  ID_MIN_LEN,
  ID_MAX_LEN,
  CANONICAL_ID_REGEX,
  PASSCODE_DIGITS_REGEX,
  CANONICAL_SCRYPT_ALGO,
  SCRYPT_BOUNDS,
  type CanonicalResetRequest,
  type CanonicalCredential,
  type DriverSessionBinding,
  type ResetReceipt,
  type AuthCleanupEffect,
  type ValidationResult,
  type ValidationError,
} from './contracts';

// ── Internal Helpers ─────────────────────────────────────────────────────────

const BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkUnknownKeys(
  raw: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  entityName: string,
): ValidationError | null {
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      return {
        code: 'unknown_field',
        message: `Unknown field rejected on ${entityName}: ${key}`,
        path: key,
      };
    }
  }
  return null;
}

function validateCanonicalId(
  value: unknown,
  fieldName: string,
): ValidationError | null {
  if (typeof value !== 'string') {
    return {
      code: 'invalid_id_type',
      message: `Field ${fieldName} must be a string`,
      path: fieldName,
    };
  }
  if (value.length < ID_MIN_LEN) {
    return {
      code: 'empty_id',
      message: `Field ${fieldName} must not be empty`,
      path: fieldName,
    };
  }
  if (value.length > ID_MAX_LEN) {
    return {
      code: 'id_too_long',
      message: `Field ${fieldName} exceeds maximum length of ${ID_MAX_LEN}`,
      path: fieldName,
    };
  }
  // Validation must never trim or coerce: if whitespace is present, fail closed immediately
  if (/\s/.test(value) || !CANONICAL_ID_REGEX.test(value)) {
    return {
      code: 'malformed_id',
      message: `Field ${fieldName} contains illegal characters or whitespace`,
      path: fieldName,
    };
  }
  return null;
}

function validatePositiveSafeInteger(
  value: unknown,
  fieldName: string,
): ValidationError | null {
  if (typeof value !== 'number') {
    return {
      code: 'invalid_integer_type',
      message: `Field ${fieldName} must be a number`,
      path: fieldName,
    };
  }
  if (!Number.isSafeInteger(value)) {
    return {
      code: 'unsafe_integer',
      message: `Field ${fieldName} must be a safe integer`,
      path: fieldName,
    };
  }
  if (value <= 0) {
    return {
      code: 'non_positive_integer',
      message: `Field ${fieldName} must be a positive integer (> 0)`,
      path: fieldName,
    };
  }
  return null;
}

function validateIsoTimestamp(
  value: unknown,
  fieldName: string,
): ValidationError | null {
  if (typeof value !== 'string' || value.length === 0) {
    return {
      code: 'invalid_timestamp',
      message: `Field ${fieldName} must be a non-empty ISO timestamp string`,
      path: fieldName,
    };
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return {
      code: 'malformed_timestamp',
      message: `Field ${fieldName} must be a valid parseable ISO timestamp`,
      path: fieldName,
    };
  }
  return null;
}

// ── 1. Canonical Reset Request Validator ─────────────────────────────────────

const REQUEST_ALLOWED_KEYS = new Set<string>([
  'opId',
  'companyId',
  'driverId',
  'expectedCredentialVersion',
  'temporary',
  'newPasscode',
]);

/**
 * Strictly validate a wire CanonicalResetRequest.
 *
 * Semantic invariants:
 * - Exactly 6 wire fields: opId, companyId, driverId, expectedCredentialVersion, temporary, newPasscode.
 * - Unknown or additional fields rejected (fails closed against callerUid, roles, approvedKey, etc.).
 * - expectedCredentialVersion must be a positive safe integer.
 * - temporary must be an explicit boolean.
 * - newPasscode must be numeric digits only, length 6..128.
 * - Zero mutation of input.
 * - Error message NEVER echoes secret passcode or credentials.
 */
export function validateCanonicalResetRequest(
  raw: unknown,
): ValidationResult<CanonicalResetRequest> {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      error: {
        code: 'invalid_request_shape',
        message: 'Reset request must be a non-null object',
      },
    };
  }

  // Reject unknown or additional fields (prevents injection of callerUid, roles, approvedKey, legacyHash, etc.)
  const unknownKeyError = checkUnknownKeys(raw, REQUEST_ALLOWED_KEYS, 'CanonicalResetRequest');
  if (unknownKeyError) {
    return { ok: false, error: unknownKeyError };
  }

  // Check required fields presence
  for (const field of REQUEST_ALLOWED_KEYS) {
    if (!(field in raw) || raw[field] === undefined || raw[field] === null) {
      return {
        ok: false,
        error: {
          code: 'missing_field',
          message: `Missing required request field: ${field}`,
          path: field,
        },
      };
    }
  }

  // opId validation
  const opIdError = validateCanonicalId(raw.opId, 'opId');
  if (opIdError) return { ok: false, error: opIdError };

  // companyId validation
  const companyIdError = validateCanonicalId(raw.companyId, 'companyId');
  if (companyIdError) return { ok: false, error: companyIdError };

  // driverId validation
  const driverIdError = validateCanonicalId(raw.driverId, 'driverId');
  if (driverIdError) return { ok: false, error: driverIdError };

  // expectedCredentialVersion validation
  const versionError = validatePositiveSafeInteger(
    raw.expectedCredentialVersion,
    'expectedCredentialVersion',
  );
  if (versionError) return { ok: false, error: versionError };

  // temporary validation: explicit boolean
  if (typeof raw.temporary !== 'boolean') {
    return {
      ok: false,
      error: {
        code: 'invalid_temporary_type',
        message: 'Field temporary must be an explicit boolean (true or false)',
        path: 'temporary',
      },
    };
  }

  // newPasscode validation
  if (typeof raw.newPasscode !== 'string') {
    return {
      ok: false,
      error: {
        code: 'invalid_passcode_type',
        message: 'Field newPasscode must be a string (coercion rejected)',
        path: 'newPasscode',
      },
    };
  }

  if (raw.newPasscode.length === 0) {
    return {
      ok: false,
      error: {
        code: 'empty_passcode',
        message: 'Field newPasscode must not be empty',
        path: 'newPasscode',
      },
    };
  }

  if (raw.newPasscode.length < PASSCODE_DIGIT_MIN_LEN) {
    return {
      ok: false,
      error: {
        code: 'passcode_too_short',
        message: `Passcode length must be at least ${PASSCODE_DIGIT_MIN_LEN} digits`,
        path: 'newPasscode',
      },
    };
  }

  if (raw.newPasscode.length > PASSCODE_DIGIT_MAX_LEN) {
    return {
      ok: false,
      error: {
        code: 'passcode_too_long',
        message: `Passcode length must not exceed ${PASSCODE_DIGIT_MAX_LEN} digits`,
        path: 'newPasscode',
      },
    };
  }

  if (!PASSCODE_DIGITS_REGEX.test(raw.newPasscode)) {
    return {
      ok: false,
      error: {
        code: 'passcode_non_numeric',
        message: 'Passcode must contain numeric digits only',
        path: 'newPasscode',
      },
    };
  }

  return {
    ok: true,
    value: {
      opId: raw.opId as string,
      companyId: raw.companyId as string,
      driverId: raw.driverId as string,
      expectedCredentialVersion: raw.expectedCredentialVersion as number,
      temporary: raw.temporary as boolean,
      newPasscode: raw.newPasscode as string,
    },
  };
}

// ── 2. Canonical Credential Validator ────────────────────────────────────────

const CREDENTIAL_ALLOWED_KEYS = new Set<string>([
  'algo',
  'N',
  'r',
  'p',
  'keyLen',
  'saltB64',
  'hashB64',
  'driverId',
  'companyId',
  'credentialVersion',
  'active',
]);

/**
 * Validate authoritative CanonicalCredential stored in driver_credentials.
 *
 * Semantic invariants:
 * - Scrypt algorithm with repository parameters.
 * - Non-empty base64 salt (min 16 bytes) and hash.
 * - Explicit driverId and companyId matching expected bindings.
 * - credentialVersion must be a positive safe integer.
 * - active must be boolean true for reset eligibility. Missing, false, or malformed fails closed.
 * - Error message NEVER echoes salt, hash, or secret material.
 */
export function validateCanonicalCredential(
  raw: unknown,
  expectedBinding?: { driverId: string; companyId: string },
): ValidationResult<CanonicalCredential> {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      error: {
        code: 'invalid_credential_shape',
        message: 'Credential record must be a non-null object',
      },
    };
  }

  const unknownKeyError = checkUnknownKeys(raw, CREDENTIAL_ALLOWED_KEYS, 'CanonicalCredential');
  if (unknownKeyError) {
    return { ok: false, error: unknownKeyError };
  }

  for (const field of CREDENTIAL_ALLOWED_KEYS) {
    if (!(field in raw) || raw[field] === undefined || raw[field] === null) {
      return {
        ok: false,
        error: {
          code: 'missing_credential_field',
          message: `Missing required credential field: ${field}`,
          path: field,
        },
      };
    }
  }

  // algo check
  if (raw.algo !== CANONICAL_SCRYPT_ALGO) {
    return {
      ok: false,
      error: {
        code: 'invalid_algo',
        message: `Credential algo must be '${CANONICAL_SCRYPT_ALGO}'`,
        path: 'algo',
      },
    };
  }

  // Scrypt parameter N: power of 2, within bounds
  if (
    typeof raw.N !== 'number' ||
    !Number.isSafeInteger(raw.N) ||
    raw.N < SCRYPT_BOUNDS.N.min ||
    raw.N > SCRYPT_BOUNDS.N.max ||
    (raw.N & (raw.N - 1)) !== 0
  ) {
    return {
      ok: false,
      error: {
        code: 'invalid_scrypt_parameter',
        message: `Scrypt parameter N must be a power of 2 between ${SCRYPT_BOUNDS.N.min} and ${SCRYPT_BOUNDS.N.max}`,
        path: 'N',
      },
    };
  }

  // Scrypt parameter r
  if (
    typeof raw.r !== 'number' ||
    !Number.isSafeInteger(raw.r) ||
    raw.r < SCRYPT_BOUNDS.r.min ||
    raw.r > SCRYPT_BOUNDS.r.max
  ) {
    return {
      ok: false,
      error: {
        code: 'invalid_scrypt_parameter',
        message: `Scrypt parameter r must be an integer between ${SCRYPT_BOUNDS.r.min} and ${SCRYPT_BOUNDS.r.max}`,
        path: 'r',
      },
    };
  }

  // Scrypt parameter p
  if (
    typeof raw.p !== 'number' ||
    !Number.isSafeInteger(raw.p) ||
    raw.p < SCRYPT_BOUNDS.p.min ||
    raw.p > SCRYPT_BOUNDS.p.max
  ) {
    return {
      ok: false,
      error: {
        code: 'invalid_scrypt_parameter',
        message: `Scrypt parameter p must be an integer between ${SCRYPT_BOUNDS.p.min} and ${SCRYPT_BOUNDS.p.max}`,
        path: 'p',
      },
    };
  }

  // Scrypt parameter keyLen
  if (
    typeof raw.keyLen !== 'number' ||
    !Number.isSafeInteger(raw.keyLen) ||
    raw.keyLen < SCRYPT_BOUNDS.keyLen.min ||
    raw.keyLen > SCRYPT_BOUNDS.keyLen.max
  ) {
    return {
      ok: false,
      error: {
        code: 'invalid_scrypt_parameter',
        message: `Scrypt parameter keyLen must be an integer between ${SCRYPT_BOUNDS.keyLen.min} and ${SCRYPT_BOUNDS.keyLen.max}`,
        path: 'keyLen',
      },
    };
  }

  // saltB64 validation
  if (typeof raw.saltB64 !== 'string') {
    return {
      ok: false,
      error: {
        code: 'invalid_salt_type',
        message: 'saltB64 must be a string',
        path: 'saltB64',
      },
    };
  }
  if (raw.saltB64.length === 0) {
    return {
      ok: false,
      error: {
        code: 'empty_salt',
        message: 'saltB64 must not be empty',
        path: 'saltB64',
      },
    };
  }
  if (!BASE64_REGEX.test(raw.saltB64)) {
    return {
      ok: false,
      error: {
        code: 'invalid_salt',
        message: 'saltB64 must be a valid base64 string',
        path: 'saltB64',
      },
    };
  }
  const saltBytes =
    Math.floor((raw.saltB64.length * 3) / 4) -
    (raw.saltB64.endsWith('==') ? 2 : raw.saltB64.endsWith('=') ? 1 : 0);
  if (saltBytes < SCRYPT_BOUNDS.minSaltBytes) {
    return {
      ok: false,
      error: {
        code: 'salt_too_short',
        message: `saltB64 must represent at least ${SCRYPT_BOUNDS.minSaltBytes} bytes`,
        path: 'saltB64',
      },
    };
  }

  // hashB64 validation
  if (typeof raw.hashB64 !== 'string') {
    return {
      ok: false,
      error: {
        code: 'invalid_hash_type',
        message: 'hashB64 must be a string',
        path: 'hashB64',
      },
    };
  }
  if (raw.hashB64.length === 0) {
    return {
      ok: false,
      error: {
        code: 'empty_hash',
        message: 'hashB64 must not be empty',
        path: 'hashB64',
      },
    };
  }
  if (!BASE64_REGEX.test(raw.hashB64)) {
    return {
      ok: false,
      error: {
        code: 'invalid_hash',
        message: 'hashB64 must be a valid base64 string',
        path: 'hashB64',
      },
    };
  }

  // driverId & companyId validation
  const driverIdError = validateCanonicalId(raw.driverId, 'driverId');
  if (driverIdError) return { ok: false, error: driverIdError };

  const companyIdError = validateCanonicalId(raw.companyId, 'companyId');
  if (companyIdError) return { ok: false, error: companyIdError };

  // expectedBinding correlation
  if (expectedBinding) {
    if (raw.driverId !== expectedBinding.driverId) {
      return {
        ok: false,
        error: {
          code: 'driver_binding_mismatch',
          message: 'Credential driverId does not match expected binding',
          path: 'driverId',
        },
      };
    }
    if (raw.companyId !== expectedBinding.companyId) {
      return {
        ok: false,
        error: {
          code: 'company_binding_mismatch',
          message: 'Credential companyId does not match expected binding',
          path: 'companyId',
        },
      };
    }
  }

  // credentialVersion validation
  const versionError = validatePositiveSafeInteger(raw.credentialVersion, 'credentialVersion');
  if (versionError) return { ok: false, error: versionError };

  // active flag: MUST be boolean true for reset eligibility
  if (typeof raw.active !== 'boolean') {
    return {
      ok: false,
      error: {
        code: 'invalid_active_type',
        message: 'Field active must be an explicit boolean',
        path: 'active',
      },
    };
  }

  if (raw.active !== true) {
    return {
      ok: false,
      error: {
        code: 'inactive_credential',
        message: 'Credential active status must be true for reset eligibility',
        path: 'active',
      },
    };
  }

  return {
    ok: true,
    value: {
      algo: raw.algo as typeof CANONICAL_SCRYPT_ALGO,
      N: raw.N as number,
      r: raw.r as number,
      p: raw.p as number,
      keyLen: raw.keyLen as number,
      saltB64: raw.saltB64 as string,
      hashB64: raw.hashB64 as string,
      driverId: raw.driverId as string,
      companyId: raw.companyId as string,
      credentialVersion: raw.credentialVersion as number,
      active: true,
    },
  };
}

// ── 3. Driver Session Binding Validator ─────────────────────────────────────

const SESSION_ALLOWED_KEYS = new Set<string>([
  'sessionId',
  'driverId',
  'companyId',
  'credentialVersion',
]);

/**
 * Validate immutable driver session binding record.
 */
export function validateDriverSessionBinding(
  raw: unknown,
): ValidationResult<DriverSessionBinding> {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      error: {
        code: 'invalid_session_shape',
        message: 'Session binding must be a non-null object',
      },
    };
  }

  const unknownKeyError = checkUnknownKeys(raw, SESSION_ALLOWED_KEYS, 'DriverSessionBinding');
  if (unknownKeyError) return { ok: false, error: unknownKeyError };

  for (const field of SESSION_ALLOWED_KEYS) {
    if (!(field in raw) || raw[field] === undefined || raw[field] === null) {
      return {
        ok: false,
        error: {
          code: 'missing_session_field',
          message: `Missing required session field: ${field}`,
          path: field,
        },
      };
    }
  }

  const sessionIdError = validateCanonicalId(raw.sessionId, 'sessionId');
  if (sessionIdError) return { ok: false, error: sessionIdError };

  const driverIdError = validateCanonicalId(raw.driverId, 'driverId');
  if (driverIdError) return { ok: false, error: driverIdError };

  const companyIdError = validateCanonicalId(raw.companyId, 'companyId');
  if (companyIdError) return { ok: false, error: companyIdError };

  const versionError = validatePositiveSafeInteger(raw.credentialVersion, 'credentialVersion');
  if (versionError) return { ok: false, error: versionError };

  return {
    ok: true,
    value: {
      sessionId: raw.sessionId as string,
      driverId: raw.driverId as string,
      companyId: raw.companyId as string,
      credentialVersion: raw.credentialVersion as number,
    },
  };
}

/**
 * Verify that an established session matches current authoritative credentials.
 * Comparing bound version with stored version guarantees complete revocation
 * without relying on a standalone boolean.
 */
export function validateSessionVersionMatch(
  session: DriverSessionBinding,
  credential: CanonicalCredential,
): ValidationResult<{ matched: true; currentVersion: number }> {
  if (session.driverId !== credential.driverId) {
    return {
      ok: false,
      error: {
        code: 'session_driver_mismatch',
        message: 'Session driverId does not match credential driverId',
        path: 'driverId',
      },
    };
  }

  if (session.companyId !== credential.companyId) {
    return {
      ok: false,
      error: {
        code: 'session_company_mismatch',
        message: 'Session companyId does not match credential companyId',
        path: 'companyId',
      },
    };
  }

  if (credential.active !== true) {
    return {
      ok: false,
      error: {
        code: 'credential_inactive',
        message: 'Driver credential is not active',
        path: 'active',
      },
    };
  }

  if (session.credentialVersion !== credential.credentialVersion) {
    return {
      ok: false,
      error: {
        code: 'session_credential_version_mismatch',
        message: 'Session credential version is stale or revoked',
        path: 'credentialVersion',
      },
    };
  }

  return {
    ok: true,
    value: {
      matched: true,
      currentVersion: credential.credentialVersion,
    },
  };
}

// ── 4. Reset Receipt Validator ───────────────────────────────────────────────

const RECEIPT_ALLOWED_KEYS = new Set<string>([
  'receiptId',
  'opId',
  'companyId',
  'driverId',
  'previousCredentialVersion',
  'newCredentialVersion',
  'temporary',
  'actorUid',
  'appliedAt',
  'status',
  'authCleanupStatus',
]);

/**
 * Validate immutable ResetReceipt recorded on successful credential update.
 */
export function validateResetReceipt(raw: unknown): ValidationResult<ResetReceipt> {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      error: {
        code: 'invalid_receipt_shape',
        message: 'Reset receipt must be a non-null object',
      },
    };
  }

  const unknownKeyError = checkUnknownKeys(raw, RECEIPT_ALLOWED_KEYS, 'ResetReceipt');
  if (unknownKeyError) return { ok: false, error: unknownKeyError };

  for (const field of RECEIPT_ALLOWED_KEYS) {
    if (!(field in raw) || raw[field] === undefined || raw[field] === null) {
      return {
        ok: false,
        error: {
          code: 'missing_receipt_field',
          message: `Missing required receipt field: ${field}`,
          path: field,
        },
      };
    }
  }

  const receiptIdError = validateCanonicalId(raw.receiptId, 'receiptId');
  if (receiptIdError) return { ok: false, error: receiptIdError };

  const opIdError = validateCanonicalId(raw.opId, 'opId');
  if (opIdError) return { ok: false, error: opIdError };

  const companyIdError = validateCanonicalId(raw.companyId, 'companyId');
  if (companyIdError) return { ok: false, error: companyIdError };

  const driverIdError = validateCanonicalId(raw.driverId, 'driverId');
  if (driverIdError) return { ok: false, error: driverIdError };

  const actorUidError = validateCanonicalId(raw.actorUid, 'actorUid');
  if (actorUidError) return { ok: false, error: actorUidError };

  const prevVersionError = validatePositiveSafeInteger(
    raw.previousCredentialVersion,
    'previousCredentialVersion',
  );
  if (prevVersionError) return { ok: false, error: prevVersionError };

  const newVersionError = validatePositiveSafeInteger(
    raw.newCredentialVersion,
    'newCredentialVersion',
  );
  if (newVersionError) return { ok: false, error: newVersionError };

  if ((raw.newCredentialVersion as number) !== (raw.previousCredentialVersion as number) + 1) {
    return {
      ok: false,
      error: {
        code: 'invalid_credential_version_progression',
        message: 'newCredentialVersion must be exactly previousCredentialVersion + 1',
        path: 'newCredentialVersion',
      },
    };
  }

  if (typeof raw.temporary !== 'boolean') {
    return {
      ok: false,
      error: {
        code: 'invalid_temporary_type',
        message: 'Field temporary must be an explicit boolean',
        path: 'temporary',
      },
    };
  }

  const timestampError = validateIsoTimestamp(raw.appliedAt, 'appliedAt');
  if (timestampError) return { ok: false, error: timestampError };

  if (raw.status !== 'committed') {
    return {
      ok: false,
      error: {
        code: 'invalid_receipt_status',
        message: "Receipt status must be 'committed'",
        path: 'status',
      },
    };
  }

  // A reset receipt must NEVER falsely claim Auth cleanup completed before the effect is acknowledged!
  if (raw.authCleanupStatus !== 'pending' && raw.authCleanupStatus !== 'enqueued') {
    return {
      ok: false,
      error: {
        code: 'invalid_receipt_auth_cleanup_status',
        message:
          "Receipt authCleanupStatus must be 'pending' or 'enqueued'; completed cannot be claimed at reset receipt creation",
        path: 'authCleanupStatus',
      },
    };
  }

  return {
    ok: true,
    value: {
      receiptId: raw.receiptId as string,
      opId: raw.opId as string,
      companyId: raw.companyId as string,
      driverId: raw.driverId as string,
      previousCredentialVersion: raw.previousCredentialVersion as number,
      newCredentialVersion: raw.newCredentialVersion as number,
      temporary: raw.temporary as boolean,
      actorUid: raw.actorUid as string,
      appliedAt: raw.appliedAt as string,
      status: 'committed',
      authCleanupStatus: raw.authCleanupStatus as 'pending' | 'enqueued',
    },
  };
}

// ── 5. Auth Cleanup Effect Validator ─────────────────────────────────────────

const EFFECT_ALLOWED_KEYS = new Set<string>([
  'effectId',
  'opId',
  'companyId',
  'driverId',
  'credentialVersion',
  'status',
  'attempts',
  'createdAt',
  'lastAttemptAt',
  'completedAt',
  'terminalError',
]);

const VALID_EFFECT_STATUSES = new Set<string>([
  'pending',
  'in_progress',
  'completed',
  'failed',
]);

/**
 * Validate durable AuthCleanupEffect record for forward-only worker processing.
 */
export function validateAuthCleanupEffect(
  raw: unknown,
): ValidationResult<AuthCleanupEffect> {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      error: {
        code: 'invalid_effect_shape',
        message: 'Auth cleanup effect must be a non-null object',
      },
    };
  }

  const unknownKeyError = checkUnknownKeys(raw, EFFECT_ALLOWED_KEYS, 'AuthCleanupEffect');
  if (unknownKeyError) return { ok: false, error: unknownKeyError };

  // Required keys for any effect
  const requiredKeys = ['effectId', 'opId', 'companyId', 'driverId', 'credentialVersion', 'status', 'attempts', 'createdAt'];
  for (const field of requiredKeys) {
    if (!(field in raw) || raw[field] === undefined || raw[field] === null) {
      return {
        ok: false,
        error: {
          code: 'missing_effect_field',
          message: `Missing required effect field: ${field}`,
          path: field,
        },
      };
    }
  }

  const effectIdError = validateCanonicalId(raw.effectId, 'effectId');
  if (effectIdError) return { ok: false, error: effectIdError };

  const opIdError = validateCanonicalId(raw.opId, 'opId');
  if (opIdError) return { ok: false, error: opIdError };

  const companyIdError = validateCanonicalId(raw.companyId, 'companyId');
  if (companyIdError) return { ok: false, error: companyIdError };

  const driverIdError = validateCanonicalId(raw.driverId, 'driverId');
  if (driverIdError) return { ok: false, error: driverIdError };

  const versionError = validatePositiveSafeInteger(raw.credentialVersion, 'credentialVersion');
  if (versionError) return { ok: false, error: versionError };

  if (typeof raw.status !== 'string' || !VALID_EFFECT_STATUSES.has(raw.status)) {
    return {
      ok: false,
      error: {
        code: 'invalid_effect_status',
        message: `status must be one of: ${Array.from(VALID_EFFECT_STATUSES).join(', ')}`,
        path: 'status',
      },
    };
  }

  if (
    typeof raw.attempts !== 'number' ||
    !Number.isSafeInteger(raw.attempts) ||
    raw.attempts < 0
  ) {
    return {
      ok: false,
      error: {
        code: 'invalid_attempts',
        message: 'attempts must be a non-negative integer (>= 0)',
        path: 'attempts',
      },
    };
  }

  const createdAtError = validateIsoTimestamp(raw.createdAt, 'createdAt');
  if (createdAtError) return { ok: false, error: createdAtError };

  // Status-dependent state consistency
  if (raw.status === 'pending') {
    if (raw.completedAt != null) {
      return {
        ok: false,
        error: {
          code: 'contradictory_effect_status',
          message: 'Pending effect must not have completedAt set',
          path: 'completedAt',
        },
      };
    }
  }

  if (raw.status === 'completed') {
    if (raw.completedAt == null) {
      return {
        ok: false,
        error: {
          code: 'contradictory_effect_status',
          message: 'Completed effect must have completedAt set',
          path: 'completedAt',
        },
      };
    }
    const completedAtError = validateIsoTimestamp(raw.completedAt, 'completedAt');
    if (completedAtError) return { ok: false, error: completedAtError };

    if (raw.terminalError != null) {
      return {
        ok: false,
        error: {
          code: 'contradictory_effect_status',
          message: 'Completed effect must not have terminalError set',
          path: 'terminalError',
        },
      };
    }
  }

  if (raw.status === 'failed') {
    if (raw.terminalError == null || typeof raw.terminalError !== 'string' || raw.terminalError.length === 0) {
      return {
        ok: false,
        error: {
          code: 'missing_terminal_error',
          message: 'Failed effect must provide a terminalError description',
          path: 'terminalError',
        },
      };
    }
  }

  return {
    ok: true,
    value: {
      effectId: raw.effectId as string,
      opId: raw.opId as string,
      companyId: raw.companyId as string,
      driverId: raw.driverId as string,
      credentialVersion: raw.credentialVersion as number,
      status: raw.status as 'pending' | 'in_progress' | 'completed' | 'failed',
      attempts: raw.attempts as number,
      createdAt: raw.createdAt as string,
      lastAttemptAt: raw.lastAttemptAt as string | null | undefined,
      completedAt: raw.completedAt as string | null | undefined,
      terminalError: raw.terminalError as string | null | undefined,
    },
  };
}

// ── 6. Receipt / Effect Alignment Validator ──────────────────────────────────

/**
 * Validate that a reset receipt and an Auth cleanup effect record are
 * mutually consistent and non-contradictory.
 */
export function validateReceiptEffectAlignment(
  receipt: ResetReceipt,
  effect: AuthCleanupEffect,
): ValidationResult<true> {
  if (receipt.opId !== effect.opId) {
    return {
      ok: false,
      error: {
        code: 'op_id_mismatch',
        message: 'Receipt and Effect opId mismatch',
        path: 'opId',
      },
    };
  }

  if (receipt.driverId !== effect.driverId) {
    return {
      ok: false,
      error: {
        code: 'driver_id_mismatch',
        message: 'Receipt and Effect driverId mismatch',
        path: 'driverId',
      },
    };
  }

  if (receipt.companyId !== effect.companyId) {
    return {
      ok: false,
      error: {
        code: 'company_id_mismatch',
        message: 'Receipt and Effect companyId mismatch',
        path: 'companyId',
      },
    };
  }

  if (receipt.newCredentialVersion !== effect.credentialVersion) {
    return {
      ok: false,
      error: {
        code: 'credential_version_mismatch',
        message: 'Receipt newCredentialVersion does not match Effect credentialVersion',
        path: 'credentialVersion',
      },
    };
  }

  // A receipt must not claim completed cleanup if the effect has not completed
  if (effect.status !== 'completed' && (receipt.authCleanupStatus as string) === 'completed') {
    return {
      ok: false,
      error: {
        code: 'receipt_effect_status_contradiction',
        message: 'Reset receipt falsely claims auth cleanup completed while effect record is not completed',
        path: 'authCleanupStatus',
      },
    };
  }

  return { ok: true, value: true };
}
