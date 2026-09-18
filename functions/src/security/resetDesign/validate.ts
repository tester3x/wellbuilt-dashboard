/**
 * Canonical Driver Reset Design — Phase 0 Pure Validators
 *
 * Side-effect-free, deterministic validators for canonical driver reset contracts.
 *
 * BOUNDARY RULES:
 * - Pure TypeScript only.
 * - Zero Firebase SDK or external library imports.
 * - Zero input mutation (deeply frozen return values).
 * - Zero leakage of passcodes, salts, or hashes in error messages or results.
 * - Inspects own properties only; rejects inherited, exotic, symbol, and accessor properties without invocation.
 * - Strictly fails closed on missing, malformed, unexpected, or coerced fields.
 * - Error messages and codes are strictly drawn from fixed enums; never echo attacker input.
 */

import {
  PASSCODE_DIGIT_MIN_LEN,
  PASSCODE_DIGIT_MAX_LEN,
  ID_MIN_LEN,
  ID_MAX_LEN,
  COMPANY_ID_MAX_LEN,
  CANONICAL_DOC_ID_REGEX,
  AUTH_UID_REGEX,
  COMPANY_ID_REGEX,
  PASSCODE_DIGITS_REGEX,
  CANONICAL_SCRYPT_ALGO,
  SCRYPT_BOUNDS,
  VERSION_MIN,
  VERSION_MAX_SAFE,
  COUNTER_MIN,
  COUNTER_MAX_SAFE,
  MAX_RETRY_ATTEMPTS,
  TERMINAL_ERROR_CODES,
  ALLOWED_EFFECT_TRANSITIONS,
  type TerminalErrorCode,
  type ValidationResult,
  type ValidationError,
  type ValidationErrorCode,
  type CanonicalResetRequest,
  type ValidatedSecretBearingResetRequest,
  type CanonicalResetOperationCommitment,
  type CanonicalCredential,
  type CurrentDriverCredentialDoc,
  type DriverSessionBinding,
  type ResetReceipt,
  type AuthCleanupEffect,
  type StaffPrincipal,
  type TenantMembership,
  type TenantRoleCapabilities,
  type TenantSecurityPolicy,
  type TargetDriverBinding,
  type ResetAuthzSnapshot,
  type EffectStatus,
} from './contracts';

// ── Runtime Immutability Helper ──────────────────────────────────────────────

/**
 * Recursively freeze an object and all its plain-object/array child properties.
 * Provides runtime immutability guarantees beyond TypeScript's compile-time `readonly`.
 */
export function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const prop = (obj as Record<string, unknown>)[key];
    if (prop !== null && typeof prop === 'object' && !Object.isFrozen(prop)) {
      deepFreeze(prop);
    }
  }
  return obj as Readonly<T>;
}

// ── Plain Data Inspection (Requirement 2) ────────────────────────────────────

/**
 * Strictly inspects raw input to verify it is a supported plain data object.
 *
 * Rules:
 * 1. Must be typeof 'object', not null, not an array.
 * 2. Prototype must be Object.prototype or null (rejects Date, RegExp, Map, Set, custom classes, Object.create(custom)).
 * 3. Rejects symbols (Object.getOwnPropertySymbols).
 * 4. Rejects non-enumerable properties.
 * 5. Rejects getter/setter accessor descriptors WITHOUT invoking them.
 * 6. Bounds total own property count to <= 32.
 * 7. Catches prototype/descriptor/proxy exceptions and returns static failure.
 * 8. Never echoes attacker keys, values, or exception details.
 */
export function validatePlainDataObject(raw: unknown): ValidationError | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      code: 'invalid_type',
      message: 'Value must be a plain object',
    };
  }

  // Trap-safe prototype verification
  let proto: unknown;
  try {
    proto = Object.getPrototypeOf(raw);
  } catch {
    return {
      code: 'property_access_error',
      message: 'Failed to inspect object prototype',
    };
  }

  if (proto !== Object.prototype && proto !== null) {
    return {
      code: 'invalid_object_prototype',
      message: 'Only plain objects with standard or null prototype are supported',
    };
  }

  // Trap-safe symbol property rejection
  let symbols: symbol[];
  try {
    symbols = Object.getOwnPropertySymbols(raw);
  } catch {
    return {
      code: 'property_access_error',
      message: 'Failed to inspect symbol properties',
    };
  }
  if (symbols.length > 0) {
    return {
      code: 'symbol_property_rejected',
      message: 'Symbol properties are strictly prohibited',
    };
  }

  // Trap-safe own property names inspection
  let ownNames: string[];
  try {
    ownNames = Object.getOwnPropertyNames(raw);
  } catch {
    return {
      code: 'property_access_error',
      message: 'Failed to inspect own properties',
    };
  }

  if (ownNames.length > 32) {
    return {
      code: 'too_many_keys',
      message: 'Object exceeds maximum permitted property count',
    };
  }

  // Inspect each property descriptor without invoking getters/setters
  for (const key of ownNames) {
    let desc: PropertyDescriptor | undefined;
    try {
      desc = Object.getOwnPropertyDescriptor(raw, key);
    } catch {
      return {
        code: 'property_access_error',
        message: 'Failed to retrieve property descriptor',
      };
    }

    if (!desc) {
      return {
        code: 'property_access_error',
        message: 'Missing property descriptor',
      };
    }

    if (!desc.enumerable) {
      return {
        code: 'non_enumerable_property_rejected',
        message: 'Non-enumerable properties are strictly prohibited',
      };
    }

    // Reject accessors without invoking them
    if (desc.get !== undefined || desc.set !== undefined) {
      return {
        code: 'accessor_property_rejected',
        message: 'Getter and setter accessors are strictly prohibited',
      };
    }
  }

  return null;
}

/**
 * Asserts that raw object has only allowed keys and no unknown properties.
 * Never echoes unknown key names into the message to prevent secret/reflection leaks.
 */
function checkUnknownKeys(
  raw: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
): ValidationError | null {
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      return {
        code: 'unknown_field',
        message: 'Unknown or unexpected property rejected',
      };
    }
  }
  return null;
}

/**
 * Asserts that all required keys exist as OWN enumerable properties.
 * Rejects inherited properties on prototype chain.
 */
function checkRequiredKeys(
  raw: Record<string, unknown>,
  requiredKeys: readonly string[],
  missingErrorCode: ValidationErrorCode,
): ValidationError | null {
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(raw, key) || raw[key] === undefined || raw[key] === null) {
      return {
        code: missingErrorCode,
        message: 'Missing required property',
        path: key,
      };
    }
  }
  return null;
}

// ── Domain-Specific Identifier Validators (Requirement 6) ───────────────────

/**
 * Validates Firestore document IDs (driverId, opId, receiptId, effectId).
 * Must be 1..128 characters, alphanumeric/dot/dash/underscore, strictly rejecting '.' and '..'.
 */
export function validateDocIdentifier(value: unknown, fieldName: string): ValidationError | null {
  if (typeof value !== 'string') {
    return { code: 'invalid_id_type', message: 'Identifier must be a string', path: fieldName };
  }
  if (value.length < ID_MIN_LEN) {
    return { code: 'empty_id', message: 'Identifier must not be empty', path: fieldName };
  }
  if (value.length > ID_MAX_LEN) {
    return { code: 'id_too_long', message: 'Identifier exceeds maximum length', path: fieldName };
  }
  if (/\s/.test(value) || !CANONICAL_DOC_ID_REGEX.test(value)) {
    return { code: 'malformed_id', message: 'Identifier contains illegal characters, whitespace, or path traversal', path: fieldName };
  }
  return null;
}

/**
 * Validates Firebase Auth UIDs (staffUid, actorUid).
 * Permits colon ':' to support federated authentication providers (e.g. auth0:...),
 * while strictly rejecting path traversal, whitespace, slashes, and control chars.
 */
export function validateAuthUid(value: unknown, fieldName: string): ValidationError | null {
  if (typeof value !== 'string') {
    return { code: 'invalid_id_type', message: 'Auth UID must be a string', path: fieldName };
  }
  if (value.length < ID_MIN_LEN) {
    return { code: 'empty_id', message: 'Auth UID must not be empty', path: fieldName };
  }
  if (value.length > ID_MAX_LEN) {
    return { code: 'id_too_long', message: 'Auth UID exceeds maximum length', path: fieldName };
  }
  if (/\s/.test(value) || !AUTH_UID_REGEX.test(value)) {
    return { code: 'malformed_id', message: 'Auth UID contains illegal characters, whitespace, or path traversal', path: fieldName };
  }
  return null;
}

/**
 * Validates company identifiers (1..64 chars, alphanumeric/underscore/dash).
 */
export function validateCompanyIdentifier(value: unknown, fieldName: string): ValidationError | null {
  if (typeof value !== 'string') {
    return { code: 'invalid_id_type', message: 'Company ID must be a string', path: fieldName };
  }
  if (value.length < ID_MIN_LEN) {
    return { code: 'empty_id', message: 'Company ID must not be empty', path: fieldName };
  }
  if (value.length > COMPANY_ID_MAX_LEN) {
    return { code: 'id_too_long', message: 'Company ID exceeds maximum length', path: fieldName };
  }
  if (/\s/.test(value) || !COMPANY_ID_REGEX.test(value)) {
    return { code: 'malformed_id', message: 'Company ID contains illegal characters or whitespace', path: fieldName };
  }
  return null;
}

// ── Integer & Counter Bounds (Requirement 6) ─────────────────────────────────

export function validatePositiveSafeVersion(value: unknown, fieldName: string): ValidationError | null {
  if (typeof value !== 'number') {
    return { code: 'invalid_integer_type', message: 'Version must be a number', path: fieldName };
  }
  if (!Number.isSafeInteger(value)) {
    return { code: 'unsafe_integer', message: 'Version must be a safe integer', path: fieldName };
  }
  if (value < VERSION_MIN) {
    return { code: 'non_positive_integer', message: 'Version must be >= 1', path: fieldName };
  }
  if (value > VERSION_MAX_SAFE) {
    return { code: 'counter_overflow', message: 'Version exceeds safe incrementable limit', path: fieldName };
  }
  return null;
}

export function validateSafeCounter(value: unknown, fieldName: string, maxBound: number): ValidationError | null {
  if (typeof value !== 'number') {
    return { code: 'invalid_integer_type', message: 'Counter must be a number', path: fieldName };
  }
  if (!Number.isSafeInteger(value)) {
    return { code: 'unsafe_integer', message: 'Counter must be a safe integer', path: fieldName };
  }
  if (value < COUNTER_MIN) {
    return { code: 'non_positive_integer', message: 'Counter must be non-negative (>= 0)', path: fieldName };
  }
  if (value > maxBound || value >= Number.MAX_SAFE_INTEGER) {
    return { code: 'counter_overflow', message: 'Counter exceeds safe bounded limit', path: fieldName };
  }
  return null;
}

// ── Timestamp & Chronology Validators (Requirement 6) ────────────────────────

const STRICT_ISO_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export function validateStrictIsoTimestamp(value: unknown, fieldName: string): ValidationError | null {
  if (typeof value !== 'string' || value.length === 0) {
    return { code: 'invalid_timestamp', message: 'Timestamp must be a non-empty ISO string', path: fieldName };
  }
  if (!STRICT_ISO_REGEX.test(value)) {
    return { code: 'malformed_timestamp', message: 'Timestamp must match strict ISO 8601 UTC format', path: fieldName };
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return { code: 'malformed_timestamp', message: 'Timestamp is not a valid date', path: fieldName };
  }
  const year = new Date(parsed).getUTCFullYear();
  if (year < 2020 || year > 2100) {
    return { code: 'malformed_timestamp', message: 'Timestamp year is out of valid operational range', path: fieldName };
  }
  return null;
}

// ── Scrypt Parameters & Base64 Validation (Requirement 4) ────────────────────

/**
 * Strict canonical base64 check:
 * Decodes the string and canonically re-encodes it. If the re-encoded string does not
 * strictly equal the input, it fails closed (catches non-canonical padding, extra bits, corruption).
 */
export function isStrictCanonicalBase64(str: string): boolean {
  if (typeof str !== 'string' || str.length === 0 || str.length % 4 !== 0) {
    return false;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(str)) {
    return false;
  }
  try {
    const buf = Buffer.from(str, 'base64');
    return buf.toString('base64') === str;
  } catch {
    return false;
  }
}

/**
 * Validates scrypt parameters and crypto material strictly derived from passcode.ts.
 */
function validateScryptParameters(raw: Record<string, unknown>): ValidationError | null {
  if (raw.algo !== CANONICAL_SCRYPT_ALGO) {
    return { code: 'invalid_algo', message: "Algorithm must be 'scrypt'", path: 'algo' };
  }

  // N: power of 2, 1024..65536
  if (
    typeof raw.N !== 'number' ||
    !Number.isSafeInteger(raw.N) ||
    raw.N < SCRYPT_BOUNDS.N.min ||
    raw.N > SCRYPT_BOUNDS.N.max ||
    (raw.N & (raw.N - 1)) !== 0
  ) {
    return { code: 'invalid_scrypt_parameter', message: 'Scrypt parameter N must be a power of 2 within safe bounds', path: 'N' };
  }

  // r: 1..16
  if (
    typeof raw.r !== 'number' ||
    !Number.isSafeInteger(raw.r) ||
    raw.r < SCRYPT_BOUNDS.r.min ||
    raw.r > SCRYPT_BOUNDS.r.max
  ) {
    return { code: 'invalid_scrypt_parameter', message: 'Scrypt parameter r out of bounds', path: 'r' };
  }

  // p: 1..4
  if (
    typeof raw.p !== 'number' ||
    !Number.isSafeInteger(raw.p) ||
    raw.p < SCRYPT_BOUNDS.p.min ||
    raw.p > SCRYPT_BOUNDS.p.max
  ) {
    return { code: 'invalid_scrypt_parameter', message: 'Scrypt parameter p out of bounds', path: 'p' };
  }

  // keyLen: 16..64
  if (
    typeof raw.keyLen !== 'number' ||
    !Number.isSafeInteger(raw.keyLen) ||
    raw.keyLen < SCRYPT_BOUNDS.keyLen.min ||
    raw.keyLen > SCRYPT_BOUNDS.keyLen.max
  ) {
    return { code: 'invalid_scrypt_parameter', message: 'Scrypt parameter keyLen out of bounds', path: 'keyLen' };
  }

  // Memory ceiling check: 128 * N * r <= 32 MB
  const memoryUsage = 128 * raw.N * raw.r;
  if (memoryUsage > SCRYPT_BOUNDS.maxMemoryBytes) {
    return { code: 'excessive_scrypt_memory', message: 'Scrypt parameter memory footprint exceeds maximum safety ceiling', path: 'N' };
  }

  // Salt validation: strict canonical base64, 16..32 bytes
  if (typeof raw.saltB64 !== 'string') {
    return { code: 'invalid_salt_type', message: 'saltB64 must be a string', path: 'saltB64' };
  }
  if (raw.saltB64.length === 0) {
    return { code: 'empty_salt', message: 'saltB64 must not be empty', path: 'saltB64' };
  }
  if (!isStrictCanonicalBase64(raw.saltB64)) {
    return { code: 'invalid_salt', message: 'saltB64 must be strict canonical base64', path: 'saltB64' };
  }
  const saltBytes = Buffer.from(raw.saltB64, 'base64').length;
  if (saltBytes < SCRYPT_BOUNDS.minSaltBytes) {
    return { code: 'salt_too_short', message: 'saltB64 decoded bytes below minimum boundary', path: 'saltB64' };
  }
  if (saltBytes > SCRYPT_BOUNDS.maxSaltBytes) {
    return { code: 'salt_too_long', message: 'saltB64 decoded bytes exceed maximum boundary', path: 'saltB64' };
  }

  // Hash validation: strict canonical base64, decoded bytes MUST EXACTLY EQUAL keyLen
  if (typeof raw.hashB64 !== 'string') {
    return { code: 'invalid_hash_type', message: 'hashB64 must be a string', path: 'hashB64' };
  }
  if (raw.hashB64.length === 0) {
    return { code: 'empty_hash', message: 'hashB64 must not be empty', path: 'hashB64' };
  }
  if (!isStrictCanonicalBase64(raw.hashB64)) {
    return { code: 'invalid_hash', message: 'hashB64 must be strict canonical base64', path: 'hashB64' };
  }
  const hashBytes = Buffer.from(raw.hashB64, 'base64').length;
  if (hashBytes !== raw.keyLen) {
    return { code: 'hash_keylen_mismatch', message: 'hashB64 decoded byte length does not equal keyLen', path: 'hashB64' };
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

const REQUEST_REQUIRED_KEYS = [
  'opId',
  'companyId',
  'driverId',
  'expectedCredentialVersion',
  'temporary',
  'newPasscode',
] as const;

/**
 * Validates a wire CanonicalResetRequest.
 * Enforces plain data, exact key allowlist, domain bounds, and numeric-only passcode.
 * Returns deeply frozen validated request.
 */
export function validateCanonicalResetRequest(
  raw: unknown,
): ValidationResult<CanonicalResetRequest> {
  const plainObjError = validatePlainDataObject(raw);
  if (plainObjError) return { ok: false, error: plainObjError };

  const obj = raw as Record<string, unknown>;

  const unknownError = checkUnknownKeys(obj, REQUEST_ALLOWED_KEYS);
  if (unknownError) return { ok: false, error: unknownError };

  const missingError = checkRequiredKeys(obj, REQUEST_REQUIRED_KEYS, 'missing_field');
  if (missingError) return { ok: false, error: missingError };

  const opIdError = validateDocIdentifier(obj.opId, 'opId');
  if (opIdError) return { ok: false, error: opIdError };

  const companyIdError = validateCompanyIdentifier(obj.companyId, 'companyId');
  if (companyIdError) return { ok: false, error: companyIdError };

  const driverIdError = validateDocIdentifier(obj.driverId, 'driverId');
  if (driverIdError) return { ok: false, error: driverIdError };

  const versionError = validatePositiveSafeVersion(obj.expectedCredentialVersion, 'expectedCredentialVersion');
  if (versionError) return { ok: false, error: versionError };

  if (typeof obj.temporary !== 'boolean') {
    return {
      ok: false,
      error: { code: 'invalid_temporary_type', message: 'Field temporary must be an explicit boolean', path: 'temporary' },
    };
  }

  if (typeof obj.newPasscode !== 'string') {
    return {
      ok: false,
      error: { code: 'invalid_passcode_type', message: 'Passcode must be a string', path: 'newPasscode' },
    };
  }
  if (obj.newPasscode.length === 0) {
    return {
      ok: false,
      error: { code: 'empty_passcode', message: 'Passcode must not be empty', path: 'newPasscode' },
    };
  }
  if (obj.newPasscode.length < PASSCODE_DIGIT_MIN_LEN) {
    return {
      ok: false,
      error: { code: 'passcode_too_short', message: 'Passcode length below minimum allowed boundary', path: 'newPasscode' },
    };
  }
  if (obj.newPasscode.length > PASSCODE_DIGIT_MAX_LEN) {
    return {
      ok: false,
      error: { code: 'passcode_too_long', message: 'Passcode length exceeds maximum allowed boundary', path: 'newPasscode' },
    };
  }
  if (!PASSCODE_DIGITS_REGEX.test(obj.newPasscode)) {
    return {
      ok: false,
      error: { code: 'passcode_non_numeric', message: 'Passcode must contain numeric digits only', path: 'newPasscode' },
    };
  }

  const result: CanonicalResetRequest = {
    opId: obj.opId as string,
    companyId: obj.companyId as string,
    driverId: obj.driverId as string,
    expectedCredentialVersion: obj.expectedCredentialVersion as number,
    temporary: obj.temporary as boolean,
    newPasscode: obj.newPasscode as string,
  };

  return { ok: true, value: deepFreeze(result) };
}

/**
 * Validates and converts a wire request into the internal secret-bearing validated type.
 * Secrets exist ONLY in this explicitly named type.
 */
export function createValidatedSecretBearingRequest(
  request: CanonicalResetRequest,
  commitmentHash: string,
): ValidatedSecretBearingResetRequest {
  return deepFreeze({
    __secretBearing: true as const,
    opId: request.opId,
    companyId: request.companyId,
    driverId: request.driverId,
    expectedCredentialVersion: request.expectedCredentialVersion,
    temporary: request.temporary,
    newPasscode: request.newPasscode,
    passcodeDigitCount: request.newPasscode.length,
    commitmentHash,
  });
}

/**
 * Creates a sanitized, public operation commitment from an internal secret-bearing request.
 * Completely strips the plaintext passcode.
 */
export function createSanitizedOperationCommitment(
  secretReq: ValidatedSecretBearingResetRequest,
  actorUid: string,
  createdAt: string,
): CanonicalResetOperationCommitment {
  return deepFreeze({
    opId: secretReq.opId,
    companyId: secretReq.companyId,
    driverId: secretReq.driverId,
    expectedCredentialVersion: secretReq.expectedCredentialVersion,
    temporary: secretReq.temporary,
    passcodeDigitCount: secretReq.passcodeDigitCount,
    commitmentHash: secretReq.commitmentHash,
    actorUid,
    createdAt,
  });
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

const CREDENTIAL_REQUIRED_KEYS = [
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
] as const;

export function validateCanonicalCredential(
  raw: unknown,
  expectedBinding?: { driverId: string; companyId: string },
): ValidationResult<CanonicalCredential> {
  const plainObjError = validatePlainDataObject(raw);
  if (plainObjError) return { ok: false, error: plainObjError };

  const obj = raw as Record<string, unknown>;

  const unknownError = checkUnknownKeys(obj, CREDENTIAL_ALLOWED_KEYS);
  if (unknownError) return { ok: false, error: unknownError };

  const missingError = checkRequiredKeys(obj, CREDENTIAL_REQUIRED_KEYS, 'missing_credential_field');
  if (missingError) return { ok: false, error: missingError };

  const scryptError = validateScryptParameters(obj);
  if (scryptError) return { ok: false, error: scryptError };

  const driverIdError = validateDocIdentifier(obj.driverId, 'driverId');
  if (driverIdError) return { ok: false, error: driverIdError };

  const companyIdError = validateCompanyIdentifier(obj.companyId, 'companyId');
  if (companyIdError) return { ok: false, error: companyIdError };

  if (expectedBinding) {
    if (obj.driverId !== expectedBinding.driverId) {
      return { ok: false, error: { code: 'driver_binding_mismatch', message: 'Credential driverId mismatch', path: 'driverId' } };
    }
    if (obj.companyId !== expectedBinding.companyId) {
      return { ok: false, error: { code: 'company_binding_mismatch', message: 'Credential companyId mismatch', path: 'companyId' } };
    }
  }

  const versionError = validatePositiveSafeVersion(obj.credentialVersion, 'credentialVersion');
  if (versionError) return { ok: false, error: versionError };

  if (typeof obj.active !== 'boolean') {
    return {
      ok: false,
      error: { code: 'invalid_active_type', message: 'Field active must be an explicit boolean', path: 'active' },
    };
  }

  if (obj.active !== true) {
    return {
      ok: false,
      error: { code: 'inactive_credential', message: 'Credential active status must be true for reset eligibility', path: 'active' },
    };
  }

  const result: CanonicalCredential = {
    algo: obj.algo as typeof CANONICAL_SCRYPT_ALGO,
    N: obj.N as number,
    r: obj.r as number,
    p: obj.p as number,
    keyLen: obj.keyLen as number,
    saltB64: obj.saltB64 as string,
    hashB64: obj.hashB64 as string,
    driverId: obj.driverId as string,
    companyId: obj.companyId as string,
    credentialVersion: obj.credentialVersion as number,
    active: true,
  };

  return { ok: true, value: deepFreeze(result) };
}

// ── 3. Current Source Driver Credential Validator (Requirement 7) ────────────

const CURRENT_CRED_DOC_ALLOWED_KEYS = new Set<string>([
  'displayNameNorm',
  'displayName',
  'passcode',
  'active',
  'mustResetPasscode',
  'createdAt',
  'updatedAt',
  'tier',
  'source',
]);

/**
 * Validates the CURRENT Firestore document stored under driver_credentials/{driverId}.
 * Reconciles current nested passcode structure with future design.
 */
export function validateCurrentDriverCredentialDoc(
  raw: unknown,
): ValidationResult<CurrentDriverCredentialDoc> {
  const plainObjError = validatePlainDataObject(raw);
  if (plainObjError) return { ok: false, error: plainObjError };

  const obj = raw as Record<string, unknown>;

  const unknownError = checkUnknownKeys(obj, CURRENT_CRED_DOC_ALLOWED_KEYS);
  if (unknownError) return { ok: false, error: unknownError };

  if (!obj.passcode || typeof obj.passcode !== 'object') {
    return {
      ok: false,
      error: { code: 'missing_credential_field', message: 'Current credential document must contain passcode object', path: 'passcode' },
    };
  }

  const passcodeObjError = validatePlainDataObject(obj.passcode);
  if (passcodeObjError) return { ok: false, error: passcodeObjError };

  const scryptError = validateScryptParameters(obj.passcode as Record<string, unknown>);
  if (scryptError) return { ok: false, error: scryptError };

  return {
    ok: true,
    value: deepFreeze(obj as unknown as CurrentDriverCredentialDoc),
  };
}

// ── 4. Driver Session Binding Validator ─────────────────────────────────────

const SESSION_ALLOWED_KEYS = new Set<string>([
  'sessionId',
  'driverId',
  'companyId',
  'credentialVersion',
]);

const SESSION_REQUIRED_KEYS = [
  'sessionId',
  'driverId',
  'companyId',
  'credentialVersion',
] as const;

export function validateDriverSessionBinding(
  raw: unknown,
): ValidationResult<DriverSessionBinding> {
  const plainObjError = validatePlainDataObject(raw);
  if (plainObjError) return { ok: false, error: plainObjError };

  const obj = raw as Record<string, unknown>;

  const unknownError = checkUnknownKeys(obj, SESSION_ALLOWED_KEYS);
  if (unknownError) return { ok: false, error: unknownError };

  const missingError = checkRequiredKeys(obj, SESSION_REQUIRED_KEYS, 'missing_session_field');
  if (missingError) return { ok: false, error: missingError };

  const sessionIdError = validateDocIdentifier(obj.sessionId, 'sessionId');
  if (sessionIdError) return { ok: false, error: sessionIdError };

  const driverIdError = validateDocIdentifier(obj.driverId, 'driverId');
  if (driverIdError) return { ok: false, error: driverIdError };

  const companyIdError = validateCompanyIdentifier(obj.companyId, 'companyId');
  if (companyIdError) return { ok: false, error: companyIdError };

  const versionError = validatePositiveSafeVersion(obj.credentialVersion, 'credentialVersion');
  if (versionError) return { ok: false, error: versionError };

  const result: DriverSessionBinding = {
    sessionId: obj.sessionId as string,
    driverId: obj.driverId as string,
    companyId: obj.companyId as string,
    credentialVersion: obj.credentialVersion as number,
  };

  return { ok: true, value: deepFreeze(result) };
}

/**
 * Composite validator: verifies driver session version match against current credentials.
 * CRITICAL (Requirement 3): Must validate both operands first!
 */
export function validateSessionVersionMatch(
  sessionRaw: unknown,
  credentialRaw: unknown,
): ValidationResult<{ matched: true; currentVersion: number }> {
  const sessionValidation = validateDriverSessionBinding(sessionRaw);
  if (!sessionValidation.ok) {
    return { ok: false, error: sessionValidation.error };
  }

  const credentialValidation = validateCanonicalCredential(credentialRaw);
  if (!credentialValidation.ok) {
    return { ok: false, error: credentialValidation.error };
  }

  const session = sessionValidation.value;
  const credential = credentialValidation.value;

  if (session.driverId !== credential.driverId) {
    return {
      ok: false,
      error: { code: 'session_driver_mismatch', message: 'Session driverId does not match credential driverId', path: 'driverId' },
    };
  }

  if (session.companyId !== credential.companyId) {
    return {
      ok: false,
      error: { code: 'session_company_mismatch', message: 'Session companyId does not match credential companyId', path: 'companyId' },
    };
  }

  if (credential.active !== true) {
    return {
      ok: false,
      error: { code: 'credential_inactive', message: 'Driver credential is not active', path: 'active' },
    };
  }

  if (session.credentialVersion !== credential.credentialVersion) {
    return {
      ok: false,
      error: { code: 'session_credential_version_mismatch', message: 'Session credential version is stale or revoked', path: 'credentialVersion' },
    };
  }

  return {
    ok: true,
    value: deepFreeze({ matched: true as const, currentVersion: credential.credentialVersion }),
  };
}

// ── 5. Reset Receipt Validator ───────────────────────────────────────────────

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

const RECEIPT_REQUIRED_KEYS = [
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
] as const;

export function validateResetReceipt(raw: unknown): ValidationResult<ResetReceipt> {
  const plainObjError = validatePlainDataObject(raw);
  if (plainObjError) return { ok: false, error: plainObjError };

  const obj = raw as Record<string, unknown>;

  const unknownError = checkUnknownKeys(obj, RECEIPT_ALLOWED_KEYS);
  if (unknownError) return { ok: false, error: unknownError };

  const missingError = checkRequiredKeys(obj, RECEIPT_REQUIRED_KEYS, 'missing_receipt_field');
  if (missingError) return { ok: false, error: missingError };

  const receiptIdError = validateDocIdentifier(obj.receiptId, 'receiptId');
  if (receiptIdError) return { ok: false, error: receiptIdError };

  const opIdError = validateDocIdentifier(obj.opId, 'opId');
  if (opIdError) return { ok: false, error: opIdError };

  const companyIdError = validateCompanyIdentifier(obj.companyId, 'companyId');
  if (companyIdError) return { ok: false, error: companyIdError };

  const driverIdError = validateDocIdentifier(obj.driverId, 'driverId');
  if (driverIdError) return { ok: false, error: driverIdError };

  const actorUidError = validateAuthUid(obj.actorUid, 'actorUid');
  if (actorUidError) return { ok: false, error: actorUidError };

  const prevVersionError = validatePositiveSafeVersion(obj.previousCredentialVersion, 'previousCredentialVersion');
  if (prevVersionError) return { ok: false, error: prevVersionError };

  const newVersionError = validatePositiveSafeVersion(obj.newCredentialVersion, 'newCredentialVersion');
  if (newVersionError) return { ok: false, error: newVersionError };

  if ((obj.newCredentialVersion as number) !== (obj.previousCredentialVersion as number) + 1) {
    return {
      ok: false,
      error: { code: 'invalid_credential_version_progression', message: 'newCredentialVersion must be exactly previousCredentialVersion + 1', path: 'newCredentialVersion' },
    };
  }

  if (typeof obj.temporary !== 'boolean') {
    return {
      ok: false,
      error: { code: 'invalid_temporary_type', message: 'Field temporary must be an explicit boolean', path: 'temporary' },
    };
  }

  const timestampError = validateStrictIsoTimestamp(obj.appliedAt, 'appliedAt');
  if (timestampError) return { ok: false, error: timestampError };

  if (obj.status !== 'committed') {
    return {
      ok: false,
      error: { code: 'invalid_receipt_status', message: "Receipt status must be 'committed'", path: 'status' },
    };
  }

  if (obj.authCleanupStatus !== 'pending' && obj.authCleanupStatus !== 'enqueued') {
    return {
      ok: false,
      error: { code: 'invalid_receipt_auth_cleanup_status', message: "Receipt authCleanupStatus must be 'pending' or 'enqueued'", path: 'authCleanupStatus' },
    };
  }

  const result: ResetReceipt = {
    receiptId: obj.receiptId as string,
    opId: obj.opId as string,
    companyId: obj.companyId as string,
    driverId: obj.driverId as string,
    previousCredentialVersion: obj.previousCredentialVersion as number,
    newCredentialVersion: obj.newCredentialVersion as number,
    temporary: obj.temporary as boolean,
    actorUid: obj.actorUid as string,
    appliedAt: obj.appliedAt as string,
    status: 'committed',
    authCleanupStatus: obj.authCleanupStatus as 'pending' | 'enqueued',
  };

  return { ok: true, value: deepFreeze(result) };
}

// ── 6. Auth Cleanup Effect Validator ─────────────────────────────────────────

const EFFECT_ALLOWED_KEYS = new Set<string>([
  'effectId',
  'opId',
  'companyId',
  'driverId',
  'credentialVersion',
  'status',
  'attempts',
  'fenceGeneration',
  'createdAt',
  'lastAttemptAt',
  'completedAt',
  'failedAt',
  'terminalError',
]);

const EFFECT_REQUIRED_KEYS = [
  'effectId',
  'opId',
  'companyId',
  'driverId',
  'credentialVersion',
  'status',
  'attempts',
  'fenceGeneration',
  'createdAt',
] as const;

const VALID_EFFECT_STATUSES = new Set<EffectStatus>([
  'pending',
  'in_progress',
  'completed',
  'failed',
]);

export function validateAuthCleanupEffect(raw: unknown): ValidationResult<AuthCleanupEffect> {
  const plainObjError = validatePlainDataObject(raw);
  if (plainObjError) return { ok: false, error: plainObjError };

  const obj = raw as Record<string, unknown>;

  const unknownError = checkUnknownKeys(obj, EFFECT_ALLOWED_KEYS);
  if (unknownError) return { ok: false, error: unknownError };

  const missingError = checkRequiredKeys(obj, EFFECT_REQUIRED_KEYS, 'missing_effect_field');
  if (missingError) return { ok: false, error: missingError };

  const effectIdError = validateDocIdentifier(obj.effectId, 'effectId');
  if (effectIdError) return { ok: false, error: effectIdError };

  const opIdError = validateDocIdentifier(obj.opId, 'opId');
  if (opIdError) return { ok: false, error: opIdError };

  const companyIdError = validateCompanyIdentifier(obj.companyId, 'companyId');
  if (companyIdError) return { ok: false, error: companyIdError };

  const driverIdError = validateDocIdentifier(obj.driverId, 'driverId');
  if (driverIdError) return { ok: false, error: driverIdError };

  const versionError = validatePositiveSafeVersion(obj.credentialVersion, 'credentialVersion');
  if (versionError) return { ok: false, error: versionError };

  if (typeof obj.status !== 'string' || !VALID_EFFECT_STATUSES.has(obj.status as EffectStatus)) {
    return {
      ok: false,
      error: { code: 'invalid_effect_status', message: 'Invalid effect status value', path: 'status' },
    };
  }

  const attemptsError = validateSafeCounter(obj.attempts, 'attempts', MAX_RETRY_ATTEMPTS);
  if (attemptsError) return { ok: false, error: attemptsError };

  const fenceError = validateSafeCounter(obj.fenceGeneration, 'fenceGeneration', COUNTER_MAX_SAFE);
  if (fenceError) return { ok: false, error: fenceError };

  const createdAtError = validateStrictIsoTimestamp(obj.createdAt, 'createdAt');
  if (createdAtError) return { ok: false, error: createdAtError };

  const createdTime = Date.parse(obj.createdAt as string);

  // Chronology on lastAttemptAt
  if (obj.lastAttemptAt !== undefined && obj.lastAttemptAt !== null) {
    const lastAttemptError = validateStrictIsoTimestamp(obj.lastAttemptAt, 'lastAttemptAt');
    if (lastAttemptError) return { ok: false, error: lastAttemptError };
    const attemptTime = Date.parse(obj.lastAttemptAt as string);
    if (attemptTime < createdTime) {
      return {
        ok: false,
        error: { code: 'chronology_violation', message: 'lastAttemptAt cannot precede createdAt', path: 'lastAttemptAt' },
      };
    }
  }

  // Status-specific invariants & Chronology
  if (obj.status === 'pending') {
    if (obj.completedAt != null || obj.failedAt != null || obj.terminalError != null) {
      return {
        ok: false,
        error: { code: 'contradictory_effect_status', message: 'Pending effect must not have completion, failure, or terminal error', path: 'status' },
      };
    }
  }

  if (obj.status === 'completed') {
    if (obj.completedAt == null) {
      return {
        ok: false,
        error: { code: 'contradictory_effect_status', message: 'Completed effect must have completedAt set', path: 'completedAt' },
      };
    }
    const completedError = validateStrictIsoTimestamp(obj.completedAt, 'completedAt');
    if (completedError) return { ok: false, error: completedError };

    const completedTime = Date.parse(obj.completedAt as string);
    if (completedTime < createdTime) {
      return {
        ok: false,
        error: { code: 'chronology_violation', message: 'completedAt cannot precede createdAt', path: 'completedAt' },
      };
    }
    if (obj.lastAttemptAt != null) {
      const lastAttemptTime = Date.parse(obj.lastAttemptAt as string);
      if (completedTime < lastAttemptTime) {
        return {
          ok: false,
          error: { code: 'chronology_violation', message: 'completedAt cannot precede lastAttemptAt', path: 'completedAt' },
        };
      }
    }

    if (obj.terminalError != null || obj.failedAt != null) {
      return {
        ok: false,
        error: { code: 'contradictory_effect_status', message: 'Completed effect must not have terminalError or failedAt set', path: 'terminalError' },
      };
    }
  }

  if (obj.status === 'failed') {
    if (obj.terminalError == null) {
      return {
        ok: false,
        error: { code: 'missing_terminal_error', message: 'Failed effect must provide a terminalError code', path: 'terminalError' },
      };
    }
    if (!TERMINAL_ERROR_CODES.includes(obj.terminalError as TerminalErrorCode)) {
      return {
        ok: false,
        error: { code: 'invalid_terminal_error', message: 'Unknown terminal error code', path: 'terminalError' },
      };
    }
    if (obj.failedAt != null) {
      const failedAtError = validateStrictIsoTimestamp(obj.failedAt, 'failedAt');
      if (failedAtError) return { ok: false, error: failedAtError };
      const failedTime = Date.parse(obj.failedAt as string);
      if (failedTime < createdTime) {
        return {
          ok: false,
          error: { code: 'chronology_violation', message: 'failedAt cannot precede createdAt', path: 'failedAt' },
        };
      }
    }
  }

  const result: AuthCleanupEffect = {
    effectId: obj.effectId as string,
    opId: obj.opId as string,
    companyId: obj.companyId as string,
    driverId: obj.driverId as string,
    credentialVersion: obj.credentialVersion as number,
    status: obj.status as EffectStatus,
    attempts: obj.attempts as number,
    fenceGeneration: obj.fenceGeneration as number,
    createdAt: obj.createdAt as string,
    lastAttemptAt: (obj.lastAttemptAt as string | null | undefined) ?? null,
    completedAt: (obj.completedAt as string | null | undefined) ?? null,
    failedAt: (obj.failedAt as string | null | undefined) ?? null,
    terminalError: (obj.terminalError as TerminalErrorCode | null | undefined) ?? null,
  };

  return { ok: true, value: deepFreeze(result) };
}

// ── 7. Composite Alignment & Transition Helpers (Requirement 3 & 5) ──────────

/**
 * Composite validator: verifies alignment between ResetReceipt and AuthCleanupEffect.
 * CRITICAL: Both operands are validated first!
 */
export function validateReceiptEffectAlignment(
  receiptRaw: unknown,
  effectRaw: unknown,
): ValidationResult<true> {
  const receiptValidation = validateResetReceipt(receiptRaw);
  if (!receiptValidation.ok) {
    return { ok: false, error: receiptValidation.error };
  }

  const effectValidation = validateAuthCleanupEffect(effectRaw);
  if (!effectValidation.ok) {
    return { ok: false, error: effectValidation.error };
  }

  const receipt = receiptValidation.value;
  const effect = effectValidation.value;

  if (receipt.opId !== effect.opId) {
    return {
      ok: false,
      error: { code: 'op_id_mismatch', message: 'Receipt and Effect opId mismatch', path: 'opId' },
    };
  }

  if (receipt.driverId !== effect.driverId) {
    return {
      ok: false,
      error: { code: 'driver_id_mismatch', message: 'Receipt and Effect driverId mismatch', path: 'driverId' },
    };
  }

  if (receipt.companyId !== effect.companyId) {
    return {
      ok: false,
      error: { code: 'company_id_mismatch', message: 'Receipt and Effect companyId mismatch', path: 'companyId' },
    };
  }

  if (receipt.newCredentialVersion !== effect.credentialVersion) {
    return {
      ok: false,
      error: { code: 'credential_version_mismatch', message: 'Receipt newCredentialVersion does not match Effect credentialVersion', path: 'credentialVersion' },
    };
  }

  // Forbidden combination: Receipt claiming completed cleanup
  if ((receipt.authCleanupStatus as string) === 'completed') {
    return {
      ok: false,
      error: { code: 'receipt_effect_status_contradiction', message: 'Receipt cannot claim completed auth cleanup at creation time', path: 'authCleanupStatus' },
    };
  }

  return { ok: true, value: true };
}

/**
 * Enforces forward-only lifecycle state transitions on AuthCleanupEffect records.
 * Prohibits backward transitions, completed replays, and fence regression.
 */
export function validateEffectLifecycleTransition(
  currentEffectRaw: unknown,
  nextEffectRaw: unknown,
): ValidationResult<true> {
  const currentValidation = validateAuthCleanupEffect(currentEffectRaw);
  if (!currentValidation.ok) return { ok: false, error: currentValidation.error };

  const nextValidation = validateAuthCleanupEffect(nextEffectRaw);
  if (!nextValidation.ok) return { ok: false, error: nextValidation.error };

  const current = currentValidation.value;
  const next = nextValidation.value;

  // Identity binding preservation
  if (
    current.effectId !== next.effectId ||
    current.opId !== next.opId ||
    current.driverId !== next.driverId ||
    current.companyId !== next.companyId ||
    current.credentialVersion !== next.credentialVersion
  ) {
    return {
      ok: false,
      error: { code: 'op_id_mismatch', message: 'Lifecycle transition identity mismatch', path: 'effectId' },
    };
  }

  // Fence generation must not regress
  if (next.fenceGeneration < current.fenceGeneration) {
    return {
      ok: false,
      error: { code: 'forbidden_backward_transition', message: 'Fence generation cannot regress', path: 'fenceGeneration' },
    };
  }

  // Completed status is terminal
  if (current.status === 'completed') {
    return {
      ok: false,
      error: { code: 'forbidden_backward_transition', message: 'Completed effect is terminal and cannot be transitioned or replayed', path: 'status' },
    };
  }

  // Check allowed transitions
  const allowed = ALLOWED_EFFECT_TRANSITIONS[current.status];
  if (!allowed.includes(next.status)) {
    return {
      ok: false,
      error: { code: 'unsupported_transition', message: 'State transition not allowed by forward-only lifecycle model', path: 'status' },
    };
  }

  return { ok: true, value: true };
}

/**
 * Idempotent retry vs Changed-request conflict validator.
 * If opId matches:
 * - Identical parameters: idempotent replay allowed.
 * - Any parameter changed: CONFLICT error returned.
 */
export function validateOperationRetryCommitment(
  existingCommitmentRaw: unknown,
  incomingRequestRaw: unknown,
): ValidationResult<{ isIdempotentRetry: boolean }> {
  const plainCommitment = validatePlainDataObject(existingCommitmentRaw);
  if (plainCommitment) return { ok: false, error: plainCommitment };

  const requestValidation = validateCanonicalResetRequest(incomingRequestRaw);
  if (!requestValidation.ok) return { ok: false, error: requestValidation.error };

  const existing = existingCommitmentRaw as CanonicalResetOperationCommitment;
  const incoming = requestValidation.value;

  if (existing.opId !== incoming.opId) {
    return {
      ok: false,
      error: { code: 'op_id_mismatch', message: 'Operation ID does not match existing commitment', path: 'opId' },
    };
  }

  // Check bound operational parameters for conflict
  if (
    existing.companyId !== incoming.companyId ||
    existing.driverId !== incoming.driverId ||
    existing.expectedCredentialVersion !== incoming.expectedCredentialVersion ||
    existing.temporary !== incoming.temporary
  ) {
    return {
      ok: false,
      error: { code: 'idempotent_retry_conflict', message: 'Operation ID reused with conflicting request parameters', path: 'opId' },
    };
  }

  return { ok: true, value: { isIdempotentRetry: true } };
}

// ── 8. Separate Authority Planes Validators (Requirement 1) ──────────────────

const PRINCIPAL_ALLOWED_KEYS = new Set<string>([
  'staffUid',
  'authTime',
  'email',
  'emailVerified',
  'isAnonymous',
  'disabled',
]);

export function validateStaffPrincipal(raw: unknown): ValidationResult<StaffPrincipal> {
  const plainError = validatePlainDataObject(raw);
  if (plainError) return { ok: false, error: plainError };

  const obj = raw as Record<string, unknown>;
  const unknownError = checkUnknownKeys(obj, PRINCIPAL_ALLOWED_KEYS);
  if (unknownError) return { ok: false, error: unknownError };

  const uidError = validateAuthUid(obj.staffUid, 'staffUid');
  if (uidError) return { ok: false, error: uidError };

  const authTimeError = validateStrictIsoTimestamp(obj.authTime, 'authTime');
  if (authTimeError) return { ok: false, error: authTimeError };

  if (obj.emailVerified !== true) {
    return { ok: false, error: { code: 'unauthorized_actor', message: 'Staff actor email must be verified', path: 'emailVerified' } };
  }

  if (obj.isAnonymous !== false) {
    return { ok: false, error: { code: 'unauthorized_actor', message: 'Anonymous staff principals are prohibited', path: 'isAnonymous' } };
  }

  if (obj.disabled !== false) {
    return { ok: false, error: { code: 'unauthorized_actor', message: 'Disabled staff principals cannot perform resets', path: 'disabled' } };
  }

  return {
    ok: true,
    value: deepFreeze({
      staffUid: obj.staffUid as string,
      authTime: obj.authTime as string,
      email: obj.email as string | undefined,
      emailVerified: true as const,
      isAnonymous: false as const,
      disabled: false as const,
    }),
  };
}

const MEMBERSHIP_ALLOWED_KEYS = new Set<string>([
  'membershipId',
  'companyId',
  'staffUid',
  'status',
  'joinedAt',
]);

export function validateTenantMembership(raw: unknown): ValidationResult<TenantMembership> {
  const plainError = validatePlainDataObject(raw);
  if (plainError) return { ok: false, error: plainError };

  const obj = raw as Record<string, unknown>;
  const unknownError = checkUnknownKeys(obj, MEMBERSHIP_ALLOWED_KEYS);
  if (unknownError) return { ok: false, error: unknownError };

  const membershipIdError = validateDocIdentifier(obj.membershipId, 'membershipId');
  if (membershipIdError) return { ok: false, error: membershipIdError };

  const companyIdError = validateCompanyIdentifier(obj.companyId, 'companyId');
  if (companyIdError) return { ok: false, error: companyIdError };

  const uidError = validateAuthUid(obj.staffUid, 'staffUid');
  if (uidError) return { ok: false, error: uidError };

  if (obj.status !== 'active') {
    return { ok: false, error: { code: 'membership_inactive', message: 'Staff membership is not active in this company', path: 'status' } };
  }

  const joinedError = validateStrictIsoTimestamp(obj.joinedAt, 'joinedAt');
  if (joinedError) return { ok: false, error: joinedError };

  return {
    ok: true,
    value: deepFreeze({
      membershipId: obj.membershipId as string,
      companyId: obj.companyId as string,
      staffUid: obj.staffUid as string,
      status: 'active' as const,
      joinedAt: obj.joinedAt as string,
    }),
  };
}

const CAPABILITIES_ALLOWED_KEYS = new Set<string>([
  'companyId',
  'staffUid',
  'roles',
  'capabilities',
  'canResetDriverPasscode',
  'canIssuePermanentPasscode',
]);

export function validateTenantRoleCapabilities(raw: unknown): ValidationResult<TenantRoleCapabilities> {
  const plainError = validatePlainDataObject(raw);
  if (plainError) return { ok: false, error: plainError };

  const obj = raw as Record<string, unknown>;
  const unknownError = checkUnknownKeys(obj, CAPABILITIES_ALLOWED_KEYS);
  if (unknownError) return { ok: false, error: unknownError };

  const companyIdError = validateCompanyIdentifier(obj.companyId, 'companyId');
  if (companyIdError) return { ok: false, error: companyIdError };

  const uidError = validateAuthUid(obj.staffUid, 'staffUid');
  if (uidError) return { ok: false, error: uidError };

  if (!Array.isArray(obj.roles) || !Array.isArray(obj.capabilities)) {
    return { ok: false, error: { code: 'invalid_type', message: 'Roles and capabilities must be arrays', path: 'roles' } };
  }

  if (obj.canResetDriverPasscode !== true) {
    return { ok: false, error: { code: 'unauthorized_actor', message: 'Actor lacks canResetDriverPasscode capability in this company', path: 'canResetDriverPasscode' } };
  }

  return {
    ok: true,
    value: deepFreeze({
      companyId: obj.companyId as string,
      staffUid: obj.staffUid as string,
      roles: Object.freeze([...(obj.roles as string[])]),
      capabilities: Object.freeze([...(obj.capabilities as string[])]),
      canResetDriverPasscode: true as const,
      canIssuePermanentPasscode: obj.canIssuePermanentPasscode === true,
    }),
  };
}

const POLICY_ALLOWED_KEYS = new Set<string>([
  'companyId',
  'allowAdminPasscodeReset',
  'allowPermanentPasscodeReset',
  'requiredPasscodeMinLength',
  'maxPasscodeLength',
  'requireTemporaryOnReset',
]);

export function validateTenantSecurityPolicy(raw: unknown): ValidationResult<TenantSecurityPolicy> {
  const plainError = validatePlainDataObject(raw);
  if (plainError) return { ok: false, error: plainError };

  const obj = raw as Record<string, unknown>;
  const unknownError = checkUnknownKeys(obj, POLICY_ALLOWED_KEYS);
  if (unknownError) return { ok: false, error: unknownError };

  const companyIdError = validateCompanyIdentifier(obj.companyId, 'companyId');
  if (companyIdError) return { ok: false, error: companyIdError };

  if (obj.allowAdminPasscodeReset !== true) {
    return { ok: false, error: { code: 'policy_violation', message: 'Company policy does not allow administrative passcode resets', path: 'allowAdminPasscodeReset' } };
  }

  if (typeof obj.allowPermanentPasscodeReset !== 'boolean' || typeof obj.requireTemporaryOnReset !== 'boolean') {
    return { ok: false, error: { code: 'policy_violation', message: 'Policy flags must be boolean', path: 'allowPermanentPasscodeReset' } };
  }

  return {
    ok: true,
    value: deepFreeze({
      companyId: obj.companyId as string,
      allowAdminPasscodeReset: true as const,
      allowPermanentPasscodeReset: obj.allowPermanentPasscodeReset as boolean,
      requiredPasscodeMinLength: (obj.requiredPasscodeMinLength as number) || PASSCODE_DIGIT_MIN_LEN,
      maxPasscodeLength: (obj.maxPasscodeLength as number) || PASSCODE_DIGIT_MAX_LEN,
      requireTemporaryOnReset: obj.requireTemporaryOnReset as boolean,
    }),
  };
}

const BINDING_ALLOWED_KEYS = new Set<string>([
  'driverId',
  'companyId',
  'active',
  'status',
]);

export function validateTargetDriverBinding(raw: unknown): ValidationResult<TargetDriverBinding> {
  const plainError = validatePlainDataObject(raw);
  if (plainError) return { ok: false, error: plainError };

  const obj = raw as Record<string, unknown>;
  const unknownError = checkUnknownKeys(obj, BINDING_ALLOWED_KEYS);
  if (unknownError) return { ok: false, error: unknownError };

  const driverIdError = validateDocIdentifier(obj.driverId, 'driverId');
  if (driverIdError) return { ok: false, error: driverIdError };

  const companyIdError = validateCompanyIdentifier(obj.companyId, 'companyId');
  if (companyIdError) return { ok: false, error: companyIdError };

  if (obj.active !== true || obj.status !== 'active') {
    return { ok: false, error: { code: 'inactive_credential', message: 'Target driver binding must be active', path: 'active' } };
  }

  return {
    ok: true,
    value: deepFreeze({
      driverId: obj.driverId as string,
      companyId: obj.companyId as string,
      active: true as const,
      status: 'active' as const,
    }),
  };
}

/**
 * Validates the full ResetAuthzSnapshot.
 * Ensures strict cross-plane consistency between principal, tenant membership,
 * capabilities, security policy, and target driver binding.
 */
export function validateResetAuthzSnapshot(raw: unknown): ValidationResult<ResetAuthzSnapshot> {
  const plainError = validatePlainDataObject(raw);
  if (plainError) return { ok: false, error: plainError };

  const obj = raw as Record<string, unknown>;

  const principalValidation = validateStaffPrincipal(obj.staffPrincipal);
  if (!principalValidation.ok) return { ok: false, error: principalValidation.error };

  const membershipValidation = validateTenantMembership(obj.tenantMembership);
  if (!membershipValidation.ok) return { ok: false, error: membershipValidation.error };

  const capsValidation = validateTenantRoleCapabilities(obj.tenantRoleCapabilities);
  if (!capsValidation.ok) return { ok: false, error: capsValidation.error };

  const policyValidation = validateTenantSecurityPolicy(obj.tenantSecurityPolicy);
  if (!policyValidation.ok) return { ok: false, error: policyValidation.error };

  const driverValidation = validateTargetDriverBinding(obj.targetDriverBinding);
  if (!driverValidation.ok) return { ok: false, error: driverValidation.error };

  const principal = principalValidation.value;
  const membership = membershipValidation.value;
  const caps = capsValidation.value;
  const policy = policyValidation.value;
  const targetDriver = driverValidation.value;

  // Cross-plane consistency assertions
  if (principal.staffUid !== membership.staffUid || principal.staffUid !== caps.staffUid) {
    return { ok: false, error: { code: 'unauthorized_actor', message: 'Staff principal UID mismatch across authority planes', path: 'staffUid' } };
  }

  if (
    membership.companyId !== caps.companyId ||
    membership.companyId !== policy.companyId ||
    membership.companyId !== targetDriver.companyId
  ) {
    return { ok: false, error: { code: 'company_binding_mismatch', message: 'Company ID mismatch across authority planes', path: 'companyId' } };
  }

  const resetMode = obj.resetMode === 'permanent' ? 'permanent' : 'temporary';
  if (resetMode === 'permanent') {
    if (!caps.canIssuePermanentPasscode) {
      return { ok: false, error: { code: 'unauthorized_actor', message: 'Actor lacks capability to issue permanent passcodes', path: 'resetMode' } };
    }
    if (!policy.allowPermanentPasscodeReset) {
      return { ok: false, error: { code: 'policy_violation', message: 'Company security policy prohibits permanent passcode issuance', path: 'resetMode' } };
    }
  }

  const snapshotIdError = validateDocIdentifier(obj.snapshotId, 'snapshotId');
  if (snapshotIdError) return { ok: false, error: snapshotIdError };

  const opIdError = validateDocIdentifier(obj.opId, 'opId');
  if (opIdError) return { ok: false, error: opIdError };

  const evalTimeError = validateStrictIsoTimestamp(obj.evaluatedAt, 'evaluatedAt');
  if (evalTimeError) return { ok: false, error: evalTimeError };

  return {
    ok: true,
    value: deepFreeze({
      snapshotId: obj.snapshotId as string,
      opId: obj.opId as string,
      evaluatedAt: obj.evaluatedAt as string,
      staffPrincipal: principal,
      tenantMembership: membership,
      tenantRoleCapabilities: caps,
      tenantSecurityPolicy: policy,
      targetDriverBinding: targetDriver,
      resetMode,
    }),
  };
}
