/** Targeted-recompute claim decision (idempotency / concurrency / retry). */
import { decideRecomputeClaim } from '../afr/recomputeClaim';

describe('decideRecomputeClaim', () => {
  it('no prior status → claim', () => {
    expect(decideRecomputeClaim(null, 100)).toBe('claim');
    expect(decideRecomputeClaim(undefined, 100)).toBe('claim');
  });
  it('same version already completed or processing → skip (no duplicate / concurrent guard)', () => {
    expect(decideRecomputeClaim({ status: 'completed', forRequestedAtUtc: 100 }, 100)).toBe('skip');
    expect(decideRecomputeClaim({ status: 'processing', forRequestedAtUtc: 100 }, 100)).toBe('skip');
  });
  it('same version previously failed → claim (retry)', () => {
    expect(decideRecomputeClaim({ status: 'failed', forRequestedAtUtc: 100 }, 100)).toBe('claim');
  });
  it('a newer request version → claim', () => {
    expect(decideRecomputeClaim({ status: 'completed', forRequestedAtUtc: 100 }, 200)).toBe('claim');
    expect(decideRecomputeClaim({ status: 'processing', forRequestedAtUtc: 100 }, 200)).toBe('claim');
  });
});
