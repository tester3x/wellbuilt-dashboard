/**
 * Company Spill Notification Policy — Dashboard writer for
 * companies/{companyId}.spillReporting.notifyPolicy
 * Mirrors WB-T spillNotifyCore recipient kinds. No hardcoded people or titles.
 */

export type SpillNotifyChannel = 'sms' | 'email';
export type SpillNotifyChannelPref = 'sms' | 'email' | 'both';

/** Recipient roles. Includes Dashboard responsibilities plus notify-only `lead`. */
export const SPILL_RECIPIENT_ROLES = [
  'dispatch',
  'safety',
  'lead',
  'manager',
  'admin',
  'it',
] as const;
export type SpillRecipientRoleName = (typeof SPILL_RECIPIENT_ROLES)[number];

export interface SpillRecipientRole {
  kind: 'role';
  role: string;
  channels: SpillNotifyChannelPref;
  active?: boolean;
}
export interface SpillRecipientEmployee {
  kind: 'employee';
  employeeId: string;
  channels: SpillNotifyChannelPref;
  active?: boolean;
}
export interface SpillRecipientExternal {
  kind: 'external';
  externalId: string;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  channels: SpillNotifyChannelPref;
  active?: boolean;
}
export type SpillRecipient = SpillRecipientRole | SpillRecipientEmployee | SpillRecipientExternal;

export interface SpillNotificationPolicy {
  enabled: boolean;
  recipients: SpillRecipient[];
  externalAccessEnabled?: boolean | null;
  /** Hours until an external link expires. Required when external access is on. */
  externalAccessExpiresHours?: number | null;
  version: number;
  updatedAtIso?: string | null;
  updatedByUid?: string | null;
}

export interface PolicyValidation {
  ok: boolean;
  errors: string[];
}

export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/[^0-9]/g, '');
  if (!digits) return null;
  if (hasPlus) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
}

export function validateEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const e = String(raw).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  if (e.length > 254) return null;
  return e;
}

export function emptySpillPolicy(): SpillNotificationPolicy {
  return { enabled: false, recipients: [], externalAccessEnabled: false, version: 0 };
}

export function parseSpillPolicy(raw: unknown): SpillNotificationPolicy {
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  if (!r) return emptySpillPolicy();
  const recipients = Array.isArray(r.recipients) ? r.recipients.map(parseRecipient).filter((x): x is SpillRecipient => !!x) : [];
  return {
    enabled: r.enabled === true,
    recipients,
    externalAccessEnabled: r.externalAccessEnabled === true,
    externalAccessExpiresHours: typeof r.externalAccessExpiresHours === 'number' ? r.externalAccessExpiresHours : null,
    version: typeof r.version === 'number' && r.version >= 0 ? Math.floor(r.version) : 0,
    updatedAtIso: typeof r.updatedAtIso === 'string' ? r.updatedAtIso : null,
    updatedByUid: typeof r.updatedByUid === 'string' ? r.updatedByUid : null,
  };
}

function parseRecipient(raw: unknown): SpillRecipient | null {
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  if (!r) return null;
  const channels = r.channels === 'sms' || r.channels === 'email' || r.channels === 'both' ? r.channels : null;
  if (!channels) return null;
  const active = r.active !== false;
  if (r.kind === 'role') {
    const role = String(r.role || '').trim().toLowerCase();
    if (!role) return null;
    return { kind: 'role', role, channels, active };
  }
  if (r.kind === 'employee') {
    const employeeId = String(r.employeeId || '').trim();
    if (!employeeId) return null;
    return { kind: 'employee', employeeId, channels, active };
  }
  if (r.kind === 'external') {
    const externalId = String(r.externalId || '').trim();
    if (!externalId) return null;
    return {
      kind: 'external',
      externalId,
      name: typeof r.name === 'string' ? r.name : null,
      phone: typeof r.phone === 'string' ? r.phone : null,
      email: typeof r.email === 'string' ? r.email : null,
      channels,
      active,
    };
  }
  return null;
}

function channelsOf(pref: SpillNotifyChannelPref): SpillNotifyChannel[] {
  return pref === 'both' ? ['sms', 'email'] : [pref];
}

export interface DedupedRecipientKey {
  key: string;
  channel: SpillNotifyChannel;
}

/** Collapse duplicate role/person/channel combos to one key. */
export function dedupeRecipientKeys(policy: SpillNotificationPolicy): DedupedRecipientKey[] {
  const seen = new Set<string>();
  const out: DedupedRecipientKey[] = [];
  for (const r of policy.recipients) {
    if (r.active === false) continue;
    for (const ch of channelsOf(r.channels)) {
      const who = r.kind === 'role' ? `role:${r.role}` : r.kind === 'employee' ? `emp:${r.employeeId}` : `ext:${r.externalId}`;
      const k = `${who}|${ch}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ key: who, channel: ch });
    }
  }
  return out;
}

export function validateSpillPolicy(policy: SpillNotificationPolicy): PolicyValidation {
  const errors: string[] = [];
  if (typeof policy.enabled !== 'boolean') errors.push('enabled must be boolean');
  if (!Array.isArray(policy.recipients)) errors.push('recipients must be an array');
  if (typeof policy.version !== 'number' || policy.version < 0 || !Number.isFinite(policy.version)) {
    errors.push('version must be a non-negative integer');
  }
  if (policy.externalAccessEnabled) {
    const h = policy.externalAccessExpiresHours;
    if (typeof h !== 'number' || h < 1 || h > 168) {
      errors.push('external-link expiration must be 1–168 hours when external access is enabled');
    }
  }
  for (const r of policy.recipients || []) {
    if (r.kind === 'role') {
      if (!r.role.trim()) errors.push('role recipient missing role');
    } else if (r.kind === 'employee') {
      if (!r.employeeId.trim()) errors.push('employee recipient missing employeeId');
    } else {
      const chans = channelsOf(r.channels);
      if (chans.includes('sms') && !normalizePhone(r.phone)) errors.push(`external ${r.externalId} missing valid SMS number`);
      if (chans.includes('email') && !validateEmail(r.email)) errors.push(`external ${r.externalId} missing valid email`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function bumpPolicyVersion(current: SpillNotificationPolicy, nowIso: string, uid: string): SpillNotificationPolicy {
  return {
    ...current,
    version: (current.version || 0) + 1,
    updatedAtIso: nowIso,
    updatedByUid: uid,
  };
}
