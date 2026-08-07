/**
 * Injectable surface for the SSO authorization-code handlers.
 *
 * Same discipline as AdminDeps: handlers never touch firebase-admin,
 * node:crypto, or the clock directly, so the full replay/race/expiry
 * matrix runs against an in-memory mock and the production adapter stays
 * a thin, obviously-correct wrapper.
 *
 * Randomness and time are injected because both are security-relevant:
 * a test must be able to prove that an expired code is rejected by SERVER
 * time, and that two concurrent exchanges cannot both succeed.
 */

/** The authoritative driver record, as the server sees it. */
export interface AuthoritativeDriver {
  driverId: string;
  companyId: string | null;
  /** Disabled/deleted/suspended drivers must never complete a bridge. */
  active: boolean;
}

/** The stored authorization-code record. Never contains the raw code. */
export interface SsoCodeRecord {
  codeHash: string;
  uid: string;
  driverId: string;
  companyId: string;
  audience: string;
  codeChallenge: string;
  protocolVersion: number;
  issuedAtMs: number;
  expiresAtMs: number;
  consumed: boolean;
  consumedAtMs?: number;
}

export interface SsoTransaction {
  get(path: string): Promise<{ exists: boolean; data?: Record<string, unknown> }>;
  /** Field-merge update; MUST fail if the document does not exist. */
  update(path: string, fields: Record<string, unknown>): void;
  /** Create; MUST fail if the document already exists. */
  create(path: string, data: Record<string, unknown>): void;
}

export interface SsoDeps {
  /** Server clock. Expiry is decided here, never by a client timestamp. */
  nowMs(): number;
  /** Cryptographically secure random bytes. */
  randomBytes(count: number): Uint8Array;
  /** Hex SHA-256 of a UTF-8 string. */
  sha256Hex(input: string): string;
  /** base64url of raw bytes, unpadded. */
  base64Url(bytes: Uint8Array): string;
  /** The authoritative driver record, or null when absent. */
  getDriver(driverId: string): Promise<AuthoritativeDriver | null>;
  runTransaction<T>(fn: (tx: SsoTransaction) => Promise<T>): Promise<T>;
  /**
   * Mint a custom token for `uid` with `developerClaims`.
   *
   * MUST NOT call setCustomUserClaims: persisted claims live on the Auth
   * USER and are shared by every app in this project, so writing a
   * per-app marker there would corrupt WB-S's own session.
   */
  mintCustomToken(uid: string, developerClaims: Record<string, unknown>): Promise<string>;
  /** Redacted structured log. Never receives a secret. */
  log(event: string, fields: Record<string, unknown>): void;
}

/** The caller's verified Auth context. Never client-supplied. */
export interface SsoAuthContext {
  uid: string | null;
  claims: Record<string, unknown>;
}

export type SsoHandlerErrorCode =
  | 'unauthenticated'
  | 'permission-denied'
  | 'invalid-argument'
  | 'failed-precondition'
  | 'resource-exhausted'
  | 'internal';

/**
 * Typed handler failure.
 *
 * `publicCode` is what the client sees. It is deliberately coarse for the
 * exchange: a caller must not be able to tell "no such code" from
 * "already consumed" from "wrong verifier", because that difference is an
 * oracle for guessing codes.
 */
export class SsoError extends Error {
  constructor(
    public readonly code: SsoHandlerErrorCode,
    public readonly publicCode: string,
    /** Operator-facing only. Never returned to the client. */
    public readonly internalReason: string,
  ) {
    super(publicCode);
    this.name = 'SsoError';
  }
}

/** Where code records live. One short-lived document per issuance. */
export const SSO_CODE_COLLECTION = 'sso_authorization_codes';

export function ssoCodePath(codeHash: string): string {
  return `${SSO_CODE_COLLECTION}/${codeHash}`;
}
