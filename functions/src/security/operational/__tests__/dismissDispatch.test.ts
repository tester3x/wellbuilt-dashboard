import { evaluateDismissDispatch } from '../dismissDispatch';

describe('evaluateDismissDispatch', () => {
  const job = {
    id: 'bwr0XquQqxnnVsYYv94n',
    status: 'cancelled',
    companyId: 'liquid-gold',
  };

  it('dismisses declined and cancelled, blocks started, is idempotent', () => {
    expect(evaluateDismissDispatch({
      job: { ...job, status: 'declined' },
      siblings: [],
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
    }).ok).toBe(true);
    expect(evaluateDismissDispatch({
      job,
      siblings: [],
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
    }).ok).toBe(true);
    expect(evaluateDismissDispatch({
      job: { ...job, status: 'accepted' },
      siblings: [],
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
    })).toEqual({ ok: false, reason: 'job_in_progress' });
    expect(evaluateDismissDispatch({
      job: { ...job, status: 'dismissed' },
      siblings: [],
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
    })).toMatchObject({ ok: true, idempotent: true });
  });

  it('blocks a split family with an in-progress sibling', () => {
    expect(evaluateDismissDispatch({
      job: { ...job, id: 'A', status: 'declined', splitGroupId: 's1' },
      siblings: [{ id: 'B', status: 'in_progress', companyId: 'liquid-gold', splitGroupId: 's1' }],
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
    })).toEqual({ ok: false, reason: 'family_in_progress' });
  });
});
