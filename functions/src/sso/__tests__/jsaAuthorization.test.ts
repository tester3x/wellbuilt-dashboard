/**
 * JSA spine — the server-authored authority binding, decided in-memory.
 *
 * The property under test: a JSA session can only ever be bound to what
 * the AUTHORITY record proves — an exact open period (with its frozen
 * origin day) or a proven none — and every unverifiable authority state
 * refuses. There is no UTC-date fallback and no client-proposed shift
 * anywhere in this decision.
 */
import { decideJsaBinding, readStoredJsaBinding } from '../jsaAuthorization';
import type { ResolveResult } from '../../security/operational/shiftAuthority';

const OPEN: ResolveResult = {
  state: 'open',
  periodId: '2026-08-12_073000',
  originLocalDate: '2026-08-12',
};
const NONE: ResolveResult = { state: 'none' };
const unverifiable = (reason: 'authority_absent' | 'authority_uninitialized' | 'authority_inconsistent' | 'driver_mismatch'): ResolveResult =>
  ({ state: 'unverifiable', reason });

describe('open shift', () => {
  test('an authoritative open period binds exactly, with its origin day', () => {
    const d = decideJsaBinding({ shift: OPEN, requiresActiveShift: true, jsaEnabled: true });
    expect(d).toEqual({
      ok: true,
      binding: {
        shiftState: 'open',
        periodId: '2026-08-12_073000',
        originLocalDate: '2026-08-12',
        requiresActiveShift: true,
        jsaEnabled: true,
      },
    });
  });

  test('a cross-midnight period binds to its ORIGIN day, never a current date', () => {
    const d = decideJsaBinding({
      shift: { state: 'open', periodId: '2026-08-11_223000', originLocalDate: '2026-08-11' },
      requiresActiveShift: true,
      jsaEnabled: true,
    });
    expect(d.ok && d.binding.originLocalDate).toBe('2026-08-11');
  });

  test('an open period binds even when no shift was required (still authoritative)', () => {
    const d = decideJsaBinding({ shift: OPEN, requiresActiveShift: false, jsaEnabled: true });
    expect(d.ok && d.binding.shiftState).toBe('open');
  });
});

describe('none / owner-operator', () => {
  test('proven none + shift NOT required binds as none with no period fields', () => {
    const d = decideJsaBinding({ shift: NONE, requiresActiveShift: false, jsaEnabled: true });
    expect(d).toEqual({
      ok: true,
      binding: { shiftState: 'none', requiresActiveShift: false, jsaEnabled: true },
    });
  });

  test('proven none + shift required refuses (the Liquid Gold gate)', () => {
    const d = decideJsaBinding({ shift: NONE, requiresActiveShift: true, jsaEnabled: true });
    expect(d).toEqual({ ok: false, refusal: 'active_shift_required', detail: 'shift_none' });
  });

  test('policy flags ride the binding so the app never re-derives policy', () => {
    const d = decideJsaBinding({ shift: NONE, requiresActiveShift: false, jsaEnabled: false });
    expect(d.ok && d.binding.jsaEnabled).toBe(false);
  });
});

describe('unverifiable authority — always refused, never represented', () => {
  for (const reason of [
    'authority_absent', 'authority_uninitialized', 'authority_inconsistent', 'driver_mismatch',
  ] as const) {
    test(`${reason} refuses even when no shift is required`, () => {
      const d = decideJsaBinding({
        shift: unverifiable(reason), requiresActiveShift: false, jsaEnabled: true,
      });
      expect(d).toEqual({
        ok: false,
        refusal: 'authority_unverifiable',
        detail: `authority_${reason}`,
      });
    });
    test(`${reason} refuses when a shift is required`, () => {
      expect(decideJsaBinding({
        shift: unverifiable(reason), requiresActiveShift: true, jsaEnabled: true,
      }).ok).toBe(false);
    });
  }
});

describe('stored-binding round trip', () => {
  const OPEN_BINDING = {
    shiftState: 'open', periodId: '2026-08-12_073000', originLocalDate: '2026-08-12',
    requiresActiveShift: true, jsaEnabled: true,
  };

  test('what issuance stores, exchange reads back byte-for-byte', () => {
    expect(readStoredJsaBinding(OPEN_BINDING)).toEqual(OPEN_BINDING);
    const none = { shiftState: 'none', requiresActiveShift: false, jsaEnabled: true };
    expect(readStoredJsaBinding(none)).toEqual(none);
  });

  test('a tampered or corrupted stored binding is dropped, not repaired', () => {
    expect(readStoredJsaBinding({ ...OPEN_BINDING, originLocalDate: '2026-08-11' })).toBeNull();
    expect(readStoredJsaBinding({ ...OPEN_BINDING, periodId: '2026-08-12T07:30:00Z' })).toBeNull();
    expect(readStoredJsaBinding({ ...OPEN_BINDING, extra: 'field' })).toBeNull();
    expect(readStoredJsaBinding({ shiftState: 'open', requiresActiveShift: true, jsaEnabled: true })).toBeNull();
    expect(readStoredJsaBinding({ shiftState: 'none', periodId: '2026-08-12_073000', requiresActiveShift: false, jsaEnabled: true })).toBeNull();
    expect(readStoredJsaBinding({ shiftState: 'stale', requiresActiveShift: true, jsaEnabled: true })).toBeNull();
    expect(readStoredJsaBinding(null)).toBeNull();
    expect(readStoredJsaBinding('binding')).toBeNull();
  });

  test('a June period cannot masquerade under an August origin day', () => {
    expect(readStoredJsaBinding({
      shiftState: 'open', periodId: '2026-06-14_080000', originLocalDate: '2026-08-12',
      requiresActiveShift: true, jsaEnabled: true,
    })).toBeNull();
  });
});
