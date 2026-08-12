/**
 * Onboarding ensure of initialized empty shift authority.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  decideEnsureEmptyAuthority,
  decideResolve,
  isCanonicalDriverIdShape,
  type ShiftAuthorityRecord,
} from '../operational/shiftAuthority';

const UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const HASH64 = 'fd5e1e99da0d3518c7ba9463f9c1cfe81f629242ccbf19d72726d3e9c9a19ec5';
const COMPANY = 'liquid-gold';
const PERIOD = '2026-08-08_211725';
const DAY = '2026-08-08';

const empty = (over: Partial<ShiftAuthorityRecord> = {}): ShiftAuthorityRecord => ({
  driverId: UUID,
  companyId: COMPANY,
  initialized: true,
  openPeriodId: null,
  originLocalDate: null,
  version: 1,
  ...over,
});

describe('isCanonicalDriverIdShape', () => {
  test('accepts UUID and rejects 64-char hex hash', () => {
    expect(isCanonicalDriverIdShape(UUID)).toBe(true);
    expect(isCanonicalDriverIdShape(HASH64)).toBe(false);
    expect(isCanonicalDriverIdShape('')).toBe(false);
  });
});

describe('decideEnsureEmptyAuthority', () => {
  test('missing company skips (does not invent binding)', () => {
    expect(decideEnsureEmptyAuthority({ driverId: UUID, companyId: null, existing: null }))
      .toEqual({ action: 'skip', reason: 'missing_company_id' });
    expect(decideEnsureEmptyAuthority({ driverId: UUID, companyId: '  ', existing: null }))
      .toEqual({ action: 'skip', reason: 'missing_company_id' });
  });

  test('legacy hash driverId is skipped as missing_driver_id', () => {
    expect(decideEnsureEmptyAuthority({ driverId: HASH64, companyId: COMPANY, existing: null }))
      .toEqual({ action: 'skip', reason: 'missing_driver_id' });
  });

  test('absent record creates initialized empty pointer', () => {
    const d = decideEnsureEmptyAuthority({ driverId: UUID, companyId: COMPANY, existing: null });
    expect(d.action).toBe('create');
    if (d.action !== 'create') return;
    expect(d.record).toEqual({
      driverId: UUID,
      companyId: COMPANY,
      initialized: true,
      openPeriodId: null,
      originLocalDate: null,
      version: 1,
    });
    expect(decideResolve(d.record, { driverId: UUID, companyId: COMPANY }))
      .toEqual({ state: 'none' });
  });

  test('healthy empty authority is preserved (idempotent)', () => {
    const d = decideEnsureEmptyAuthority({
      driverId: UUID,
      companyId: COMPANY,
      existing: empty(),
    });
    expect(d).toEqual({ action: 'noop', reason: 'already_healthy_empty' });
  });

  test('empty authority with lastClosedPeriodId is preserved', () => {
    const d = decideEnsureEmptyAuthority({
      driverId: UUID,
      companyId: COMPANY,
      existing: empty({ lastClosedPeriodId: PERIOD, version: 3 }),
    });
    expect(d).toEqual({ action: 'noop', reason: 'empty_with_history_preserved' });
  });

  test('open authority is preserved', () => {
    const d = decideEnsureEmptyAuthority({
      driverId: UUID,
      companyId: COMPANY,
      existing: empty({
        openPeriodId: PERIOD,
        originLocalDate: DAY,
        version: 2,
      }),
    });
    expect(d).toEqual({ action: 'noop', reason: 'open_preserved' });
  });

  test('driver mismatch refuses', () => {
    const d = decideEnsureEmptyAuthority({
      driverId: UUID,
      companyId: COMPANY,
      existing: empty({ driverId: 'other-driver-uuid-0000-0000-000000000001' }),
    });
    expect(d).toEqual({ action: 'refuse', reason: 'driver_mismatch' });
  });

  test('company mismatch refuses', () => {
    const d = decideEnsureEmptyAuthority({
      driverId: UUID,
      companyId: COMPANY,
      existing: empty({ companyId: 'other-co' }),
    });
    expect(d).toEqual({ action: 'refuse', reason: 'company_mismatch' });
  });

  test('uninitialized matching empty record can be completed', () => {
    const d = decideEnsureEmptyAuthority({
      driverId: UUID,
      companyId: COMPANY,
      existing: empty({ initialized: false, version: 1 }),
    });
    expect(d.action).toBe('initialize_uninitialized');
    if (d.action !== 'initialize_uninitialized') return;
    expect(d.record.initialized).toBe(true);
    expect(d.record.openPeriodId).toBeNull();
    expect(decideResolve(d.record, { driverId: UUID, companyId: COMPANY }).state).toBe('none');
  });

  test('half-open malformed refuses', () => {
    const d = decideEnsureEmptyAuthority({
      driverId: UUID,
      companyId: COMPANY,
      existing: empty({ openPeriodId: PERIOD, originLocalDate: null }),
    });
    expect(d).toEqual({ action: 'refuse', reason: 'malformed_record' });
  });
});

describe('provisioning source pins', () => {
  const root = join(__dirname, '..');
  const callables = readFileSync(join(root, 'driverAuthCallables.ts'), 'utf8');
  const ensureSrc = readFileSync(
    join(root, 'operational', 'ensureEmptyShiftAuthority.ts'),
    'utf8',
  );

  test('approve and setPasscode call ensureInitializedEmptyShiftAuthority', () => {
    expect(callables).toContain('ensureInitializedEmptyShiftAuthority');
    const approve = callables.slice(
      callables.indexOf('export const adminApproveDriverRegistration'),
      callables.indexOf('export const adminRejectDriverRegistration'),
    );
    expect(approve).toContain('ensureInitializedEmptyShiftAuthority');
    expect(approve).toContain('shift_authority_ensure_refused');
    const setPass = callables.slice(
      callables.indexOf('export const adminSetDriverPasscode'),
      callables.indexOf('export const adminDeleteSecureDriver'),
    );
    expect(setPass).toContain('ensureInitializedEmptyShiftAuthority');
  });

  test('ensure helper never keys by passcode hash and uses create under UUID path', () => {
    expect(ensureSrc).toContain('shiftAuthorityPath(input.driverId');
    expect(ensureSrc).toContain('tx.create');
    expect(ensureSrc).not.toMatch(/legacyHash|passcodeHash/);
  });

  test('standalone registration still has null company (no false authority)', () => {
    const stand = callables.slice(
      callables.indexOf('export const registerStandaloneDriver'),
    );
    expect(stand).toContain("companyId: null");
    // Standalone must not hard-require ensure failure
    expect(stand.includes('ensureInitializedEmptyShiftAuthority')).toBe(false);
  });
});

describe('authenticateDriver / authority key alignment', () => {
  test('authenticateDriver resolves driverId from name index (not approved hash)', () => {
    const src = readFileSync(join(__dirname, '..', 'driverAuthCallables.ts'), 'utf8');
    const auth = src.slice(
      src.indexOf('export const authenticateDriver'),
      src.indexOf('export const driverChangeOwnPasscode'),
    );
    expect(auth).toContain("collection('driver_name_index')");
    expect(auth).toContain('const driverId = idx.data()?.driverId');
    expect(auth).toContain('mintDriverSessionTokens');
    // Must not look up drivers/approved for identity
    expect(auth).not.toContain("drivers/approved");
  });
});
