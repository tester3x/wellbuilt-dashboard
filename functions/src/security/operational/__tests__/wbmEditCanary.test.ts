/**
 * Behavior-neutrality + governed-status proofs for the additive WB-M edit canary.
 * The gate MUST be closed in every configuration except an exact, fully-matched
 * allow-list entry with the master switch on — so deploying the (disabled)
 * functions changes nothing for any well or company.
 */
import {
  evaluateCanaryGate,
  classifyEditStatus,
  originalCarriesEdit,
  evaluateRecoveryPrecondition,
  type CanaryFlag,
} from '../wbmEditCanary';

const EVT = 'editevt_11111111-1111-4111-8111-111111111111';
const WELL = 'Test Well';
const ORIG = '20260831_230250_TestWell_a6sm54';

const openFlag: CanaryFlag = {
  enabled: true,
  allow: { [EVT]: { wellName: WELL, originalPacketId: ORIG } },
};

describe('evaluateCanaryGate — fail-closed behavior-neutrality', () => {
  const base = { editEventId: EVT, wellName: WELL, originalPacketId: ORIG };

  test('absent / null / empty flag ⇒ CLOSED (deploy is behavior-neutral)', () => {
    expect(evaluateCanaryGate({ ...base, flag: null })).toEqual({ allowed: false, reason: 'canary_flag_absent' });
    expect(evaluateCanaryGate({ ...base, flag: undefined })).toEqual({ allowed: false, reason: 'canary_flag_absent' });
    expect(evaluateCanaryGate({ ...base, flag: {} })).toEqual({ allowed: false, reason: 'canary_master_disabled' });
  });

  test('master enabled but no/empty allow-list ⇒ CLOSED', () => {
    expect(evaluateCanaryGate({ ...base, flag: { enabled: true } })).toEqual({ allowed: false, reason: 'canary_allowlist_empty' });
    expect(evaluateCanaryGate({ ...base, flag: { enabled: true, allow: {} } })).toEqual({ allowed: false, reason: 'edit_event_id_not_allowlisted' });
  });

  test('master NOT strictly true ⇒ CLOSED (no truthiness)', () => {
    for (const v of [1, 'true', 'yes', {}, [] as unknown]) {
      expect(evaluateCanaryGate({ ...base, flag: { enabled: v as unknown, allow: { [EVT]: { wellName: WELL, originalPacketId: ORIG } } } }).allowed).toBe(false);
    }
  });

  test('allow-listed but wrong well or original ⇒ CLOSED', () => {
    expect(evaluateCanaryGate({ ...base, flag: { enabled: true, allow: { [EVT]: { wellName: 'Gabriel 1', originalPacketId: ORIG } } } }))
      .toEqual({ allowed: false, reason: 'canary_well_mismatch' });
    expect(evaluateCanaryGate({ ...base, flag: { enabled: true, allow: { [EVT]: { wellName: WELL, originalPacketId: 'other' } } } }))
      .toEqual({ allowed: false, reason: 'canary_original_mismatch' });
  });

  test('a DIFFERENT editEventId is never allowed by this entry ⇒ CLOSED', () => {
    expect(evaluateCanaryGate({ ...base, editEventId: 'editevt_99999999-9999-4999-8999-999999999999', flag: openFlag }))
      .toEqual({ allowed: false, reason: 'edit_event_id_not_allowlisted' });
  });

  test('ONLY the exact enabled + allow-listed + well + original match ⇒ OPEN', () => {
    expect(evaluateCanaryGate({ ...base, flag: openFlag })).toEqual({ allowed: true });
  });
});

describe('classifyEditStatus — server-truth precedence', () => {
  const z = { receipt: null, original: null, rejected: null, incoming: null, editEventId: EVT };
  test('missing when nothing exists (the drifted-loss case)', () => {
    expect(classifyEditStatus(z)).toBe('missing');
  });
  test('pending when only incoming exists', () => {
    expect(classifyEditStatus({ ...z, incoming: { requestType: 'edit' } })).toBe('pending');
  });
  test('rejected when a quarantine exists (outranks pending)', () => {
    expect(classifyEditStatus({ ...z, rejected: { reason: 'x' }, incoming: { a: 1 } })).toBe('rejected');
  });
  test('applied when a receipt exists (outranks all)', () => {
    expect(classifyEditStatus({ ...z, receipt: { editEventId: EVT }, rejected: { reason: 'x' } })).toBe('applied');
  });
  test('applied when the original carries this edit event', () => {
    expect(classifyEditStatus({ ...z, original: { editCorrections: { [EVT]: { v: 1 } } } })).toBe('applied');
    expect(classifyEditStatus({ ...z, original: { editedByEventId: EVT } })).toBe('applied');
  });
  test('a DIFFERENT event on the original does NOT count as applied', () => {
    expect(originalCarriesEdit({ editCorrections: { other: {} } }, EVT)).toBe(false);
    expect(classifyEditStatus({ ...z, original: { editCorrections: { other: {} } } })).toBe('missing');
  });
});

describe('evaluateRecoveryPrecondition — proceed only when genuinely missing', () => {
  const z = { receipt: null, original: null, rejected: null, incoming: null, editEventId: EVT, recoveryClaim: null };
  test('proceeds when missing and unclaimed', () => {
    expect(evaluateRecoveryPrecondition(z)).toEqual({ proceed: true });
  });
  test('refuses when already applied/rejected/pending', () => {
    expect(evaluateRecoveryPrecondition({ ...z, receipt: { a: 1 } })).toEqual({ proceed: false, status: 'applied', reason: 'already_applied' });
    expect(evaluateRecoveryPrecondition({ ...z, rejected: { a: 1 } })).toEqual({ proceed: false, status: 'rejected', reason: 'already_rejected' });
    expect(evaluateRecoveryPrecondition({ ...z, incoming: { a: 1 } })).toEqual({ proceed: false, status: 'pending', reason: 'still_pending_in_incoming' });
  });
  test('refuses (idempotent) when a recovery claim already exists', () => {
    expect(evaluateRecoveryPrecondition({ ...z, recoveryClaim: { claimedAt: 1 } })).toEqual({ proceed: false, status: 'claimed', reason: 'recovery_already_claimed' });
  });
});
