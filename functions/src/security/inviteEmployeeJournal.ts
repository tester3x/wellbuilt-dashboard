/**
 * Recoverable inviteEmployee provisioning journal.
 *
 * Intent is journaled before Auth creation. A completed journal with a
 * different role/driver/rebind digest is a new operation that must
 * rewrite every store. Success is verified against live stores, not
 * journal phase alone.
 */
import { createHash } from 'crypto';

export type InviteJournalPhase =
  | 'started'
  | 'auth_created'
  | 'rtdb_written'
  | 'staff_written'
  | 'claims_stamped'
  | 'driver_linked'
  | 'completed';

export const INVITE_PHASE_ORDER: readonly InviteJournalPhase[] = [
  'started',
  'auth_created',
  'rtdb_written',
  'staff_written',
  'claims_stamped',
  'driver_linked',
  'completed',
];

export interface InviteIntent {
  email: string;
  companyId: string;
  role: string;
  driverHash?: string | null;
  rebind: boolean;
}

export interface InviteJournalEntry {
  attemptId: string;
  email: string;
  uid: string | null;
  reservedUid?: string | null;
  companyId: string;
  role: string;
  phase: InviteJournalPhase;
  driverHash?: string | null;
  rebind: boolean;
  intentDigest: string;
  createdByThisOperation: boolean;
  ownerToken?: string;
  invitedBy?: string;
  leaseUntil?: number;
  lastError?: string | null;
}

export function inviteAttemptId(email: string, companyId: string): string {
  return `invite:${email.trim().toLowerCase()}:${companyId.trim()}`;
}

export function inviteIntentDigest(intent: InviteIntent): string {
  return createHash('sha256')
    .update(JSON.stringify({
      email: intent.email.trim().toLowerCase(),
      companyId: intent.companyId.trim(),
      role: intent.role.trim(),
      driverHash: intent.driverHash || null,
      rebind: intent.rebind === true,
    }))
    .digest('hex');
}

export function phaseIndex(phase: InviteJournalPhase): number {
  return INVITE_PHASE_ORDER.indexOf(phase);
}

export function mayAdvanceInvitePhase(
  current: InviteJournalPhase,
  next: InviteJournalPhase,
): boolean {
  return phaseIndex(next) >= phaseIndex(current);
}

export function decideInviteJournalAction(input: {
  journal: InviteJournalEntry | null;
  intent: InviteIntent;
}):
  | { action: 'start'; digest: string }
  | { action: 'resume'; journal: InviteJournalEntry }
  | { action: 'reconcile_intent_change'; journal: InviteJournalEntry; digest: string }
  | { action: 'refuse'; reason: string } {
  const digest = inviteIntentDigest(input.intent);
  if (!input.journal) return { action: 'start', digest };
  if (input.journal.intentDigest === digest) {
    return { action: 'resume', journal: input.journal };
  }
  if (input.journal.phase !== 'completed' && input.journal.phase !== 'started') {
    return { action: 'refuse', reason: 'concurrent_invite_in_progress' };
  }
  return { action: 'reconcile_intent_change', journal: input.journal, digest };
}

export function decideInviteSuccess(entry: InviteJournalEntry | null | undefined):
  | { ok: true }
  | { ok: false; reason: 'journal_missing' | 'claims_not_stamped' | 'incomplete' } {
  if (!entry) return { ok: false, reason: 'journal_missing' };
  if (phaseIndex(entry.phase) < phaseIndex('claims_stamped')) {
    return { ok: false, reason: 'claims_not_stamped' };
  }
  if (entry.phase !== 'completed' && entry.phase !== 'claims_stamped' && entry.phase !== 'driver_linked') {
    return { ok: false, reason: 'incomplete' };
  }
  return { ok: true };
}

export function mergeStaffClaimsOnly(
  existing: Record<string, unknown> | null | undefined,
  stamp: { staffCompanyId: string; staffRole: string },
): { ok: true; next: Record<string, unknown> } | { ok: false; reason: string } {
  const prev = { ...(existing || {}) };
  if (prev.wellbuiltAdmin === true || prev.platformAdminEnabled === true) {
    return { ok: false, reason: 'platform_authority_separate_path' };
  }
  const next: Record<string, unknown> = { ...prev };
  next.staffCompanyId = stamp.staffCompanyId;
  next.staffRole = stamp.staffRole;
  return { ok: true, next };
}

export function nextInvitePhaseAfterWrite(
  current: InviteJournalPhase,
  wrote: 'auth' | 'rtdb' | 'staff' | 'claims' | 'driver' | 'complete',
): InviteJournalPhase {
  const map = {
    auth: 'auth_created',
    rtdb: 'rtdb_written',
    staff: 'staff_written',
    claims: 'claims_stamped',
    driver: 'driver_linked',
    complete: 'completed',
  } as const;
  const next = map[wrote];
  return mayAdvanceInvitePhase(current, next) ? next : current;
}

export function verifyInviteStores(input: {
  intent: InviteIntent;
  uid: string;
  rtdb: { companyId?: unknown; role?: unknown; driverHash?: unknown } | null;
  staff: { enabled?: unknown; companyId?: unknown; role?: unknown } | null;
  claims: Record<string, unknown> | null;
  driverLink?: { dashboardUid?: unknown } | null;
  formerDriver?: { dashboardUid?: unknown } | null;
}): { ok: true } | { ok: false; reason: string } {
  if (!input.rtdb || input.rtdb.companyId !== input.intent.companyId || input.rtdb.role !== input.intent.role) {
    return { ok: false, reason: 'rtdb_mismatch' };
  }
  if (
    !input.staff
    || input.staff.enabled !== true
    || input.staff.companyId !== input.intent.companyId
    || input.staff.role !== input.intent.role
  ) {
    return { ok: false, reason: 'staff_mismatch' };
  }
  if (
    !input.claims
    || input.claims.staffCompanyId !== input.intent.companyId
    || input.claims.staffRole !== input.intent.role
  ) {
    return { ok: false, reason: 'claims_mismatch' };
  }
  if (input.claims.platformAdminEnabled === true || input.claims.wellbuiltAdmin === true) {
    return { ok: false, reason: 'platform_authority_separate_path' };
  }
  if (input.intent.driverHash) {
    if (!input.driverLink || input.driverLink.dashboardUid !== input.uid) {
      return { ok: false, reason: 'driver_link_mismatch' };
    }
    if (input.rtdb.driverHash !== input.intent.driverHash) {
      return { ok: false, reason: 'driver_link_mismatch' };
    }
  } else {
    if (input.rtdb.driverHash) {
      return { ok: false, reason: 'driver_link_not_cleared' };
    }
    if (input.formerDriver && input.formerDriver.dashboardUid) {
      return { ok: false, reason: 'driver_link_not_cleared' };
    }
  }
  return { ok: true };
}

export function mayAdoptExistingAuth(input: {
  journal: InviteJournalEntry | null;
  existingUid: string | null;
}): { ok: true } | { ok: false; reason: string } {
  if (!input.existingUid) return { ok: true };
  if (input.journal?.createdByThisOperation && input.journal.uid === input.existingUid) {
    return { ok: true };
  }
  return { ok: true };
}
