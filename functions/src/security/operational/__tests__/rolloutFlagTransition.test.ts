import { decideFlagTransition, type RolloutFlag, type TransitionIntent } from '../rolloutFlagTransition';

const RID = 'rollout-2026-08-30-a';
const SHA = 'dd5b3c538de10962fa96688c33c60ab60d1fcb3e';
const closeIntent: TransitionIntent = { op: 'close', rolloutId: RID, reviewedSha: SHA, changedBy: 'op:mike', reason: 'rollout' };
const reopenIntent: TransitionIntent = { op: 'reopen', rolloutId: RID, reviewedSha: SHA, changedBy: 'op:mike', reason: 'verified' };
const closed = (over: Partial<RolloutFlag> = {}): RolloutFlag => ({ paused: true, state: 'CLOSED', rolloutId: RID, reviewedSha: SHA, changedAt: 1, changedBy: 'op:mike', reason: 'rollout', ...over });
const open = (over: Partial<RolloutFlag> = {}): RolloutFlag => ({ paused: false, state: 'OPEN', rolloutId: RID, reviewedSha: SHA, changedAt: 1, changedBy: 'op:mike', reason: 'x', ...over });

describe('CAS flag transition — CLOSE', () => {
  it('absent → commit CLOSED with rollout id + sha', () => {
    const d = decideFlagTransition(null, closeIntent);
    expect(d.decision).toBe('commit');
    if (d.decision === 'commit') expect(d.next).toMatchObject({ paused: true, state: 'CLOSED', rolloutId: RID, reviewedSha: SHA });
  });
  it('OPEN → commit CLOSED', () => {
    expect(decideFlagTransition(open(), closeIntent).decision).toBe('commit');
  });
  it('already CLOSED by THIS rollout → noop (safe retry after committed close)', () => {
    expect(decideFlagTransition(closed(), closeIntent)).toEqual({ decision: 'noop', reason: 'already_closed_by_this_rollout' });
  });
  it('CLOSED by ANOTHER rollout → refuse', () => {
    expect(decideFlagTransition(closed({ rolloutId: 'other' }), closeIntent)).toEqual({ decision: 'refuse', reason: 'closed_by_other_rollout' });
  });
  it('CLOSED under another SHA (same rollout id) → refuse', () => {
    expect(decideFlagTransition(closed({ reviewedSha: 'deadbeef' }), closeIntent)).toEqual({ decision: 'refuse', reason: 'closed_under_other_sha' });
  });
  it('malformed prior value → refuse (never overwrite blindly)', () => {
    expect(decideFlagTransition({ foo: 1 }, closeIntent)).toEqual({ decision: 'refuse', reason: 'malformed_prior_value' });
    expect(decideFlagTransition({ paused: 'yes' }, closeIntent)).toEqual({ decision: 'refuse', reason: 'malformed_prior_value' });
  });
});

describe('CAS flag transition — REOPEN', () => {
  it('CLOSED by THIS rollout + same sha → commit OPEN', () => {
    const d = decideFlagTransition(closed(), reopenIntent);
    expect(d.decision).toBe('commit');
    if (d.decision === 'commit') expect(d.next).toMatchObject({ paused: false, state: 'OPEN', rolloutId: RID, reviewedSha: SHA });
  });
  it('reopen a flag closed by ANOTHER rollout → refuse', () => {
    expect(decideFlagTransition(closed({ rolloutId: 'other' }), reopenIntent)).toEqual({ decision: 'refuse', reason: 'reopen_other_rollout' });
  });
  it('reopen under a DIFFERENT reviewed sha → refuse', () => {
    expect(decideFlagTransition(closed(), { ...reopenIntent, reviewedSha: 'other-sha' })).toEqual({ decision: 'refuse', reason: 'reopen_sha_mismatch' });
  });
  it('reopen when NOT closed → refuse', () => {
    expect(decideFlagTransition(null, reopenIntent)).toEqual({ decision: 'refuse', reason: 'not_closed' });
  });
  it('already OPEN by THIS rollout → noop (safe retry after committed reopen)', () => {
    expect(decideFlagTransition(open(), reopenIntent)).toEqual({ decision: 'noop', reason: 'already_open_by_this_rollout' });
  });
  it('malformed prior value → refuse', () => {
    expect(decideFlagTransition('CLOSED', reopenIntent)).toEqual({ decision: 'refuse', reason: 'malformed_prior_value' });
  });
});

describe('CAS flag transition — intent guards', () => {
  it('missing rolloutId/sha → refuse', () => {
    expect(decideFlagTransition(null, { ...closeIntent, rolloutId: '' }).decision).toBe('refuse');
    expect(decideFlagTransition(null, { ...closeIntent, reviewedSha: '' }).decision).toBe('refuse');
  });
  it('exactly one of two simultaneous CLOSEs can commit (the second sees the first)', () => {
    // Operator A commits against absent.
    const a = decideFlagTransition(null, { ...closeIntent, rolloutId: 'A' });
    expect(a.decision).toBe('commit');
    // Operator B, re-running the transaction, now sees A's committed value.
    const committedByA = closed({ rolloutId: 'A' });
    const b = decideFlagTransition(committedByA, { ...closeIntent, rolloutId: 'B' });
    expect(b).toEqual({ decision: 'refuse', reason: 'closed_by_other_rollout' });
  });
});
