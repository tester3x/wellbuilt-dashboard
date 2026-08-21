import { evaluateStaffWriteDispatch } from '../staffWriteDispatch';

describe('evaluateStaffWriteDispatch', () => {
  const job = { id: 'j1', status: 'pending', companyId: 'liquid-gold', wellName: 'Gab 1' };

  it('creates for company staff stamped to their company', () => {
    expect(evaluateStaffWriteDispatch({
      op: 'create',
      job: null,
      record: { wellName: 'Gab 1', driverHash: 'abc' },
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
    })).toEqual({ ok: true, op: 'create', companyId: 'liquid-gold' });
  });

  it('rejects cross-company create', () => {
    expect(evaluateStaffWriteDispatch({
      op: 'create',
      job: null,
      record: { wellName: 'Gab 1', companyId: 'acme-hauling' },
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
    })).toEqual({ ok: false, reason: 'cross_company' });
  });

  it('rejects dismissed status — that path is dismissDispatch', () => {
    expect(evaluateStaffWriteDispatch({
      op: 'create',
      job: null,
      record: { wellName: 'Gab 1', status: 'dismissed' },
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
    })).toEqual({ ok: false, reason: 'use_dismiss_callable' });
  });

  it('cancels same-company jobs and blocks other tenants', () => {
    expect(evaluateStaffWriteDispatch({
      op: 'cancel',
      job,
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
    }).ok).toBe(true);
    expect(evaluateStaffWriteDispatch({
      op: 'cancel',
      job,
      callerCompanyId: 'acme-hauling',
      isPlatformAdmin: false,
    })).toEqual({ ok: false, reason: 'cross_company' });
  });

  it('platform admin may cancel another company job', () => {
    expect(evaluateStaffWriteDispatch({
      op: 'cancel',
      job: { ...job, companyId: 'acme-hauling' },
      isPlatformAdmin: true,
    }).ok).toBe(true);
  });
});
