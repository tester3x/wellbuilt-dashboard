import {
  decideCreateSecureLoginLink,
  evaluateApprovedRowForCreate,
} from '../legacySecureLink';

const APPROVED_KEY = 'fd5e1e99da0dabcdef0123456789abcd';

describe('create-secure-login cannot mint an unlinked duplicate', () => {
  it('refuses create with no driverId, approvedKey, or legacyHash', () => {
    expect(decideCreateSecureLoginLink({
      displayName: 'Mikezfold',
    } as never)).toEqual({ action: 'refuse', reason: 'legacy_link_required' });
    expect(decideCreateSecureLoginLink({})).toEqual({ action: 'refuse', reason: 'legacy_link_required' });
  });

  it('treats an existing driverId as reset, not a new identity', () => {
    expect(decideCreateSecureLoginLink({
      driverId: '2cad521c-13ac-4b6c-b1ab-07843c6bf06f',
    })).toEqual({ action: 'reset' });
  });

  it('requires the exact approved row key — never a display name', () => {
    expect(decideCreateSecureLoginLink({ approvedKey: 'Mikezfold' }))
      .toEqual({ action: 'refuse', reason: 'approved_key_malformed' });
    expect(decideCreateSecureLoginLink({ approvedKey: APPROVED_KEY }))
      .toEqual({ action: 'create_from_approved', approvedKey: APPROVED_KEY });
  });

  it('refuses sending both approvedKey and legacyHash', () => {
    expect(decideCreateSecureLoginLink({
      approvedKey: APPROVED_KEY,
      legacyHash: APPROVED_KEY,
    })).toEqual({ action: 'refuse', reason: 'ambiguous_link_selector' });
  });

  it('refuses a missing, name-mismatched, or already-linked row', () => {
    expect(evaluateApprovedRowForCreate({
      requestDisplayName: 'Mikezfold',
      row: null,
    })).toEqual({ ok: false, reason: 'approved_row_missing' });

    expect(evaluateApprovedRowForCreate({
      requestDisplayName: 'Mikezfold',
      row: { displayName: 'Michael S24 Burger' },
    })).toEqual({ ok: false, reason: 'approved_row_name_mismatch' });

    expect(evaluateApprovedRowForCreate({
      requestDisplayName: 'Mikezfold',
      row: {
        displayName: 'Mikezfold',
        migratedToDriverId: '2cad521c-13ac-4b6c-b1ab-07843c6bf06f',
      },
    })).toEqual({ ok: false, reason: 'approved_row_already_linked' });
  });

  it('does not treat two similarly named rows as the same identity', () => {
    const zfold = evaluateApprovedRowForCreate({
      requestDisplayName: 'Mikezfold',
      row: { displayName: 'Mikezfold' },
    });
    const s24 = evaluateApprovedRowForCreate({
      requestDisplayName: 'Mikezfold',
      row: { displayName: 'Michael S24 Burger' },
    });
    expect(zfold).toEqual({ ok: true });
    expect(s24).toEqual({ ok: false, reason: 'approved_row_name_mismatch' });
  });
});
