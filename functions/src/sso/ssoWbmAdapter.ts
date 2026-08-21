/**
 * Narrow adapter so the EXISTING issue/exchange handlers can accept the
 * additive wellbuilt-mobile audience without regenerating the SHA-pinned
 * 0.4.0 contracts-mirror (which would pull unrelated unpublished deltas).
 *
 * WBT and equipment still go through validateSsoIssueCodeRequest /
 * isSsoAudience unchanged.
 */
import {
  isSsoAudience,
  isSsoChallenge,
  isSsoChallengeMethod,
  isSsoCode,
  isSsoProtocolVersion,
  isSsoVerifier,
  SSO_CHALLENGE_METHOD,
  SSO_PROTOCOL_VERSION,
  SSO_SESSION_APP_BY_AUDIENCE,
  validateSsoExchangeRequest,
  validateSsoIssueCodeRequest,
  type SsoExchangeRequest,
  type SsoIssueCodeRequest,
  type SsoValidation,
} from '@tester3x/wellbuilt-contracts';

export const SSO_AUDIENCE_WBM = 'wellbuilt-mobile' as const;
export const SSO_SESSION_APP_WBM = 'wbm' as const;

export function isWbmAudience(v: unknown): v is typeof SSO_AUDIENCE_WBM {
  return v === SSO_AUDIENCE_WBM;
}

export function isIssuableAudience(v: unknown): boolean {
  return isSsoAudience(v) || isWbmAudience(v);
}

export function sessionAppForAudience(audience: string): string | undefined {
  if (isWbmAudience(audience)) return SSO_SESSION_APP_WBM;
  return SSO_SESSION_APP_BY_AUDIENCE[audience as keyof typeof SSO_SESSION_APP_BY_AUDIENCE];
}

/** Entitlement app key. WBM is not assumed to exist on the pinned 0.4.0 map. */
export function resolveWellbuiltAppKeyAllowingWbm(raw: unknown): string | null {
  if (isWbmAudience(raw)) return 'wellbuilt-mobile';
  const { resolveWellbuiltAppKey } = require('@tester3x/wellbuilt-contracts') as {
    resolveWellbuiltAppKey: (v: unknown) => string | null;
  };
  return resolveWellbuiltAppKey(raw);
}

export function validateSsoIssueCodeRequestAllowingWbm(
  input: unknown,
): SsoValidation<SsoIssueCodeRequest> {
  const o = input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
  if (o && isWbmAudience(o.audience)) {
    if (!isSsoProtocolVersion(o.protocolVersion)) {
      return { ok: false, errorCode: 'unsupported_protocol', field: 'protocolVersion' };
    }
    if (!isSsoChallengeMethod(o.codeChallengeMethod)) {
      return { ok: false, errorCode: 'unsupported_method', field: 'codeChallengeMethod' };
    }
    if (!isSsoChallenge(o.codeChallenge)) {
      return { ok: false, errorCode: 'malformed_request', field: 'codeChallenge' };
    }
    if (o.shiftBinding !== undefined) {
      return { ok: false, errorCode: 'malformed_request', field: 'shiftBinding' };
    }
    return {
      ok: true,
      value: {
        protocolVersion: SSO_PROTOCOL_VERSION,
        audience: SSO_AUDIENCE_WBM as SsoIssueCodeRequest['audience'],
        codeChallenge: String(o.codeChallenge),
        codeChallengeMethod: SSO_CHALLENGE_METHOD,
      },
    };
  }
  return validateSsoIssueCodeRequest(input);
}

export function validateSsoExchangeRequestAllowingWbm(
  input: unknown,
): SsoValidation<SsoExchangeRequest> {
  const o = input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
  if (o && isWbmAudience(o.audience)) {
    if (!isSsoProtocolVersion(o.protocolVersion)) {
      return { ok: false, errorCode: 'unsupported_protocol', field: 'protocolVersion' };
    }
    if (!isSsoCode(o.code)) {
      return { ok: false, errorCode: 'malformed_request', field: 'code' };
    }
    if (!isSsoVerifier(o.codeVerifier)) {
      return { ok: false, errorCode: 'malformed_request', field: 'codeVerifier' };
    }
    return {
      ok: true,
      value: {
        protocolVersion: SSO_PROTOCOL_VERSION,
        audience: SSO_AUDIENCE_WBM as SsoExchangeRequest['audience'],
        code: String(o.code),
        codeVerifier: String(o.codeVerifier),
      },
    };
  }
  return validateSsoExchangeRequest(input);
}
