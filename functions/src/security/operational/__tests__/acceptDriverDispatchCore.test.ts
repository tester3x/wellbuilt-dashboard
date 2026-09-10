import {
  dispatchAssignedToCaller,
  evaluateAcceptDriverDispatch,
} from '../acceptDriverDispatchCore';

const UUID = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';
const OTHER = '99ff4b35-51ab-4d45-8d54-18b3b8515c9b';
const SHA = 'fd5e1e99da0d3518c7ba9463f9c1cfe81f629242ccbf19d72726d3e9c9a19ec5';
const caller = { driverId: UUID, companyId: 'liquid-gold' };

const fieldJob = {
  driverId: UUID,
  driverHash: UUID,
  companyId: 'liquid-gold',
  status: 'pending',
  loadsCompleted: 0,
};

describe('evaluateAcceptDriverDispatch', () => {
  it('accepts a pending field job for the assigned canonical driver', () => {
    const d = evaluateAcceptDriverDispatch({
      dispatchId: 'qVowFeli92bCALqsptcD',
      caller,
      existing: fieldJob,
    });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.result).toBe('accepted');
    expect(d.status).toBe('accepted');
    expect(d.incrementLoads).toBe(true);
    expect(d.loadsCompleted).toBe(1);
    expect(d.stampAcceptedAt).toBe(true);
  });

  it('retry of already accepted is idempotent and does not increment loads', () => {
    const d = evaluateAcceptDriverDispatch({
      dispatchId: 'qVowFeli92bCALqsptcD',
      caller,
      existing: { ...fieldJob, status: 'accepted', loadsCompleted: 1, acceptedAt: 'ts' },
    });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.result).toBe('already_accepted');
    expect(d.incrementLoads).toBe(false);
    expect(d.loadsCompleted).toBe(1);
    expect(d.stampAcceptedAt).toBe(false);
  });

  it('rejects another driver', () => {
    const d = evaluateAcceptDriverDispatch({
      dispatchId: 'x',
      caller: { driverId: OTHER, companyId: 'liquid-gold' },
      existing: fieldJob,
    });
    expect(d).toEqual({ ok: false, reason: 'other_driver' });
  });

  it('rejects another company', () => {
    const d = evaluateAcceptDriverDispatch({
      dispatchId: 'x',
      caller: { driverId: UUID, companyId: 'acme-eog-test' },
      existing: fieldJob,
    });
    expect(d).toEqual({ ok: false, reason: 'wrong_company' });
  });

  it('does not claim hash-only staff assignments without canonical driverId', () => {
    expect(dispatchAssignedToCaller({
      driverId: null,
      driverHash: SHA,
      companyId: 'liquid-gold',
      status: 'pending',
    }, caller)).toBe(false);
    const d = evaluateAcceptDriverDispatch({
      dispatchId: 'up0JRdssrSNRATwHkxnw',
      caller,
      existing: {
        driverId: null,
        driverHash: SHA,
        companyId: 'liquid-gold',
        status: 'pending',
      },
    });
    expect(d).toEqual({ ok: false, reason: 'other_driver' });
  });

  it('allows UUID-in-driverHash field jobs with null driverId', () => {
    const d = evaluateAcceptDriverDispatch({
      dispatchId: 'legacy-uuid-hash',
      caller,
      existing: {
        driverId: null,
        driverHash: UUID,
        companyId: 'liquid-gold',
        status: 'pending',
      },
    });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.stampDriverId).toBe(true);
  });

  it('paused resumes to in_progress', () => {
    const d = evaluateAcceptDriverDispatch({
      dispatchId: 'p',
      caller,
      existing: { ...fieldJob, status: 'paused', loadsCompleted: 1, acceptedAt: 'ts' },
      targetStatus: 'accepted',
    });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.status).toBe('in_progress');
    expect(d.stampStartedAt).toBe(true);
  });

  it('pending can start in_progress directly', () => {
    const d = evaluateAcceptDriverDispatch({
      dispatchId: 'p',
      caller,
      existing: fieldJob,
      targetStatus: 'in_progress',
    });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.status).toBe('in_progress');
    expect(d.stampStartedAt).toBe(true);
    expect(d.incrementLoads).toBe(true);
  });

  it('completed cannot be accepted', () => {
    const d = evaluateAcceptDriverDispatch({
      dispatchId: 'c',
      caller,
      existing: { ...fieldJob, status: 'completed' },
    });
    expect(d).toEqual({ ok: false, reason: 'invalid_status' });
  });

  it('missing dispatch is not_found', () => {
    expect(evaluateAcceptDriverDispatch({
      dispatchId: 'missing',
      caller,
      existing: null,
    })).toEqual({ ok: false, reason: 'not_found' });
  });

  it('invoice association is idempotent for the same invoice', () => {
    const d = evaluateAcceptDriverDispatch({
      dispatchId: 'q',
      caller,
      existing: { ...fieldJob, status: 'accepted', loadsCompleted: 1, acceptedAt: 'ts', invoiceDocId: 'inv1' },
      invoiceDocId: 'inv1',
    });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.invoiceDocId).toBe('inv1');
    expect(d.result).toBe('already_accepted');
  });

  it('conflicting invoice is rejected', () => {
    const d = evaluateAcceptDriverDispatch({
      dispatchId: 'q',
      caller,
      existing: { ...fieldJob, status: 'accepted', invoiceDocId: 'inv1' },
      invoiceDocId: 'inv2',
    });
    expect(d).toEqual({ ok: false, reason: 'invoice_conflict' });
  });

  it('unauthenticated caller rejected', () => {
    expect(evaluateAcceptDriverDispatch({
      dispatchId: 'q',
      caller: null,
      existing: fieldJob,
    })).toEqual({ ok: false, reason: 'unauthenticated_driver' });
  });
});
