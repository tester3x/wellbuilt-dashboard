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
 */

// ── Passcode & Identifier Bounds ─────────────────────────────────────────────

export const PASSCODE_DIGIT_MIN_LEN = 6;
export const PASSCODE_DIGIT_MAX_LEN = 128;

export const ID_MIN_LEN = 1;
export const ID_MAX_LEN = 128;

/** Allowed characters for canonical string identifiers: alphanumeric, underscore, dot, hyphen. */
export const CANONICAL_ID_REGEX = /^[A-Za-z0-9_.-]+$/;

/** Numeric-only digits regex for passcodes. */
export const PASSCODE_DIGITS_REGEX = /^\d+$/;

// ── Scrypt Parameters (matching repository standard) ──────────────────────────

export const CANONICAL_SCRYPT_ALGO = 'scrypt' as const;

export const SCRYPT_BOUNDS = {
  N: { min: 1024, max: 1048576, default: 16384 },
  r: { min: 1, max: 64, default: 8 },
  p: { min: 1, max: 16, default: 1 },
  keyLen: { min: 16, max: 128, default: 32 },
  minSaltBytes: 16,
} as const;

// ── Validation Result Types ──────────────────────────────────────────────────

export interface ValidationError {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ValidationError };

// ── Canonical Reset Request Contract ─────────────────────────────────────────

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

// ── Canonical Credential Contract ────────────────────────────────────────────

/**
 * Authoritative Firestore credential record stored in driver_credentials collection.
 * Uses repository-native scrypt parameters and explicit tenant ownership.
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

// ── Session & Version Binding Contract ───────────────────────────────────────

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

// ── Reset Receipt Contract ───────────────────────────────────────────────────

/**
 * Immutable audit receipt written atomically with the credential CAS update.
 * Note: Receipt records that auth cleanup is pending/enqueued; it must NEVER
 * falsely claim auth cleanup is completed before the effect is acknowledged.
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

// ── Auth Cleanup Effect Contract ─────────────────────────────────────────────

/**
 * Durable forward-only Auth cleanup effect record.
 * Processed asynchronously and idempotently by a background effect worker.
 */
export interface AuthCleanupEffect {
  readonly effectId: string;
  readonly opId: string;
  readonly companyId: string;
  readonly driverId: string;
  readonly credentialVersion: number;
  readonly status: 'pending' | 'in_progress' | 'completed' | 'failed';
  readonly attempts: number;
  readonly createdAt: string;
  readonly lastAttemptAt?: string | null;
  readonly completedAt?: string | null;
  readonly terminalError?: string | null;
}

// ── Documented Future Authority Types (Design Only) ──────────────────────────

/**
 * Server-side resolved staff actor principal for reset authorization.
 * Never supplied on the wire.
 */
export interface StaffPrincipalAuthority {
  readonly staffUid: string;
  readonly companyId: string;
  readonly roles: readonly string[];
  readonly capabilities: readonly string[];
  readonly active: boolean;
}

/**
 * Tenant security policy governing passcode resets.
 */
export interface TenantSecurityPolicy {
  readonly companyId: string;
  readonly allowAdminPasscodeReset: boolean;
  /** If false, only temporary passcodes requiring change on first login may be issued. */
  readonly allowPermanentPasscodeReset: boolean;
  readonly requiredPasscodeMinLength: number;
}
