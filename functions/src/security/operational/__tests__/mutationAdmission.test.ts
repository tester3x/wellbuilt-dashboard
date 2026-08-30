// Blocker-3 pure unit: the admission decision fails OPEN on absent/malformed
// and closes ONLY on explicit paused:true.
import { decideAdmission, MAINTENANCE_REASON } from '../mutationAdmission';

describe('decideAdmission', () => {
  test('absent flag → admitted (fail open)', () => {
    expect(decideAdmission(null)).toEqual({ admitted: true, reason: 'open' });
    expect(decideAdmission(undefined)).toMatchObject({ admitted: true });
  });
  test('malformed values → admitted (fail open, never wedge production)', () => {
    for (const v of ['paused', 1, [], { paused: 'true' }, { paused: 1 }, { other: true }]) {
      expect(decideAdmission(v).admitted).toBe(true);
    }
  });
  test('explicit paused:true → NOT admitted, carries reason', () => {
    expect(decideAdmission({ paused: true })).toEqual({ admitted: false, reason: MAINTENANCE_REASON });
    expect(decideAdmission({ paused: true, reason: 'rollout-2026-08-30' })).toEqual({ admitted: false, reason: 'rollout-2026-08-30' });
  });
  test('paused:false → admitted', () => {
    expect(decideAdmission({ paused: false }).admitted).toBe(true);
  });
});

describe('gate is wired into both driver producers (source)', () => {
  const read = (rel: string) => require('fs').readFileSync(require('path').join(__dirname, '..', rel), 'utf8');
  test('ingestWbmPull and ingestWbmEdit both check admission before writing incoming, returning the retryable code', () => {
    for (const f of ['ingestWbmPull.ts', 'ingestWbmEdit.ts']) {
      const src = read(f);
      expect(src).toContain('checkMutationAdmission()');
      expect(src).toContain('MAINTENANCE_ERROR_CODE');
    }
  });
});
