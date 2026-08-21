import { readFileSync } from 'fs';
import { join } from 'path';
import { dispatchCardConfirmCopy, resolveDispatchCardAction } from '../dispatchCardAction';

describe('resolveDispatchCardAction', () => {
  it('routes every status in the action table', () => {
    expect(resolveDispatchCardAction('pending')).toEqual({ kind: 'cancel', label: 'Cancel dispatch', confirmVerb: 'cancel' });
    expect(resolveDispatchCardAction('pending_approval')).toEqual({ kind: 'cancel', label: 'Cancel dispatch', confirmVerb: 'cancel' });
    expect(resolveDispatchCardAction('accepted')).toEqual({ kind: 'cancel', label: 'Cancel dispatch', confirmVerb: 'cancel' });
    expect(resolveDispatchCardAction('in_progress')).toEqual({ kind: 'cancel', label: 'Cancel dispatch', confirmVerb: 'cancel' });
    expect(resolveDispatchCardAction('paused')).toEqual({ kind: 'cancel', label: 'Cancel dispatch', confirmVerb: 'cancel' });
    expect(resolveDispatchCardAction('declined')).toEqual({ kind: 'dismiss', label: 'Dismiss dispatch', confirmVerb: 'dismiss' });
    expect(resolveDispatchCardAction('cancelled')).toEqual({ kind: 'dismiss', label: 'Dismiss dispatch', confirmVerb: 'dismiss' });
    expect(resolveDispatchCardAction('completed')).toEqual({ kind: 'none' });
    expect(resolveDispatchCardAction('dismissed')).toEqual({ kind: 'none' });
    expect(resolveDispatchCardAction('mystery')).toEqual({
      kind: 'error', reason: 'unknown_status:mystery', label: 'Unknown status',
    });
    expect(resolveDispatchCardAction('')).toEqual({ kind: 'none' });
    expect(resolveDispatchCardAction(undefined)).toEqual({ kind: 'none' });
  });

  it('pending/active never dismiss and declined/cancelled never cancel', () => {
    for (const st of ['pending', 'pending_approval', 'accepted', 'in_progress', 'paused']) {
      expect(resolveDispatchCardAction(st).kind).toBe('cancel');
    }
    for (const st of ['declined', 'cancelled']) {
      expect(resolveDispatchCardAction(st).kind).toBe('dismiss');
    }
  });

  it('confirmation names well, driver, status, and resulting action', () => {
    const cancel = dispatchCardConfirmCopy({
      well: 'Gab 1', driver: 'Michael S24 Burger', status: 'pending',
      action: { kind: 'cancel', label: 'Cancel dispatch', confirmVerb: 'cancel' },
    });
    expect(cancel).toContain('Cancel dispatch');
    expect(cancel).toContain('Well: Gab 1');
    expect(cancel).toContain('Driver: Michael S24 Burger');
    expect(cancel).toContain('Current status: pending');
    expect(cancel).toContain('status → cancelled');
    const dismiss = dispatchCardConfirmCopy({
      well: 'Gab 1', driver: 'Mikezfold', status: 'cancelled',
      action: { kind: 'dismiss', label: 'Dismiss dispatch', confirmVerb: 'dismiss' },
    });
    expect(dismiss).toContain('Dismiss dispatch');
    expect(dismiss).toContain('status → dismissed');
  });

  it('Dashboard card X consumes the shared router and does not always dismiss', () => {
    const page = readFileSync(join(__dirname, '../../../../../src/app/dispatch/page.tsx'), 'utf8');
    const lib = readFileSync(join(__dirname, '../../../../../src/lib/dispatchCardAction.ts'), 'utf8');
    expect(page).toContain('resolveDispatchCardAction');
    expect(page).toMatch(/if \(cardAction\.kind === 'cancel'\)/);
    expect(page).toMatch(/if \(cardAction\.kind === 'dismiss'\)/);
    expect(page).toContain('staffCancelDispatch');
    expect(page).toContain('Cancel failed');
    expect(page).toContain('Dismiss failed');
    expect(page).toContain('Cancelled (');
    expect(page).toContain('Declined (');
    expect(page).not.toMatch(/DECLINED \(n\)/);
    expect(page).not.toMatch(/always calls onDismiss/);
    expect(lib).toContain("label: 'Cancel dispatch'");
    expect(lib).toContain("label: 'Dismiss dispatch'");
  });
});
