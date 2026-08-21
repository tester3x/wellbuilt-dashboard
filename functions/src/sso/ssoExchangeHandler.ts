/**
 * SSO authorization-code exchange.
 *
 * Runs BEFORE WB-T has any Auth session — that is the entire point of the
 * bridge — so there is no callable Auth context to check and none is
 * pretended. Authorization here is possession of two independent secrets:
 * the opaque code (which travelled through a deep link) and the PKCE
 * verifier (which never left WB-T except in this request body). An
 * attacker who captured the deep link has the first and not the second.
 *
 * ATOMICITY IS THE SECURITY PROPERTY. A code must be redeemable exactly
 * once, ever. Two concurrent exchanges must not both succeed, and a
 * sequential replay must not succeed at all.
 */
import {
  SSO_AUDIENCE_EQUIPMENT,
  audienceCarriesDisplayName,
  isSsoShiftBinding,
  normalizeSsoDisplayName,
  SSO_PROTOCOL_VERSION,
  SSO_SESSION_APP_CLAIM,
  type SsoAudience,
  type SsoExchangeResponse,
} from '@tester3x/wellbuilt-contracts';
import { isIssuableAudience, isWbmAudience, sessionAppForAudience, validateSsoExchangeRequestAllowingWbm } from './ssoWbmAdapter';
import { canonicalDriverAuthUid } from '../security/canonicalDriverUid';
import {
  SsoError,
  ssoCodePath,
  type SsoCodeRecord,
  type SsoDeps,
} from './ssoDeps.js';

/**
 * The one error every redemption failure produces.
 *
 * Distinguishing "no such code" from "expired" from "already consumed"
 * from "wrong verifier" would be an oracle: an attacker holding a
 * captured code could learn whether it was real and whether it was still
 * live. The operator-facing reason is carried separately in the log.
 */
const GENERIC = 'invalid_grant';

function readRecord(data: Record<string, unknown> | undefined): SsoCodeRecord | null {
  if (!data) return null;
  const {
    codeHash, uid, driverId, companyId, audience, codeChallenge,
    protocolVersion, issuedAtMs, expiresAtMs, consumed,
  } = data;
  if (
    typeof codeHash !== 'string' || typeof uid !== 'string'
    || typeof driverId !== 'string' || typeof companyId !== 'string'
    || typeof audience !== 'string' || typeof codeChallenge !== 'string'
    || typeof protocolVersion !== 'number' || typeof issuedAtMs !== 'number'
    || typeof expiresAtMs !== 'number' || typeof consumed !== 'boolean'
  ) {
    return null;
  }
  return {
    codeHash, uid, driverId, companyId, audience, codeChallenge,
    protocolVersion, issuedAtMs, expiresAtMs, consumed,
    // Carried through ONLY when it still validates. A stored value that no
    // longer parses is dropped rather than trusted, so a corrupted or
    // hand-edited record cannot inject a binding into the response.
    ...(isSsoShiftBinding(data.shiftBinding) ? { shiftBinding: data.shiftBinding } : {}),
  };
}

export async function handleSsoExchange(
  deps: SsoDeps,
  data: unknown,
): Promise<SsoExchangeResponse> {
  // 1. Shape first — reject malformed encodings before any database work,
  //    so a garbage-flooding caller never reaches storage.
  const parsed = validateSsoExchangeRequestAllowingWbm(data);
  if (!parsed.ok) {
    deps.log('sso.exchange.rejected', { reason: 'malformed', field: parsed.field });
    throw new SsoError('invalid-argument', parsed.errorCode, `invalid ${parsed.field}`);
  }
  const req = parsed.value;
  if (!isIssuableAudience(req.audience)) {
    throw new SsoError('invalid-argument', 'unsupported_audience', 'audience not allowlisted');
  }

  const codeHash = deps.sha256Hex(req.code);
  // PKCE: BASE64URL(SHA256(verifier)). The verifier is hashed with the
  // same construction WB-T used to build the challenge it registered.
  const derivedChallenge = deps.base64Url(sha256Bytes(deps, req.codeVerifier));

  const path = ssoCodePath(codeHash);

  // 2. One transaction: read, validate every binding, and consume. A
  //    record that fails validation is NOT consumed — a wrong verifier
  //    must not let an attacker burn a legitimate driver's live code,
  //    which would be a free denial of service against the real bridge.
  const outcome = await deps.runTransaction<
    { ok: true; record: SsoCodeRecord } | { ok: false; reason: string }
  >(async (tx) => {
    const snap = await tx.get(path);
    if (!snap.exists) return { ok: false, reason: 'no_record' };

    const record = readRecord(snap.data);
    if (!record) return { ok: false, reason: 'corrupt_record' };
    if (record.consumed) return { ok: false, reason: 'already_consumed' };
    if (record.audience !== req.audience) return { ok: false, reason: 'audience_mismatch' };
    if (record.protocolVersion !== SSO_PROTOCOL_VERSION) {
      return { ok: false, reason: 'protocol_mismatch' };
    }
    // Expiry is decided by SERVER time. A client clock never participates.
    if (deps.nowMs() >= record.expiresAtMs) return { ok: false, reason: 'expired' };
    if (record.codeChallenge !== derivedChallenge) {
      return { ok: false, reason: 'pkce_mismatch' };
    }

    // Every binding held: consume exactly once, inside the transaction.
    // `update` fails if the document vanished, and the transaction retries
    // or aborts if another exchange consumed it first — so at most one
    // concurrent caller can observe consumed===false and commit.
    tx.update(path, { consumed: true, consumedAtMs: deps.nowMs() });
    return { ok: true, record };
  });

  if (!outcome.ok) {
    deps.log('sso.exchange.rejected', {
      reason: outcome.reason,
      codeHashPrefix: codeHash.slice(0, 8),
    });
    throw new SsoError('permission-denied', GENERIC, outcome.reason);
  }

  const record = outcome.record;

  // 3. The code is now spent. Revalidate the bound identity: issuance may
  //    have happened seconds ago, but a driver can be disabled or moved in
  //    that window, and a spent code must not resurrect them.
  //
  //    This runs AFTER consumption on purpose. Consuming first means a
  //    failure here cannot be retried into a second successful exchange —
  //    the driver simply starts a new bridge. Security over retry
  //    convenience, exactly as required.
  const driver = await deps.getDriver(record.driverId);
  if (!driver || !driver.active || driver.companyId !== record.companyId) {
    deps.log('sso.exchange.rejected', {
      reason: !driver ? 'driver_absent' : !driver.active ? 'driver_inactive' : 'company_drift',
      codeHashPrefix: codeHash.slice(0, 8),
    });
    throw new SsoError('permission-denied', GENERIC, 'identity revalidation failed');
  }
  if (record.uid !== canonicalDriverAuthUid(record.driverId)) {
    deps.log('sso.exchange.rejected', {
      reason: 'uid_binding_mismatch',
      codeHashPrefix: codeHash.slice(0, 8),
    });
    throw new SsoError('permission-denied', GENERIC, 'uid_binding_mismatch');
  }

  // 4. Mint. Developer claims only — setCustomUserClaims would write to
  //    the shared Auth user and corrupt WB-S's own session, because both
  //    apps are the same Firebase project and the same UID.
  const customToken = await deps.mintCustomToken(record.uid, {
    kind: 'driver',
    driverId: driver.driverId,
    companyId: driver.companyId,
    // Per-audience app marker, from the canonical map rather than a
    // conditional, so a new audience cannot mint a token without a name.
    [SSO_SESSION_APP_CLAIM]: sessionAppForAudience(record.audience),
    // WBM only: authoritative roles/capabilities on THIS token. Other
    // audiences keep their established claim set unchanged.
    ...(isWbmAudience(record.audience)
      ? {
          roles: Array.isArray(driver.roles) && driver.roles.length ? driver.roles : ['driver'],
          isAdmin: driver.isAdmin === true,
          isViewer: driver.isViewer === true,
        }
      : {}),
  });

  deps.log('sso.exchange.succeeded', {
    audience: record.audience,
    protocolVersion: SSO_PROTOCOL_VERSION,
    codeHashPrefix: codeHash.slice(0, 8),
    elapsedMs: deps.nowMs() - record.issuedAtMs,
  });

  // 5. The authoritative display name, for the audience that needs one.
  //
  //    WB-T decides its logged-in state from a locally persisted identity,
  //    and that identity needs a name. It is NOT in the claims, so without
  //    this the app had to find one itself and looked in the legacy
  //    hash-keyed namespace, which holds nothing for a canonical driver id.
  //
  //    It comes from `driver` — the record revalidated three steps above —
  //    so it is the same authority that decided this bridge may complete.
  //    Nothing in the request contributes to it; the request carries no name
  //    and could not, since identity fields are refused at issuance.
  //
  //    NOT FATAL WHEN ABSENT. The code is already consumed and the grant is
  //    already valid. Failing here would tell a driver their sign-in was
  //    refused because of a gap in their profile record, and would burn the
  //    code doing it. The field is omitted instead and the client reports a
  //    bounded persistence-unavailable outcome.
  const displayName = (
    audienceCarriesDisplayName(record.audience as SsoAudience)
    || isWbmAudience(record.audience)
  )
    ? normalizeSsoDisplayName(driver.displayName)
    : null;

  return {
    protocolVersion: SSO_PROTOCOL_VERSION,
    customToken,
    uid: record.uid,
    driverId: driver.driverId,
    companyId: driver.companyId,
    // From the STORED record the server validated at issuance — never from
    // this request, which carries no binding at all. eQuipment scopes its
    // DVIR to this and to nothing it received in a deep link.
    ...(record.audience === SSO_AUDIENCE_EQUIPMENT && isSsoShiftBinding(record.shiftBinding)
      ? { shiftBinding: record.shiftBinding }
      : {}),
    ...(displayName ? { displayName } : {}),
  };
}

/** SHA-256 of a UTF-8 string as raw bytes, via the injected hex digest. */
function sha256Bytes(deps: SsoDeps, input: string): Uint8Array {
  const hex = deps.sha256Hex(input);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
