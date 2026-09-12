/** General Equipment sign-on. Separate from the immutable shift-bound DVIR protocol. */
import { createHash, timingSafeEqual } from 'crypto';
import { SSO_AUDIENCE_EQUIPMENT, resolveWellbuiltAppKey } from '@tester3x/wellbuilt-contracts';
import { decideAppEntitlementAuthorization } from './appEntitlementAuthorization';
import { SsoError, type SsoDeps, type SsoAuthContext } from './ssoDeps';

const VERSION = 1;
const PURPOSE = 'equipment_app_access';
const bounded = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
function request(data: unknown, keys: string[]): Record<string, unknown> {
  if (!data || typeof data !== 'object' || Array.isArray(data)
      || Object.keys(data).some(k => !keys.includes(k)) || (data as any).version !== VERSION) {
    throw new SsoError('invalid-argument', 'malformed_request', 'invalid app-access request');
  }
  return data as Record<string, unknown>;
}

async function authorizeApp(deps: SsoDeps, driverId: string, companyId: string) {
  const driver = await deps.getDriver(driverId);
  if (!driver?.active || driver.companyId !== companyId) {
    throw new SsoError('permission-denied', 'not_authorized', 'app-access identity unavailable');
  }
  const company = await deps.getCompanyContract(companyId);
  const plan = company.contract ? await deps.getPlan(company.contract.planId) : null;
  const decision = decideAppEntitlementAuthorization({ app: resolveWellbuiltAppKey(SSO_AUDIENCE_EQUIPMENT),
    contractState: company.state, contract: company.contract, plan, shift: null });
  // Browsing an entitled app does not require a shift. This does not create
  // inspection authority, and commercial/company-disable refusals still deny.
  if (!decision.ok && decision.refusal !== 'active_shift_required') {
    throw new SsoError('permission-denied', 'not_authorized', 'equipment app not entitled');
  }
  return driver;
}

export async function issueEquipmentAppAccess(deps: SsoDeps, auth: SsoAuthContext, data: unknown) {
  if (!auth.uid) throw new SsoError('unauthenticated', 'not_authorized', 'app-access auth required');
  const req = request(data, ['version', 'codeChallenge']);
  if (!bounded(req.codeChallenge)) throw new SsoError('invalid-argument', 'malformed_request', 'invalid challenge');
  const { kind, driverId, companyId } = auth.claims;
  if (kind !== 'driver' || typeof driverId !== 'string' || !driverId || typeof companyId !== 'string' || !companyId) {
    throw new SsoError('permission-denied', 'not_authorized', 'driver claims required');
  }
  await authorizeApp(deps, driverId, companyId);
  const code = deps.base64Url(deps.randomBytes(32));
  const issuedAtMs = deps.nowMs();
  const expiresAtMs = issuedAtMs + 60000;
  await deps.runTransaction(async tx => {
    tx.create(`equipment_app_codes/${deps.sha256Hex(code)}`, { version: VERSION, purpose: PURPOSE,
      uid: auth.uid, driverId, companyId, codeChallenge: req.codeChallenge,
      issuedAtMs, expiresAtMs, expiresAt: deps.expiresAtTimestamp(expiresAtMs), consumed: false });
  });
  return { version: VERSION, code, expiresAtMs };
}

export async function exchangeEquipmentAppAccess(deps: SsoDeps, data: unknown) {
  const req = request(data, ['version', 'code', 'codeVerifier']);
  if (!bounded(req.code) || !bounded(req.codeVerifier)) throw new SsoError('invalid-argument', 'malformed_request', 'invalid code/verifier');
  const path = `equipment_app_codes/${deps.sha256Hex(req.code)}`;
  const challenge = createHash('sha256').update(req.codeVerifier).digest('base64url');
  const record = await deps.runTransaction(async tx => {
    const snap = await tx.get(path);
    const r = snap.data;
    if (!snap.exists || !r || r.version !== VERSION || r.purpose !== PURPOSE || r.consumed !== false
      || typeof r.expiresAtMs !== 'number' || deps.nowMs() >= r.expiresAtMs
      || !bounded(r.codeChallenge) || !timingSafeEqual(Buffer.from(challenge), Buffer.from(r.codeChallenge))
      || typeof r.uid !== 'string' || typeof r.driverId !== 'string' || typeof r.companyId !== 'string') {
      throw new SsoError('permission-denied', 'invalid_grant', 'invalid app-access grant');
    }
    tx.update(path, { consumed: true, consumedAtMs: deps.nowMs() });
    return { uid: r.uid, driverId: r.driverId, companyId: r.companyId };
  });
  const driver = await authorizeApp(deps, record.driverId, record.companyId);
  const customToken = await deps.mintCustomToken(record.uid, {
    kind: 'driver', driverId: record.driverId, companyId: record.companyId, app: 'equipment',
  });
  return { version: VERSION, ...record, displayName: driver.displayName, customToken };
}
