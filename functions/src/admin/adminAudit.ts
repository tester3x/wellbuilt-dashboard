/**
 * platform_admin_audit — bounded server-owned audit records (vc51.9A6-B).
 *
 * Every protected admin mutation writes one record INSIDE its
 * transaction, so a mutation without its audit trail cannot commit.
 *
 * Included: operation, targetType/targetId, verified actor (uid + email
 * from the verified token — never from the request body), server
 * timestamp, contract/admin-policy versions, bounded reason where the
 * operation requires one, and a changed-FIELD-NAME summary.
 *
 * Excluded by construction (the record is built from an allowlist, not
 * from the request): ID tokens, passwords, credentials, full request
 * payloads, arbitrary diagnostics, PII beyond the admin's own account
 * email. Direct client read/write of the collection is rules-denied;
 * reads go through the bounded listAdminAudit callable only.
 */

import { ADMIN_POLICY_VERSION } from './authority';
import { CONTRACT_VERSION } from '@tester3x/wellbuilt-contracts';

export const ADMIN_AUDIT_COLLECTION = 'platform_admin_audit';
export const AUDIT_REASON_MAX = 300;
export const AUDIT_CHANGED_FIELDS_MAX = 30;

export interface AdminAuditInput {
  operation: string;
  targetType: 'plan' | 'company';
  targetId: string;
  actorUid: string;
  actorEmail: string | null;
  reason?: string;
  changedFields?: string[];
}

export function buildAuditRecord(
  input: AdminAuditInput,
  serverTimestamp: unknown,
): Record<string, unknown> {
  const changed = (input.changedFields ?? []).slice(0, AUDIT_CHANGED_FIELDS_MAX);
  return {
    operation: input.operation,
    targetType: input.targetType,
    targetId: input.targetId,
    actorUid: input.actorUid,
    actorEmail: input.actorEmail,
    at: serverTimestamp,
    contractVersion: CONTRACT_VERSION,
    adminPolicyVersion: ADMIN_POLICY_VERSION,
    ...(input.reason !== undefined ? { reason: input.reason.slice(0, AUDIT_REASON_MAX) } : {}),
    ...(changed.length ? { changedFields: changed } : {}),
  };
}
