/**
 * Pure decision for the optional legacy→canonical binding carried by a
 * replacement approval (adminApproveDriverRegistration). Kept separate so the
 * gate (format, existence, company isolation) is unit-testable without invoking
 * the full approval callable. Identity is NEVER inferred by display name.
 */
import { APPROVED_KEY_RE } from './identityBinding';

export type LegacyBindingDecision =
  | { action: 'skip' }
  | { action: 'refuse'; code: 'malformed' | 'missing_row' | 'company_mismatch' }
  | { action: 'bind' };

/**
 * @param legacyApprovedKey  the exact prior legacy approved key (or empty).
 * @param approvalCompanyId  the company this approval binds to (lowercased), or null.
 * @param legacyRow          the drivers/approved row for the key, or null if absent.
 */
export function decideLegacyBinding(input: {
  legacyApprovedKey: string;
  approvalCompanyId: string | null;
  legacyRow: Record<string, unknown> | null;
}): LegacyBindingDecision {
  const key = (input.legacyApprovedKey || '').trim();
  if (!key) return { action: 'skip' };
  if (!APPROVED_KEY_RE.test(key)) return { action: 'refuse', code: 'malformed' };
  if (!input.legacyRow) return { action: 'refuse', code: 'missing_row' };
  const legacyCompany = String(input.legacyRow.companyId || '').trim().toLowerCase();
  // Company isolation: never bind a key that belongs to a different company.
  if (input.approvalCompanyId && legacyCompany && legacyCompany !== input.approvalCompanyId) {
    return { action: 'refuse', code: 'company_mismatch' };
  }
  return { action: 'bind' };
}
