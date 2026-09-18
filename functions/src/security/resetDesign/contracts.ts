/**
 * Canonical Driver Reset Design — Phase 0 Inert Contracts
 *
 * Strictly typed, inert schema definitions for the future canonical driver-passcode
 * reset control plane.
 *
 * BOUNDARY RULES:
 * - Pure TypeScript definitions and constants only.
 * - Zero Firebase SDK imports.
 * - Zero runtime network, database, or crypto side effects.
 * - Unexported and unreferenced by production code.
 * - No production reachability.
 */

// ── Passcode & Identifier Bounds ─────────────────────────────────────────────

export const PASSCODE_DIGIT_MIN_LEN = 6;
export const PASSCODE_DIGIT_MAX_LEN = 128;

export const ID_MIN_LEN = 1;
export const ID_MAX_LEN = 128;
export const COMPANY_ID_MAX_LEN = 64;

/**
 * Domain-specific identifier rules:
 * - CANONICAL_DOC_ID_REGEX: Firestore document identifiers (driverId, companyId, opId, etc.).
 *   Rejects '.' and '..' (path traversal), slashes, whitespace, and non-alphanumeric chars (except _ - .).
 * - AUTH_UID_REGEX: Firebase Auth UIDs (staffUid, actorUid).
 *   Permits colon ':' to support federated authentication providers (e.g. 'auth0:12345'),
 *   while strictly rejecting path traversal ('.' and '..'), slashes, whitespace, and control chars.
 * - PASSCODE_DIGITS_REGEX: Pure numeric digit string for future administrative reset policy.
 *   (Note: current registration in passcode.ts allows broader 6..128 char strings;
 *    numeric-only is the new reset-command policy).
 */
export const CANONICAL_DOC_ID_REGEX = /^(?!\.\.?$)[A-Za-z0-9_.-]{1,128}$/;
export const AUTH_UID_REGEX = /^(?!\.\.?$)[A-Za-z0-9_.:-]{1,128}$/;
export const COMPANY_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;
export const PASSCODE_DIGITS_REGEX = /^\d+$/;

// ── Safe Counter & Version Bounds ────────────────────────────────────────────

/**
 * Counters must be safely incrementable without precision loss or overflow.
 * We strictly reject Number.MAX_SAFE_INTEGER.
 */
export const COUNTER_MIN = 0;
export const COUNTER_MAX_SAFE = 1_000_000;

export const VERSION_MIN = 1;
export const VERSION_MAX_SAFE = 1_000_000;

export const MAX_RETRY_ATTEMPTS = 5;

// ── Scrypt Parameters (Derived strictly from functions/src/security/passcode.ts)

export const CANONICAL_SCRYPT_ALGO = 'scrypt' as const;

/**
 * Repository standard parameters from functions/src/security/passcode.ts:
 * SCRYPT = { N: 16384, r: 8, p: 1, keyLen: 32 }
 * Salt generation: crypto.randomBytes(16) -> 16 bytes.
 */
export const REPO_SCRYPT_PROFILE = {
  algo: CANONICAL_SCRYPT_ALGO,
  N: 16384,
  r: 8,
  p: 1,
  keyLen: 32,
  saltBytes: 16,
} as const;

export const SCRYPT_BOUNDS = {
  N: { min: 1024, max: 65536, default: 16384 },
  r: { min: 1, max: 16, default: 8 },
  p: { min: 1, max: 4, default: 1 },
  keyLen: { min: 16, max: 64, default: 32 },
  minSaltBytes: 16,
  maxSaltBytes: 32,
  /**
   * Maximum memory footprint ceiling (128 * N * r bytes).
   * Prevents denial-of-service via multi-gigabyte scrypt profiles.
   * Default (16384 * 8 * 128) = 16 MB. Max allowed = 32 MB.
   */
  maxMemoryBytes: 32 * 1024 * 1024,
} as const;

// ── Terminal Error Codes for Auth Cleanup ────────────────────────────────────

export const TERMINAL_ERROR_CODES = [
  'driver_auth_user_not_found',
  'token_revocation_failed_permanent',
  'max_retries_exceeded',
  'security_context_invalid',
  'driver_binding_revoked',
] as const;

export type TerminalErrorCode = typeof TERMINAL_ERROR_CODES[number];

// ── Validation Error System ──────────────────────────────────────────────────

/**
 * Fixed bounded enum of validation error codes.
 * Prevents dynamic reflection or echoing of untrusted input.
 */
export const VALIDATION_ERROR_CODES = [
  'invalid_type',
  'invalid_request_shape',
  'invalid_object_prototype',
  'property_access_error',
  'symbol_property_rejected',
  'non_enumerable_property_rejected',
  'accessor_property_rejected',
  'too_many_keys',
  'unknown_field',
  'missing_field',
  'missing_credential_field',
  'missing_session_field',
  'missing_receipt_field',
  'missing_effect_field',
  'missing_principal_field',
  'missing_membership_field',
  'missing_capabilities_field',
  'missing_policy_field',
  'missing_binding_field',
  'missing_snapshot_field',
  'invalid_id_type',
  'empty_id',
  'id_too_long',
  'malformed_id',
  'invalid_integer_type',
  'unsafe_integer',
  'counter_overflow',
  'non_positive_integer',
  'invalid_temporary_type',
  'invalid_passcode_type',
  'empty_passcode',
  'passcode_too_short',
  'passcode_too_long',
  'passcode_non_numeric',
  'invalid_credential_shape',
  'invalid_algo',
  'invalid_scrypt_parameter',
  'excessive_scrypt_memory',
  'invalid_salt_type',
  'empty_salt',
  'invalid_salt',
  'salt_too_short',
  'salt_too_long',
  'invalid_hash_type',
  'empty_hash',
  'invalid_hash',
  'hash_keylen_mismatch',
  'driver_binding_mismatch',
  'company_binding_mismatch',
  'invalid_active_type',
  'inactive_credential',
  'invalid_session_shape',
  'session_driver_mismatch',
  'session_company_mismatch',
  'session_credential_version_mismatch',
  'credential_inactive',
  'invalid_receipt_shape',
  'invalid_credential_version_progression',
  'invalid_receipt_status',
  'invalid_receipt_auth_cleanup_status',
  'invalid_effect_shape',
  'invalid_effect_status',
  'invalid_attempts',
  'invalid_timestamp',
  'malformed_timestamp',
  'contradictory_effect_status',
  'missing_terminal_error',
  'invalid_terminal_error',
  'unexpected_terminal_error',
  'op_id_mismatch',
  'driver_id_mismatch',
  'company_id_mismatch',
  'credential_version_mismatch',
  'receipt_effect_status_contradiction',
  'chronology_violation',
  'forbidden_backward_transition',
  'unsupported_transition',
  'idempotent_retry_conflict',
  'unauthorized_actor',
  'policy_violation',
  'membership_inactive',
] as const;

export type ValidationErrorCode = typeof VALIDATION_ERROR_CODES[number];

export interface ValidationError {
  readonly code: ValidationErrorCode;
  readonly message: string;
  readonly path?: string;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ValidationError };

// ── 1. Separate Authority Planes Contracts (Requirement 1) ───────────────────

/**
 * Authenticated Staff Principal.
 * Represents the verified global identity of the staff actor from Firebase Auth.
 * CRITICAL INVARIANT: A global IT/staff identity alone MUST NEVER grant tenant mutation authority.
 * It carries zero companyId, roles, or capabilities.
 */
export interface StaffPrincipal {
  readonly staffUid: string;
  readonly authTime: string; // ISO-8601 timestamp
  readonly email?: string;
  readonly emailVerified: boolean;
  readonly isAnonymous: false;
  readonly disabled: false;
}

/**
 * Current Company/Tenant Membership.
 * Authoritative record of the staff member's relationship to the tenant company.
 */
export interface TenantMembership {
  readonly membershipId: string;
  readonly companyId: string;
  readonly staffUid: string;
  readonly status: 'active';
  readonly joinedAt: string;
}

/**
 * Current Tenant Role and Granted Capabilities.
 * Authoritative capability grants for this specific staff principal within this tenant.
 */
export interface TenantRoleCapabilities {
  readonly companyId: string;
  readonly staffUid: string;
  readonly roles: readonly string[];
  readonly capabilities: readonly string[];
  readonly canResetDriverPasscode: boolean;
  readonly canIssuePermanentPasscode: boolean;
}

/**
 * Tenant Security Policy.
 * Company-level governance rules for driver credential management.
 */
export interface TenantSecurityPolicy {
  readonly companyId: string;
  readonly allowAdminPasscodeReset: boolean;
  readonly allowPermanentPasscodeReset: boolean;
  readonly requiredPasscodeMinLength: number;
  readonly maxPasscodeLength: number;
  readonly requireTemporaryOnReset: boolean;
}

/**
 * Target Driver / Company Binding.
 * Authoritative tenant ownership and status of the driver being reset.
 */
export interface TargetDriverBinding {
  readonly driverId: string;
  readonly companyId: string;
  readonly active: boolean; // Must be true for reset eligibility
  readonly status: 'active';
}

/**
 * Reset Operation Authorization Snapshot.
 * Point-in-time snapshot of the verified authority planes before transaction execution.
 *
 * TRANSACTION READ-SET REQUIREMENT:
 * Even though an authorization snapshot is assembled before opening the mutation transaction,
 * the eventual mutation transaction MUST re-read and assert:
 * 1. Authoritative tenant membership status (still active)
 * 2. Current tenant security policy
 * 3. Target driver ownership by companyId
 * 4. Target driver liveness (active)
 * 5. Current stored credentialVersion (CAS precondition)
 * 6. Current credential state
 * inside the Firestore transaction read set before committing any write.
 */
export interface ResetAuthzSnapshot {
  readonly snapshotId: string;
  readonly opId: string;
  readonly evaluatedAt: string;
  readonly staffPrincipal: StaffPrincipal;
  readonly tenantMembership: TenantMembership;
  readonly tenantRoleCapabilities: TenantRoleCapabilities;
  readonly tenantSecurityPolicy: TenantSecurityPolicy;
  readonly targetDriverBinding: TargetDriverBinding;
  readonly resetMode: 'temporary' | 'permanent';
}

// ── 2. Wire Request & Internal Operation Contracts (Requirement 5) ───────────

/**
 * Exactly 6 wire fields accepted on the future resetDriverPasscode callable.
 * Unknown or additional fields are strictly rejected.
 * Caller UID, roles, capabilities, email, display name, and approved keys
 * are NEVER accepted from the wire request.
 */
export interface CanonicalResetRequest {
  /** Unique operation identifier for tracing and idempotency. */
  readonly opId: string;
  /** Explicit tenant company scope. */
  readonly companyId: string;
  /** Exact canonical driver identifier (UUID/canonical ID). */
  readonly driverId: string;
  /** Compare-and-swap guard: current stored credential version. Positive safe integer. */
  readonly expectedCredentialVersion: number;
  /** Explicit boolean flag indicating whether this is a temporary passcode requiring first-use change. */
  readonly temporary: boolean;
  /** The new passcode string, containing numeric digits only, length 6..128. */
  readonly newPasscode: string;
}

/**
 * Explicitly named INTERNAL secret-bearing validated type.
 * Secrets may exist ONLY in this internal type during preparation.
 * They must NEVER appear in receipts, effects, errors, logs, cleanup records, or public results.
 */
export interface ValidatedSecretBearingResetRequest {
  readonly __secretBearing: true;
  readonly opId: string;
  readonly companyId: string;
  readonly driverId: string;
  readonly expectedCredentialVersion: number;
  readonly temporary: boolean;
  readonly newPasscode: string;
  readonly passcodeDigitCount: number;
  readonly commitmentHash: string; // SHA-256 of canonical op parameters + passcode
}

/**
 * Sanitized, immutable operation commitment.
 * Contains NO raw passcode material. Safe for audit logs, idempotency checks, and tracking.
 */
export interface CanonicalResetOperationCommitment {
  readonly opId: string;
  readonly companyId: string;
  readonly driverId: string;
  readonly expectedCredentialVersion: number;
  readonly temporary: boolean;
  readonly passcodeDigitCount: number;
  readonly commitmentHash: string;
  readonly actorUid: string;
  readonly createdAt: string;
}

// ── 3. Credential Contracts (Current vs Future) (Requirement 7) ──────────────

/**
 * CURRENT Firestore schema stored under driver_credentials/{driverId}.
 * Document ID is driverId. Passcode parameters are nested under 'passcode'.
 * CompanyId is NOT on this document today (it lives in RTDB drivers/profiles/{driverId}).
 * CredentialVersion and CAS do NOT exist today.
 * active !== false is evaluated today (missing is active).
 */
export interface CurrentDriverCredentialDoc {
  readonly displayNameNorm?: string;
  readonly displayName?: string;
  readonly passcode: {
    readonly algo: 'scrypt';
    readonly saltB64: string;
    readonly hashB64: string;
    readonly N: number;
    readonly r: number;
    readonly p: number;
    readonly keyLen: number;
  };
  readonly active?: boolean;
  readonly mustResetPasscode?: boolean;
  readonly createdAt?: unknown;
  readonly updatedAt?: unknown;
  readonly tier?: string;
  readonly source?: string;
}

/**
 * FUTURE Canonical Credential Schema for driver_credentials/{driverId} (Phase 2+).
 * Normalized record incorporating explicit tenant companyId, credentialVersion CAS guard,
 * and strict boolean active: true.
 */
export interface CanonicalCredential {
  readonly algo: typeof CANONICAL_SCRYPT_ALGO;
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly keyLen: number;
  readonly saltB64: string;
  readonly hashB64: string;
  readonly driverId: string;
  readonly companyId: string;
  readonly credentialVersion: number;
  /** For reset eligibility, active must be exactly true. */
  readonly active: boolean;
}

// ── 4. Session & Version Binding Contract ────────────────────────────────────

/**
 * Future driver session binding shape.
 * Binds immutable sessionId, driverId, companyId, and credentialVersion.
 */
export interface DriverSessionBinding {
  readonly sessionId: string;
  readonly driverId: string;
  readonly companyId: string;
  readonly credentialVersion: number;
}

// ── 5. Reset Receipt Contract ────────────────────────────────────────────────

/**
 * Immutable audit receipt written atomically with the credential CAS update.
 * CRITICAL INVARIANT: Receipt records that auth cleanup is pending/enqueued; it must NEVER
 * falsely claim auth cleanup is completed before the effect is acknowledged.
 * NEVER contains passcode or credential secrets.
 */
export interface ResetReceipt {
  readonly receiptId: string;
  readonly opId: string;
  readonly companyId: string;
  readonly driverId: string;
  readonly previousCredentialVersion: number;
  readonly newCredentialVersion: number;
  readonly temporary: boolean;
  /** Staff actor UID resolved strictly from server-side request context. */
  readonly actorUid: string;
  readonly appliedAt: string;
  readonly status: 'committed';
  readonly authCleanupStatus: 'pending' | 'enqueued';
}

// ── 6. Auth Cleanup Effect Contract ──────────────────────────────────────────

export type EffectStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/**
 * Allowed forward-only lifecycle transitions.
 * Completed effects are terminal and cannot be transitioned back to pending or replayed.
 */
export const ALLOWED_EFFECT_TRANSITIONS: Readonly<Record<EffectStatus, readonly EffectStatus[]>> = {
  pending: ['in_progress'],
  in_progress: ['completed', 'failed'],
  failed: ['in_progress'], // Retry only, subject to max attempts
  completed: [],           // Terminal: no transitions allowed
} as const;

/**
 * Durable forward-only Auth cleanup effect record.
 * Processed asynchronously and idempotently by a background effect worker.
 * NEVER contains passcode or credential secrets.
 */
export interface AuthCleanupEffect {
  readonly effectId: string;
  readonly opId: string;
  readonly companyId: string;
  readonly driverId: string;
  readonly credentialVersion: number;
  readonly status: EffectStatus;
  readonly attempts: number;
  readonly fenceGeneration: number;
  readonly createdAt: string;
  readonly lastAttemptAt?: string | null;
  readonly completedAt?: string | null;
  readonly failedAt?: string | null;
  readonly terminalError?: TerminalErrorCode | null;
}
