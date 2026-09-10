/**
 * Recurrence prevention — the replacement-approval legacy→canonical binding gate.
 *
 * Synthetic identities only. Proves the approval binds a legacy approved key to
 * the fresh canonical UUID ONLY when the key is well-formed, its approved row
 * exists, and it belongs to the SAME company — never by display name.
 */
import { decideLegacyBinding } from '../legacyBindingDecision';

const KEY = 'a'.repeat(64); // well-formed sha256-shaped approved key
const rowFor = (companyId: unknown) => ({ companyId, displayName: 'SyntheticDriver' });

describe('decideLegacyBinding', () => {
  it('no key supplied → skip (ordinary approval, no binding)', () => {
    expect(decideLegacyBinding({ legacyApprovedKey: '', approvalCompanyId: 'acme', legacyRow: null }))
      .toEqual({ action: 'skip' });
    expect(decideLegacyBinding({ legacyApprovedKey: '   ', approvalCompanyId: 'acme', legacyRow: rowFor('acme') }))
      .toEqual({ action: 'skip' });
  });

  it('malformed key → refuse(malformed), never reaches the store', () => {
    expect(decideLegacyBinding({ legacyApprovedKey: 'short', approvalCompanyId: 'acme', legacyRow: null }))
      .toEqual({ action: 'refuse', code: 'malformed' });
    expect(decideLegacyBinding({ legacyApprovedKey: 'has spaces!!', approvalCompanyId: 'acme', legacyRow: null }))
      .toEqual({ action: 'refuse', code: 'malformed' });
  });

  it('well-formed key but no approved row → refuse(missing_row)', () => {
    expect(decideLegacyBinding({ legacyApprovedKey: KEY, approvalCompanyId: 'acme', legacyRow: null }))
      .toEqual({ action: 'refuse', code: 'missing_row' });
  });

  it('company isolation: a key from another company → refuse(company_mismatch)', () => {
    expect(decideLegacyBinding({ legacyApprovedKey: KEY, approvalCompanyId: 'acme', legacyRow: rowFor('other-co') }))
      .toEqual({ action: 'refuse', code: 'company_mismatch' });
  });

  it('same company → bind', () => {
    expect(decideLegacyBinding({ legacyApprovedKey: KEY, approvalCompanyId: 'acme', legacyRow: rowFor('acme') }))
      .toEqual({ action: 'bind' });
    // case/whitespace-insensitive company comparison
    expect(decideLegacyBinding({ legacyApprovedKey: KEY, approvalCompanyId: 'acme', legacyRow: rowFor(' ACME ') }))
      .toEqual({ action: 'bind' });
  });

  it('platform-admin approval with no company scope binds when the row has a company', () => {
    // approvalCompanyId null (platform admin, company from pending) → not blocked by isolation.
    expect(decideLegacyBinding({ legacyApprovedKey: KEY, approvalCompanyId: null, legacyRow: rowFor('acme') }))
      .toEqual({ action: 'bind' });
  });

  it('never infers identity from display name — name is irrelevant to the decision', () => {
    const a = decideLegacyBinding({ legacyApprovedKey: KEY, approvalCompanyId: 'acme', legacyRow: { companyId: 'acme', displayName: 'Alice' } });
    const b = decideLegacyBinding({ legacyApprovedKey: KEY, approvalCompanyId: 'acme', legacyRow: { companyId: 'acme', displayName: 'Bob' } });
    expect(a).toEqual(b);
    expect(a).toEqual({ action: 'bind' });
  });
});
