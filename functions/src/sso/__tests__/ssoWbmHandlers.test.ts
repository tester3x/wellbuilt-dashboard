/**
 * Full WBM issue/exchange handler tests — not source regex pins.
 */
import { createHash } from 'crypto';
import { handleSsoIssueCode } from '../ssoIssueHandler';
import { handleSsoExchange } from '../ssoExchangeHandler';
import {
  SSO_AUDIENCE_EQUIPMENT,
  SSO_AUDIENCE_WBT,
  SSO_PROTOCOL_VERSION,
  SSO_SESSION_APP_CLAIM,
} from '@tester3x/wellbuilt-contracts';
import {
  SSO_AUDIENCE_WBM,
  resolveWellbuiltAppKeyAllowingWbm,
  validateSsoExchangeRequestAllowingWbm,
} from '../ssoWbmAdapter';
import { SsoError, type SsoDeps } from '../ssoDeps';
import { canonicalDriverAuthUid } from '../../security/canonicalDriverUid';

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const challengeFor = (verifier: string) =>
  createHash('sha256').update(verifier, 'utf8').digest('base64url');

function makeWorld(opts: {
  startMs?: number;
  drivers?: Map<string, Record<string, unknown>>;
  plans?: Map<string, Record<string, unknown>>;
} = {}) {
  const docs = new Map<string, { version: number; data: Record<string, unknown> }>();
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const minted: Array<{ uid: string; claims: Record<string, unknown> }> = [];
  let now = opts.startMs ?? 1_700_000_000_000;
  let counter = 0;
  let readBarrier: Promise<void> | null = null;
  const drivers = opts.drivers ?? new Map<string, Record<string, unknown>>([
    [
      'iphone-uuid',
      {
        driverId: 'iphone-uuid',
        companyId: 'liquid-gold',
        active: true,
        displayName: 'iPhone16',
        roles: ['admin'],
        isAdmin: true,
        isViewer: false,
      },
    ],
  ]);
  const deps: SsoDeps = {
    nowMs: () => now,
    randomBytes: (n) => {
      counter += 1;
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = (i * 7 + counter * 31) & 0xff;
      return out;
    },
    sha256Hex,
    base64Url: b64url,
    expiresAtTimestamp: (ms) => ({ __timestamp: true, ms }),
    getDriver: async (id) => (drivers.get(id) as never) ?? null,
    getShiftDay: async () => ({ readable: true, present: false }),
    getShiftAuthority: async () => null,
    getCompanyContract: async () => ({
      state: 'active',
      contract: { planId: 'plan-1', contractEnforced: true } as never,
    }),
    getPlan: async (planId) =>
      (opts.plans?.get(planId) as never) ??
      ({
        contractVersion: 1,
        planId,
        displayName: 'P',
        capabilities: [],
        status: 'active',
        apps: { 'wellbuilt-mobile': { included: true }, 'wellbuilt-tickets': { included: true } },
      } as never),
    runTransaction: async (fn) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const readVersions = new Map<string, number>();
        const writes: Array<{ kind: 'update' | 'create'; path: string; fields?: Record<string, unknown>; data?: Record<string, unknown> }> = [];
        const tx = {
          get: async (path: string) => {
            if (readBarrier) await readBarrier;
            const d = docs.get(path);
            readVersions.set(path, d ? d.version : -1);
            return d ? { exists: true, data: { ...d.data } } : { exists: false };
          },
          update: (path: string, fields: Record<string, unknown>) => writes.push({ kind: 'update', path, fields }),
          create: (path: string, data: Record<string, unknown>) => writes.push({ kind: 'create', path, data }),
        };
        const result = await fn(tx);
        let conflict = false;
        for (const [path, version] of readVersions) {
          const cur = docs.get(path);
          if ((cur ? cur.version : -1) !== version) {
            conflict = true;
            break;
          }
        }
        if (conflict) continue;
        for (const w of writes) {
          const cur = docs.get(w.path);
          if (w.kind === 'create') {
            if (cur) throw new Error('ALREADY_EXISTS');
            docs.set(w.path, { version: 0, data: { ...w.data } });
          } else {
            if (!cur) throw new Error('NOT_FOUND');
            docs.set(w.path, { version: cur.version + 1, data: { ...cur.data, ...w.fields } });
          }
        }
        return result;
      }
      throw new Error('TX_RETRY_EXHAUSTED');
    },
    mintCustomToken: async (uid, claims) => {
      minted.push({ uid, claims });
      return `custom.${uid}`;
    },
    log: (event, fields) => logs.push({ event, fields }),
  };
  return {
    deps,
    docs,
    logs,
    minted,
    drivers,
    advance: (ms: number) => {
      now += ms;
    },
    setBarrier: (p: Promise<void> | null) => {
      readBarrier = p;
    },
  };
}

const IPHONE_ID = 'iphone-uuid';
const AUTH = {
  uid: canonicalDriverAuthUid(IPHONE_ID),
  claims: { kind: 'driver', driverId: IPHONE_ID, companyId: 'liquid-gold' },
};
const VERIFIER = 'v'.repeat(43);
const wbmIssue = (over: Record<string, unknown> = {}) => ({
  protocolVersion: SSO_PROTOCOL_VERSION,
  audience: SSO_AUDIENCE_WBM,
  codeChallenge: challengeFor(VERIFIER),
  codeChallengeMethod: 'S256',
  ...over,
});
const wbmExchange = (code: string, over: Record<string, unknown> = {}) => ({
  protocolVersion: SSO_PROTOCOL_VERSION,
  audience: SSO_AUDIENCE_WBM,
  code,
  codeVerifier: VERIFIER,
  ...over,
});

describe('WBM SSO handlers', () => {
  it('resolves wellbuilt-mobile to the mobile app key, not undefined', () => {
    expect(resolveWellbuiltAppKeyAllowingWbm('wellbuilt-mobile')).toBe('wellbuilt-mobile');
    expect(resolveWellbuiltAppKeyAllowingWbm('wellbuilt-tickets')).toBeTruthy();
  });

  it('rejects unsupported or malformed WBM protocol versions instead of accepting them', () => {
    const bad = validateSsoExchangeRequestAllowingWbm({
      protocolVersion: 99,
      audience: SSO_AUDIENCE_WBM,
      code: 'c'.repeat(43),
      codeVerifier: VERIFIER,
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errorCode).toBe('unsupported_protocol');
    const malformed = validateSsoExchangeRequestAllowingWbm({
      protocolVersion: '1',
      audience: SSO_AUDIENCE_WBM,
      code: 'c'.repeat(43),
      codeVerifier: VERIFIER,
    });
    expect(malformed.ok).toBe(false);
    const omitted = validateSsoExchangeRequestAllowingWbm({
      audience: SSO_AUDIENCE_WBM,
      code: 'c'.repeat(43),
      codeVerifier: VERIFIER,
    });
    expect(omitted.ok).toBe(false);
  });

  it('rejects a mismatched Auth UID and writes no code', async () => {
    const w = makeWorld();
    await expect(
      handleSsoIssueCode(w.deps, { ...AUTH, uid: 'driver_notthecanonicaluid' }, wbmIssue()),
    ).rejects.toMatchObject({ publicCode: 'not_authorized' });
    expect(w.docs.size).toBe(0);
  });

  it('mints nothing when a stored code UID is not the canonical driver UID', async () => {
    const w = makeWorld();
    const { code } = await handleSsoIssueCode(w.deps, AUTH, wbmIssue());
    const rec = [...w.docs.values()][0];
    rec.data.uid = 'driver_tamperedlegacyuid00001';
    await expect(handleSsoExchange(w.deps, wbmExchange(code))).rejects.toMatchObject({
      publicCode: 'invalid_grant',
    });
    expect(w.minted).toHaveLength(0);
  });

  it('issues for an authenticated iPhone16 wellbuilt-mobile session', async () => {
    const w = makeWorld();
    const res = await handleSsoIssueCode(w.deps, AUTH, wbmIssue());
    expect(res.code.length).toBeGreaterThan(20);
    expect(w.docs.size).toBe(1);
  });

  it('allows entitled WBM and denies an excluded plan', async () => {
    const deny = makeWorld({
      plans: new Map([
        [
          'plan-1',
          {
            contractVersion: 1,
            planId: 'plan-1',
            displayName: 'P',
            capabilities: [],
            status: 'active',
            apps: { 'wellbuilt-mobile': { included: false } },
          },
        ],
      ]),
    });
    await expect(handleSsoIssueCode(deny.deps, AUTH, wbmIssue())).rejects.toBeInstanceOf(SsoError);
  });

  it('exchanges with PKCE and mints a WBM Firebase Auth session', async () => {
    const w = makeWorld();
    const { code } = await handleSsoIssueCode(w.deps, AUTH, wbmIssue());
    const res = await handleSsoExchange(w.deps, wbmExchange(code));
    expect(res.customToken).toBeTruthy();
    expect(res.driverId).toBe('iphone-uuid');
    expect(res.companyId).toBe('liquid-gold');
    expect(res.displayName).toBe('iPhone16');
    expect(w.minted[0].claims[SSO_SESSION_APP_CLAIM]).toBe('wbm');
    expect(w.minted[0].claims.roles).toEqual(['admin']);
    expect(w.minted[0].claims.isAdmin).toBe(true);
  });

  it('rejects a wrong verifier, invalid protocol, and audience mismatch', async () => {
    const w = makeWorld();
    const { code } = await handleSsoIssueCode(w.deps, AUTH, wbmIssue());
    await expect(
      handleSsoExchange(w.deps, wbmExchange(code, { codeVerifier: 'w'.repeat(43) })),
    ).rejects.toMatchObject({ publicCode: 'invalid_grant' });
    await expect(
      handleSsoExchange(w.deps, wbmExchange(code, { protocolVersion: 99 })),
    ).rejects.toBeInstanceOf(SsoError);
    await expect(
      handleSsoExchange(w.deps, wbmExchange(code, { protocolVersion: 'v2' })),
    ).rejects.toBeInstanceOf(SsoError);
    await expect(
      handleSsoExchange(w.deps, { ...wbmExchange(code), audience: SSO_AUDIENCE_WBT }),
    ).rejects.toMatchObject({ publicCode: 'invalid_grant' });
  });

  it('rejects replay and allows only one of two simultaneous exchanges', async () => {
    const w = makeWorld();
    const { code } = await handleSsoIssueCode(w.deps, AUTH, wbmIssue());
    await handleSsoExchange(w.deps, wbmExchange(code));
    await expect(handleSsoExchange(w.deps, wbmExchange(code))).rejects.toMatchObject({
      publicCode: 'invalid_grant',
    });

    const w2 = makeWorld();
    const issued = await handleSsoIssueCode(w2.deps, AUTH, wbmIssue());
    let release: () => void = () => undefined;
    w2.setBarrier(new Promise<void>((r) => { release = r; }));
    const a = handleSsoExchange(w2.deps, wbmExchange(issued.code));
    const b = handleSsoExchange(w2.deps, wbmExchange(issued.code));
    release();
    const settled = await Promise.allSettled([a, b]);
    const ok = settled.filter((s) => s.status === 'fulfilled');
    const bad = settled.filter((s) => s.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
  });

  it('rejects expired codes, disabled drivers, and company drift', async () => {
    const expired = makeWorld();
    const { code } = await handleSsoIssueCode(expired.deps, AUTH, wbmIssue());
    expired.advance(20 * 60 * 1000);
    await expect(handleSsoExchange(expired.deps, wbmExchange(code))).rejects.toMatchObject({
      publicCode: 'invalid_grant',
    });

    const disabled = makeWorld();
    const issued = await handleSsoIssueCode(disabled.deps, AUTH, wbmIssue());
    disabled.drivers.set('iphone-uuid', {
      ...disabled.drivers.get('iphone-uuid')!,
      active: false,
    });
    await expect(handleSsoExchange(disabled.deps, wbmExchange(issued.code))).rejects.toMatchObject({
      publicCode: 'invalid_grant',
    });

    const drift = makeWorld();
    const issued2 = await handleSsoIssueCode(drift.deps, AUTH, wbmIssue());
    drift.drivers.set('iphone-uuid', {
      ...drift.drivers.get('iphone-uuid')!,
      companyId: 'acme-eog-test',
    });
    await expect(handleSsoExchange(drift.deps, wbmExchange(issued2.code))).rejects.toMatchObject({
      publicCode: 'invalid_grant',
    });
  });

  it('does not change WBT or equipment audience constants', () => {
    expect(SSO_AUDIENCE_WBT).toBe('wellbuilt-tickets');
    expect(SSO_AUDIENCE_EQUIPMENT).toBe('wellbuilt-equipment');
    expect(SSO_AUDIENCE_WBM).toBe('wellbuilt-mobile');
  });
});
