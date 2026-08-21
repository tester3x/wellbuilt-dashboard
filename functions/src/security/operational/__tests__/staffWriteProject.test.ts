import { evaluateStaffWriteProject } from '../staffWriteProject';

describe('evaluateStaffWriteProject', () => {
  it('creates for company staff and rejects cross-company', () => {
    expect(evaluateStaffWriteProject({
      op: 'create',
      existing: null,
      record: { name: 'Test Pad', status: 'active' },
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
    })).toEqual({ ok: true, op: 'create', companyId: 'liquid-gold' });
    expect(evaluateStaffWriteProject({
      op: 'create',
      existing: null,
      record: { name: 'Test Pad', companyId: 'acme-hauling' },
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
    })).toEqual({ ok: false, reason: 'cross_company' });
  });

  it('rejects invalid status', () => {
    expect(evaluateStaffWriteProject({
      op: 'create',
      existing: null,
      record: { name: 'X', status: 'archived' },
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
    })).toEqual({ ok: false, reason: 'invalid_status' });
  });
});
