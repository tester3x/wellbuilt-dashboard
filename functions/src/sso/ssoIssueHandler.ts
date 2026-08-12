/**
 * SSO authorization-code issuance.
 *
 * Called by WB-S with an ALREADY AUTHENTICATED driver session. The whole
 * security value of this handler is that the identity bound into the code
 * comes from the callable's verified Auth context and from authoritative
 * server records — never from the request body. A caller who could name
 * its own driverId could mint a bridge into someone else's account.
 */
import {
  SSO_AUDIENCE_EQUIPMENT,
  isSsoAudience,
  resolveWellbuiltAppKey,
  type SsoShiftBinding,
  SSO_CODE_BYTES,
  SSO_CODE_TTL_MS_PROVISIONAL,
  SSO_PROTOCOL_VERSION,
  validateSsoIssueCodeRequest,
  type SsoIssueCodeResponse,
} from '@tester3x/wellbuilt-contracts';
import {
  SsoError,
  ssoCodePath,
  type SsoAuthContext,
  type SsoDeps,
} from './ssoDeps.js';
import { decideEquipmentAuthorization, shiftOriginDay } from './equipmentAuthorization.js';
import { decideAppEntitlementAuthorization } from './appEntitlementAuthorization.js';
import { decideResolve } from '../security/operational/shiftAuthority.js';

/** Fields a client may never dictate. Presence is a protocol violation. */
const CLIENT_FORBIDDEN_IDENTITY_FIELDS = ['uid', 'driverId', 'companyId', 'driverHash', 'passcode'];

export async function handleSsoIssueCode(
  deps: SsoDeps,
  auth: SsoAuthContext,
  data: unknown,
): Promise<SsoIssueCodeResponse> {
  // 1. Authenticated callers only. Anonymous is not a driver.
  if (!auth.uid) {
    throw new SsoError('unauthenticated', 'not_authorized', 'no auth context');
  }

  // 2. The request must not attempt to supply identity at all. This is a
  //    hard reject rather than a silent ignore: a client sending these
  //    fields is either malicious or dangerously out of date.
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const keys = Object.keys(data as Record<string, unknown>);
    const offending = keys.filter((k) => CLIENT_FORBIDDEN_IDENTITY_FIELDS.includes(k));
    if (offending.length > 0) {
      throw new SsoError(
        'invalid-argument',
        'malformed_request',
        `client supplied identity fields: ${offending.join(',')}`,
      );
    }
  }

  // 3. Protocol/audience/method/challenge validation, all fail-closed.
  const parsed = validateSsoIssueCodeRequest(data);
  if (!parsed.ok) {
    throw new SsoError('invalid-argument', parsed.errorCode, `invalid ${parsed.field}`);
  }
  const req = parsed.value;
  // Both canonical audiences are issuable. The protocol validator has
  // already enforced that shiftBinding is present for equipment and absent
  // for WB-T, so a WB-T request reaching here is byte-identical to before.
  if (!isSsoAudience(req.audience)) {
    throw new SsoError('invalid-argument', 'unsupported_audience', 'audience not allowlisted');
  }

  // 4. Verified CURRENT claims. A driver session and nothing else.
  const kind = auth.claims.kind;
  const claimDriverId = auth.claims.driverId;
  const claimCompanyId = auth.claims.companyId;
  if (kind !== 'driver') {
    throw new SsoError('permission-denied', 'not_authorized', `claims.kind=${String(kind)}`);
  }
  if (typeof claimDriverId !== 'string' || claimDriverId.length === 0) {
    throw new SsoError('permission-denied', 'not_authorized', 'claims.driverId missing');
  }
  if (typeof claimCompanyId !== 'string' || claimCompanyId.length === 0) {
    throw new SsoError('permission-denied', 'not_authorized', 'claims.companyId missing');
  }

  // 5. Claims are a snapshot from token-mint time. Re-check them against
  //    the authoritative record, so a driver disabled or moved between
  //    companies since sign-in cannot bridge on a stale token.
  const driver = await deps.getDriver(claimDriverId);
  if (!driver) {
    throw new SsoError('permission-denied', 'not_authorized', 'driver record absent');
  }
  if (!driver.active) {
    throw new SsoError('permission-denied', 'not_authorized', 'driver inactive');
  }
  if (driver.companyId !== claimCompanyId) {
    throw new SsoError('permission-denied', 'not_authorized', 'company drifted from claims');
  }

  // One server clock reading drives both the authorization decision and
  // the code lifetime, so a slow authorization cannot shorten the TTL.
  const issuedAtMsPre = deps.nowMs();

  // 5b. EQUIPMENT ONLY — the governed DVIR handoff must be authorized
  //     against authoritative state, not against the client's word. The
  //     shift binding WB-S supplied is treated as a REQUEST, and is
  //     replaced below by the normalized binding the server validated.
  //     A well-formed shift id proves nothing on its own.
  let storedBinding: SsoShiftBinding | undefined;
  if (req.audience === SSO_AUDIENCE_EQUIPMENT) {
    const requested = req.shiftBinding;
    if (!requested) {
      // Unreachable via the validator; kept so the invariant is enforced
      // here too rather than assumed from a caller two modules away.
      throw new SsoError('invalid-argument', 'malformed_request', 'shiftBinding required');
    }
    const originDay = shiftOriginDay(requested.shiftId);
    if (!originDay) {
      throw new SsoError('invalid-argument', 'malformed_request', 'shift id has no origin day');
    }
    const [contractState, originDayDoc] = await Promise.all([
      deps.getCompanyContract(driver.companyId),
      deps.getShiftDay(driver.driverId, originDay),
    ]);
    const plan = contractState.contract
      ? await deps.getPlan(contractState.contract.planId)
      : null;

    const decision = decideEquipmentAuthorization({
      driverId: driver.driverId,
      companyId: driver.companyId,
      binding: requested,
      contract: contractState.contract,
      contractState: contractState.state,
      plan,
      originDayDoc,
      nowMs: issuedAtMsPre,
    });
    if (!decision.ok) {
      // Coarse to the client, precise to the operator: a caller must not be
      // able to probe which shifts exist by reading back distinct reasons.
      deps.log('sso.code.refused', {
        audience: req.audience,
        reason: decision.reason,
        detail: decision.detail,
      });
      throw new SsoError('permission-denied', 'not_authorized', decision.reason);
    }
    storedBinding = decision.binding;
  }

  // 5c. COMMERCIAL ENTITLEMENT. Does the SELECTED company's plan include
  //     this destination app, and if so does reaching it require an
  //     authoritative open shift? Decided here — BEFORE any code is minted
  //     or any issuance state is touched — so a denial leaves the system
  //     byte-identical to never having been asked.
  //
  //     Every input is a server record. The audience is mapped to its
  //     canonical app key by the contract itself, so no second naming
  //     table exists and an alias or unknown identity can never resolve.
  {
    const app = resolveWellbuiltAppKey(req.audience);
    const contractState = await deps.getCompanyContract(driver.companyId);
    const plan = contractState.contract
      ? await deps.getPlan(contractState.contract.planId)
      : null;
    const authzInput = {
      app,
      contractState: contractState.state,
      contract: contractState.contract,
      plan,
    };
    // Two-phase: the authority read happens ONLY when the canonical
    // decision says a shift is required, so the plan — not this handler —
    // decides whether the extra read is owed.
    let decision = decideAppEntitlementAuthorization({ ...authzInput, shift: null });
    if (!decision.ok && decision.refusal === 'active_shift_required') {
      // The authoritative, date-free shift record. It is bound to BOTH the
      // driver and the selected company, so a shift belonging to another
      // membership cannot satisfy this gate, and a closed, superseded,
      // half-written or absent record resolves to something other than
      // 'open' rather than being guessed at. Nothing here reads a
      // timestamp, a cached client value, or a request field.
      const record = await deps.getShiftAuthority(driver.driverId);
      const shift = decideResolve(record, {
        driverId: driver.driverId,
        companyId: driver.companyId,
      });
      decision = decideAppEntitlementAuthorization({ ...authzInput, shift });
    }
    if (!decision.ok) {
      // Coarse to the client, precise to the operator — the same shape the
      // equipment refusal uses. `refusal` separates commercial exclusion
      // from an unmet shift gate for whoever reads the logs; the client is
      // told only 'not_authorized', so it cannot probe a company's plan.
      deps.log('sso.code.refused', {
        audience: req.audience,
        reason: decision.refusal,
        detail: decision.detail,
      });
      throw new SsoError('permission-denied', 'not_authorized', decision.refusal);
    }
  }

  // 6. Server-generated code and timestamps. The client contributes
  //    nothing to either.
  const raw = deps.base64Url(deps.randomBytes(SSO_CODE_BYTES));
  const codeHash = deps.sha256Hex(raw);
  const issuedAtMs = issuedAtMsPre;
  const expiresAtMs = issuedAtMs + SSO_CODE_TTL_MS_PROVISIONAL;

  // 7. Store only the HASH. A database reader — backup, export, or a
  //    compromised console session — must not be able to redeem anything.
  await deps.runTransaction(async (tx) => {
    tx.create(ssoCodePath(codeHash), {
      codeHash,
      uid: auth.uid,
      driverId: driver.driverId,
      companyId: driver.companyId,
      audience: req.audience,
      codeChallenge: req.codeChallenge,
      protocolVersion: SSO_PROTOCOL_VERSION,
      issuedAtMs,
      expiresAtMs,
      // Firestore-native mirror for the TTL policy. Protocol validation
      // still uses expiresAtMs — a Timestamp comparison in the consume
      // transaction would depend on a policy that is not yet configured.
      expiresAt: deps.expiresAtTimestamp(expiresAtMs),
      consumed: false,
      ...(storedBinding ? { shiftBinding: storedBinding } : {}),
    });
  });

  // 8. Redacted log. No raw code, no challenge, no token, no identifiers
  //    beyond what an operator needs to correlate a failure.
  deps.log('sso.code.issued', {
    audience: req.audience,
    protocolVersion: SSO_PROTOCOL_VERSION,
    ttlMs: SSO_CODE_TTL_MS_PROVISIONAL,
    codeHashPrefix: codeHash.slice(0, 8),
  });

  return {
    protocolVersion: SSO_PROTOCOL_VERSION,
    code: raw,
    expiresInSeconds: Math.floor(SSO_CODE_TTL_MS_PROVISIONAL / 1000),
  };
}
