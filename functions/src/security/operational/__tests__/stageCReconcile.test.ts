import { reconcileStageC, STAGE_C_FUNCTIONS, type ReconcileInput } from '../stageCReconcile';

const INTENDED = {
  processIncomingPull: 'rev-100',
  processEditRequest: 'rev-100',
  processDeleteRequest: 'rev-100',
  watchdogStrandedPackets: 'rev-100',
};
// observed where the named fns are updated to the intended revision, the rest still old.
function observedWith(updated: string[], rev = 'rev-100', old = 'rev-099'): Record<string, string | null> {
  const o: Record<string, string | null> = {};
  for (const fn of STAGE_C_FUNCTIONS) o[fn] = updated.includes(fn) ? rev : old;
  return o;
}
const base = (over: Partial<ReconcileInput>): ReconcileInput => ({ intended: INTENDED, observed: observedWith([]), lookupOk: true, ...over });

describe('partial Stage-C reconciliation — single-function partials', () => {
  for (const fn of STAGE_C_FUNCTIONS) {
    it(`only ${fn} updated (1/4) → hold closed, no reopen, forward-deploy the other 3`, () => {
      const r = reconcileStageC(base({ observed: observedWith([fn]) }));
      expect(r.complete).toBe(false);
      expect(r.reopenAllowed).toBe(false);
      expect(r.action).toBe('complete_forward_deploy');
      expect(r.matched).toEqual([fn]);
      expect(r.mismatched.sort()).toEqual(STAGE_C_FUNCTIONS.filter((f) => f !== fn).sort());
    });
  }
});

describe('partial Stage-C reconciliation — multi-function partials', () => {
  it('two updated → hold closed', () => {
    const r = reconcileStageC(base({ observed: observedWith(['processIncomingPull', 'processEditRequest']) }));
    expect(r.reopenAllowed).toBe(false);
    expect(r.matched).toHaveLength(2);
  });
  it('three updated → hold closed', () => {
    const r = reconcileStageC(base({ observed: observedWith(['processIncomingPull', 'processEditRequest', 'processDeleteRequest']) }));
    expect(r.reopenAllowed).toBe(false);
    expect(r.mismatched).toEqual(['watchdogStrandedPackets']);
  });
  it('all four updated → complete, reopen allowed', () => {
    const r = reconcileStageC(base({ observed: observedWith([...STAGE_C_FUNCTIONS]) }));
    expect(r.complete).toBe(true);
    expect(r.reopenAllowed).toBe(true);
    expect(r.action).toBe('reopen_ok');
  });
  it('a not-yet-deployed function (observed null) is "missing", not assumed present', () => {
    const observed = observedWith(['processIncomingPull', 'processEditRequest', 'processDeleteRequest']);
    observed.watchdogStrandedPackets = null;
    const r = reconcileStageC(base({ observed }));
    expect(r.missing).toEqual(['watchdogStrandedPackets']);
    expect(r.reopenAllowed).toBe(false);
  });
});

describe('partial Stage-C reconciliation — fail-closed on uncertainty', () => {
  it('revision lookup failed → hold closed even if a cached view looked complete', () => {
    const r = reconcileStageC(base({ observed: observedWith([...STAGE_C_FUNCTIONS]), lookupOk: false }));
    expect(r.reopenAllowed).toBe(false);
    expect(r.action).toBe('hold_closed');
  });
  it('a wrong revision (deployed but not the reviewed build) → mismatched, hold closed', () => {
    const observed = observedWith([...STAGE_C_FUNCTIONS]);
    observed.processDeleteRequest = 'rev-BADSHA';
    const r = reconcileStageC(base({ observed }));
    expect(r.mismatched).toEqual(['processDeleteRequest']);
    expect(r.reopenAllowed).toBe(false);
  });
  it('missing intended revision record → cannot confirm that fn (mismatched)', () => {
    const intended = { ...INTENDED } as Record<string, string>;
    delete (intended as Record<string, string>).watchdogStrandedPackets;
    const r = reconcileStageC({ intended, observed: observedWith([...STAGE_C_FUNCTIONS]), lookupOk: true });
    expect(r.reopenAllowed).toBe(false);
    expect(r.mismatched).toContain('watchdogStrandedPackets');
  });
});

describe('partial Stage-C reconciliation — CLI exit code is NOT trusted', () => {
  it('CLI exit 0 but revisions incomplete → still no reopen', () => {
    const r = reconcileStageC(base({ observed: observedWith(['processIncomingPull']), cliExitCode: 0 }));
    expect(r.reopenAllowed).toBe(false);
  });
  it('CLI exit nonzero but all four revisions actually match → reopen allowed (truth beats exit code)', () => {
    const r = reconcileStageC(base({ observed: observedWith([...STAGE_C_FUNCTIONS]), cliExitCode: 1 }));
    expect(r.reopenAllowed).toBe(true);
  });
});
