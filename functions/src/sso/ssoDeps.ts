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

import type { PlanDefinition } from '@tester3x/wellbuilt-contracts';
import type { WellbuiltContract } from '../admin/companyContract.js';
import type { ShiftDayDoc } from './equipmentAuthorization.js';
import type { ShiftAuthorityRecord } from '../security/operational/shiftAuthority.js';

/** The authoritative driver record, as the server sees it. */
export interface AuthoritativeDriver {
  driverId: string;
  companyId: string | null;
  /** Disabled/deleted/suspended drivers must never complete a bridge. */
  active: boolean;
  /**
   * The driver's authoritative display name, already normalized, or null
   * when the profile has none usable.
   *
   * Nullable so a profile-data gap can never look like a liveness failure.
   * Only the tickets audience is ever told this; see handleSsoExchange.
   */
  displayName: string | null;
  /**
   * Canonical acknowledgment identity from top-level profile.legalName,
   * already resolved, or null when absent or unusable.
   *
   * Nullable so a profile-data gap can never look like a liveness failure
   * or change grant consumption. Only the JSA audience is ever told this;
   * see handleSsoExchange. Never a displayName fallback.
   */
  legalName: string | null;
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
  /** Firestore Timestamp mirror of expiresAtMs, for the TTL policy. */
  expiresAt?: unknown;
  consumed: boolean;
  consumedAtMs?: number;
  /**
   * Equipment audience only: the SERVER-VALIDATED shift binding, stored at
   * issuance. Exchange echoes this and never anything the redeemer sends.
   */
  shiftBinding?: { shiftId: string; phase: 'pre_trip' | 'post_trip' };
  /**
   * JSA audience only: the SERVER-AUTHORED authority binding decided at
   * issuance (see sso/jsaAuthorization.ts). Exchange echoes the stored,
   * revalidated value and never anything the redeemer sends. Inert until
   * the contracts 0.5.0 audience allowlist admits 'wellbuilt-jsa'.
   */
  jsaBinding?: {
    shiftState: 'open' | 'none';
    periodId?: string;
    originLocalDate?: string;
    requiresActiveShift: boolean;
    jsaEnabled: boolean;
  };
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
  /**
   * Firestore-native Timestamp for a millisecond instant, for the TTL
   * policy to read. SERVER-owned: the client supplies neither this nor
   * expiresAtMs, and both are computed from the server clock.
   */
  expiresAtTimestamp(ms: number): unknown;
  /** base64url of raw bytes, unpadded. */
  base64Url(bytes: Uint8Array): string;
  /** The authoritative driver record, or null when absent. */
  getDriver(driverId: string): Promise<AuthoritativeDriver | null>;
  /**
   * One authoritative driver_shifts/{driverId}_{localDate} document.
   *
   * MUST distinguish the three outcomes the security decision depends on:
   * readable-and-present, definitively absent, and unreadable. Collapsing
   * an unreadable read into "absent" turns an outage into a silent "no such
   * shift"; collapsing it into "open" would be far worse.
   */
  getShiftDay(driverId: string, localDate: string): Promise<ShiftDayDoc>;
  /**
   * The driver's authoritative shift-authority record, or null when absent.
   *
   * This is the DATE-FREE authority: it stores the open period and its
   * origin day, so "is a shift open right now?" needs no company timezone
   * — which matters because explicit_shift configurations store none, and
   * a UTC date would misfile an evening shift in America/Chicago. A null
   * return means the document is absent or unreadable; decideResolve turns
   * that into `unverifiable`, never into a false `none`.
   */
  getShiftAuthority(driverId: string): Promise<ShiftAuthorityRecord | null>;
  /**
   * The company's parsed contract, with its canonical state label, so the
   * handler never re-implements parsing and never mistakes a malformed
   * contract for an absent one.
   */
  getCompanyContract(companyId: string): Promise<{
    state: 'legacy' | 'inert' | 'active' | 'invalid';
    contract: WellbuiltContract | null;
  }>;
  /** The plan document named by a contract, or null when absent. */
  getPlan(planId: string): Promise<PlanDefinition | null>;
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
