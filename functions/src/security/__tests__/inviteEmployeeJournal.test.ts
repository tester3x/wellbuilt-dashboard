import {
  decideInviteJournalAction,
  decideInviteSuccess,
  inviteIntentDigest,
  mergeStaffClaimsOnly,
  nextInvitePhaseAfterWrite,
  verifyInviteStores,
  type InviteJournalEntry,
} from '../inviteEmployeeJournal';

function entry(over: Partial<InviteJournalEntry> = {}): InviteJournalEntry {
  const intent = {
    email: 'a@x.com',
    companyId: 'company-a',
    role: 'viewer',
    driverHash: null,
    rebind: false,
  };
  return {
    attemptId: 'invite:a@x.com:company-a',
    email: 'a@x.com',
    uid: 'uid-1',
    companyId: 'company-a',
    role: 'viewer',
    phase: 'started',
    rebind: false,
    intentDigest: inviteIntentDigest(intent),
    createdByThisOperation: false,
    ...over,
  };
}

describe('inviteEmployee journal', () => {
  it('never reports success before claims are stamped', () => {
    expect(decideInviteSuccess(null).ok).toBe(false);
    expect(decideInviteSuccess(entry({ phase: 'started' }))).toMatchObject({
      ok: false,
      reason: 'claims_not_stamped',
    });
    expect(decideInviteSuccess(entry({ phase: 'claims_stamped' })).ok).toBe(true);
  });

  it('retries after each crash boundary by advancing from the stored phase', () => {
    expect(nextInvitePhaseAfterWrite('started', 'auth')).toBe('auth_created');
    expect(nextInvitePhaseAfterWrite('auth_created', 'rtdb')).toBe('rtdb_written');
    expect(nextInvitePhaseAfterWrite('rtdb_written', 'staff')).toBe('staff_written');
    expect(nextInvitePhaseAfterWrite('staff_written', 'claims')).toBe('claims_stamped');
    expect(nextInvitePhaseAfterWrite('claims_stamped', 'complete')).toBe('completed');
  });

  it('role change after completed is a new reconcile, not a silent skip', () => {
    const completed = entry({ phase: 'completed', role: 'viewer' });
    const action = decideInviteJournalAction({
      journal: completed,
      intent: { email: 'a@x.com', companyId: 'company-a', role: 'manager', rebind: false },
    });
    expect(action.action).toBe('reconcile_intent_change');
  });

  it('does not alter platform authority through invite claims', () => {
    expect(mergeStaffClaimsOnly(
      { wellbuiltAdmin: true, platformAdminEnabled: true },
      { staffCompanyId: 'company-a', staffRole: 'viewer' },
    )).toMatchObject({ ok: false, reason: 'platform_authority_separate_path' });
  });

  it('success requires live RTDB/staff/claims to match intent', () => {
    const intent = { email: 'a@x.com', companyId: 'company-a', role: 'viewer', rebind: false };
    expect(verifyInviteStores({
      intent,
      uid: 'uid-1',
      rtdb: { companyId: 'company-a', role: 'viewer' },
      staff: { enabled: true, companyId: 'company-a', role: 'viewer' },
      claims: { staffCompanyId: 'company-a', staffRole: 'viewer' },
    }).ok).toBe(true);
    expect(verifyInviteStores({
      intent,
      uid: 'uid-1',
      rtdb: { companyId: 'company-a', role: 'manager' },
      staff: { enabled: true, companyId: 'company-a', role: 'viewer' },
      claims: { staffCompanyId: 'company-a', staffRole: 'viewer' },
    }).ok).toBe(false);
  });
});
