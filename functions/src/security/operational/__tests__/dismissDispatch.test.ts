import { readFileSync } from 'fs';
import { join } from 'path';
import { evaluateDismissDispatch } from '../dismissDispatch';

const declined = {
  id: 'bwr0XquQqxnnVsYYv94n',
  status: 'cancelled',
  companyId: 'liquid-gold',
  declinedAt: 1,
  declinedBy: 'MikeS24',
  declineReason: 'No reason given',
};

describe('evaluateDismissDispatch', () => {
  it('dismisses a declined/cancelled job and does not list decline fields in the decision', () => {
    const r = evaluateDismissDispatch({
      job: { ...declined, status: 'declined' },
      siblings: [],
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.idempotent).toBe(false);
    expect(r.dispatchIds).toEqual(['bwr0XquQqxnnVsYYv94n']);
    expect(r.preserveDecline).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/declinedAt|declineReason|declinedBy/);
  });

  it('cancelled (Dashboard declined strip) is dismissable', () => {
    const r = evaluateDismissDispatch({
      job: declined,
      siblings: [],
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
    });
    expect(r.ok).toBe(true);
  });

  it('already dismissed is idempotent', () => {
    const r = evaluateDismissDispatch({
      job: { ...declined, status: 'dismissed', dismissedAt: 9, dismissedBy: 'staff' },
      siblings: [],
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
    });
    expect(r).toMatchObject({ ok: true, idempotent: true, dispatchIds: [declined.id] });
  });

  it('refuses accepted / in_progress / paused', () => {
    for (const status of ['accepted', 'in_progress', 'paused']) {
      const r = evaluateDismissDispatch({
        job: { ...declined, status },
        siblings: [],
        callerCompanyId: 'liquid-gold',
        isPlatformAdmin: false,
      });
      expect(r).toEqual({ ok: false, reason: 'job_in_progress' });
    }
  });

  it('refuses pending (not this bug; use cancel path)', () => {
    const r = evaluateDismissDispatch({
      job: { ...declined, status: 'pending' },
      siblings: [],
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
    });
    expect(r).toEqual({ ok: false, reason: 'not_dismissable' });
  });

  it('blocks whole family when a sibling is started', () => {
    const r = evaluateDismissDispatch({
      job: { ...declined, id: 'A', status: 'declined', splitGroupId: 'split_1' },
      siblings: [
        { id: 'B', status: 'accepted', companyId: 'liquid-gold', splitGroupId: 'split_1' },
      ],
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
    });
    expect(r).toEqual({ ok: false, reason: 'family_in_progress' });
  });

  it('pre-start family dismisses declined + pending siblings together', () => {
    const r = evaluateDismissDispatch({
      job: { ...declined, id: 'A', status: 'declined', splitGroupId: 'split_1' },
      siblings: [
        { id: 'B', status: 'pending', companyId: 'liquid-gold', splitGroupId: 'split_1' },
      ],
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dispatchIds.sort()).toEqual(['A', 'B']);
  });

  it('Dashboard declined Dismiss uses the callable and Removed tab reads dismissed', () => {
    const src = readFileSync(
      join(__dirname, '../../../../../src/app/dispatch/page.tsx'),
      'utf8',
    );
    expect(src).toContain("from '@/lib/dismissDispatch'");
    expect(src).toContain('onDismissDeclined');
    expect(src).toContain('job.id && onDismissDeclined?.(job.id)');
    expect(src).toContain("rightPanelTab === 'removed'");
    expect(src).toContain("d.status === 'dismissed'");
    expect(src).toContain("status !== 'dismissed'");
  });

  it('staff cannot dismiss another company', () => {
    const r = evaluateDismissDispatch({
      job: declined,
      siblings: [],
      callerCompanyId: 'acme-eog-test',
      isPlatformAdmin: false,
    });
    expect(r).toEqual({ ok: false, reason: 'cross_company' });
  });
});
