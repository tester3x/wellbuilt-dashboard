import { createHash } from 'crypto';

export const EXTERNAL_DELIVERY_STATUSES = Object.freeze([
  'queued',
  'sent',
  'delivered',
  'accepted',
  'declined',
  'failed',
] as const);

export type ExternalDeliveryStatus = typeof EXTERNAL_DELIVERY_STATUSES[number];
export type ExternalDeliveryChannel = 'sms' | 'whatsapp';
export type ExternalAssignmentAction = 'assigned' | 'reassigned' | 'retried' | 'cancelled';

export type ExternalDriverRecord = {
  externalDriverId: string;
  companyId: string;
  displayName: string;
  phoneE164: string;
  channels: ExternalDeliveryChannel[];
  active: boolean;
};

export type ExternalDeliveryHistoryEntry = {
  status: ExternalDeliveryStatus;
  at: string;
  reason?: string;
  providerMessageId?: string;
  notSent?: true;
};

export type ExternalDeliveryRevision = {
  schemaVersion: 1;
  deliveryId: string;
  companyId: string;
  dispatchId: string;
  revision: number;
  action: ExternalAssignmentAction;
  assignmentState: 'active' | 'cancelled';
  externalDriverId: string;
  channel: ExternalDeliveryChannel;
  status: ExternalDeliveryStatus;
  idempotencyKeyHash: string;
  supersedesRevision: number | null;
  createdAt: string;
  createdBy: string;
  history: ExternalDeliveryHistoryEntry[];
  failureCode?: string;
};

export type ExternalDeliveryRoot = {
  schemaVersion: 1;
  deliveryId: string;
  companyId: string;
  dispatchId: string;
  currentRevision: number;
  currentStatus: ExternalDeliveryStatus;
  assignmentState: 'active' | 'cancelled';
  externalDriverId: string;
  channel: ExternalDeliveryChannel;
  lastIdempotencyKeyHash: string;
  updatedAt: string;
  updatedBy: string;
};

export type ExternalDeliveryFailure = { ok: false; reason: string; field?: string };
export type ExternalDeliverySuccess<T> = { ok: true } & T;

const ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const E164_RE = /^\+[1-9]\d{7,14}$/;
const MAX_NAME_LENGTH = 120;
const MAX_IDEMPOTENCY_LENGTH = 200;

function fail(reason: string, field?: string): ExternalDeliveryFailure {
  return field ? { ok: false, reason, field } : { ok: false, reason };
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function hashExternalDeliveryKey(companyId: string, key: string): string {
  return createHash('sha256').update(`${companyId}\u0000${key}`, 'utf8').digest('hex');
}

export function deliveryIdForKey(companyId: string, key: string): string {
  return `ext_${hashExternalDeliveryKey(companyId, key).slice(0, 40)}`;
}

export function parseExternalDriverWrite(
  raw: unknown,
  companyId: string,
): ExternalDeliverySuccess<Omit<ExternalDriverRecord, 'companyId'>> | ExternalDeliveryFailure {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid_driver', 'driver');
  const value = raw as Record<string, unknown>;
  const allowed = new Set(['externalDriverId', 'displayName', 'phoneE164', 'channels', 'active']);
  const unexpected = Object.keys(value).find(key => !allowed.has(key));
  if (unexpected) return fail('unexpected_field', unexpected);
  const externalDriverId = stringField(value.externalDriverId);
  const displayName = stringField(value.displayName);
  const phoneE164 = stringField(value.phoneE164);
  if (!companyId) return fail('missing_company', 'companyId');
  if (!ID_RE.test(externalDriverId)) return fail('invalid_driver_id', 'externalDriverId');
  if (!displayName || displayName.length > MAX_NAME_LENGTH) return fail('invalid_display_name', 'displayName');
  if (phoneE164 && !E164_RE.test(phoneE164)) return fail('invalid_phone', 'phoneE164');
  if (!Array.isArray(value.channels) || value.channels.length > 2) {
    return fail('invalid_channels', 'channels');
  }
  const channels = [...new Set(value.channels)];
  if (channels.some(channel => channel !== 'sms' && channel !== 'whatsapp')) {
    return fail('invalid_channels', 'channels');
  }
  if ((phoneE164 && channels.length === 0) || (!phoneE164 && channels.length > 0))
    return fail('invalid_channels', 'channels');
  if (typeof value.active !== 'boolean') return fail('invalid_active', 'active');
  return {
    ok: true,
    externalDriverId,
    displayName,
    phoneE164,
    channels: channels as ExternalDeliveryChannel[],
    active: value.active,
  };
}

export function validateIdempotencyKey(raw: unknown): ExternalDeliverySuccess<{ key: string }> | ExternalDeliveryFailure {
  const key = stringField(raw);
  if (!key || key.length > MAX_IDEMPOTENCY_LENGTH) return fail('invalid_idempotency_key', 'idempotencyKey');
  return { ok: true, key };
}

export function planExternalAssignmentRevision(input: {
  companyId: string;
  actorUid: string;
  nowIso: string;
  idempotencyKey: string;
  dispatchId: string;
  externalDriver: ExternalDriverRecord;
  channel: ExternalDeliveryChannel;
  action: Exclude<ExternalAssignmentAction, 'cancelled'>;
  existing: ExternalDeliveryRoot | null;
}): ExternalDeliverySuccess<{ root: ExternalDeliveryRoot; revision: ExternalDeliveryRevision }> | ExternalDeliveryFailure {
  if (!ID_RE.test(input.dispatchId)) return fail('invalid_dispatch_id', 'dispatchId');
  if (input.externalDriver.companyId !== input.companyId) return fail('cross_company', 'externalDriverId');
  if (!input.externalDriver.active) return fail('external_driver_inactive', 'externalDriverId');
  if (!E164_RE.test(input.externalDriver.phoneE164)) return fail('invalid_phone', 'phoneE164');
  if (!input.externalDriver.channels.includes(input.channel)) return fail('channel_not_enabled', 'channel');
  if (input.existing && input.existing.companyId !== input.companyId) return fail('cross_company', 'deliveryId');
  if (input.existing && input.existing.dispatchId !== input.dispatchId) return fail('dispatch_immutable', 'dispatchId');
  if (!input.existing && input.action !== 'assigned') return fail('delivery_not_found', 'deliveryId');
  if (input.existing?.assignmentState === 'cancelled' && input.action === 'retried') {
    return fail('assignment_cancelled', 'deliveryId');
  }
  if (input.action === 'retried' && input.existing?.currentStatus !== 'failed') {
    return fail('retry_not_allowed', input.existing?.currentStatus || 'missing');
  }
  const idempotencyKeyHash = hashExternalDeliveryKey(input.companyId, input.idempotencyKey);
  const deliveryId = input.existing?.deliveryId || deliveryIdForKey(input.companyId, input.idempotencyKey);
  const revisionNumber = (input.existing?.currentRevision || 0) + 1;
  const history: ExternalDeliveryHistoryEntry[] = [{ status: 'queued', at: input.nowIso }];
  const revision: ExternalDeliveryRevision = {
    schemaVersion: 1,
    deliveryId,
    companyId: input.companyId,
    dispatchId: input.dispatchId,
    revision: revisionNumber,
    action: input.action,
    assignmentState: 'active',
    externalDriverId: input.externalDriver.externalDriverId,
    channel: input.channel,
    status: 'queued',
    idempotencyKeyHash,
    supersedesRevision: input.existing?.currentRevision || null,
    createdAt: input.nowIso,
    createdBy: input.actorUid,
    history,
  };
  return {
    ok: true,
    revision,
    root: {
      schemaVersion: 1,
      deliveryId,
      companyId: input.companyId,
      dispatchId: input.dispatchId,
      currentRevision: revisionNumber,
      currentStatus: 'queued',
      assignmentState: 'active',
      externalDriverId: input.externalDriver.externalDriverId,
      channel: input.channel,
      lastIdempotencyKeyHash: idempotencyKeyHash,
      updatedAt: input.nowIso,
      updatedBy: input.actorUid,
    },
  };
}

export function applyExternalProviderResult(
  revision: ExternalDeliveryRevision,
  result:
    | { kind: 'sent'; at: string; providerMessageId: string }
    | { kind: 'unconfigured'; at: string }
    | { kind: 'failed'; at: string; code: string },
): ExternalDeliveryRevision {
  if (revision.status !== 'queued') return revision;
  if (result.kind === 'sent') {
    return {
      ...revision,
      status: 'sent',
      history: [...revision.history, { status: 'sent', at: result.at, providerMessageId: result.providerMessageId }],
    };
  }
  const failureCode = result.kind === 'unconfigured' ? 'provider_unconfigured' : result.code;
  return {
    ...revision,
    status: 'failed',
    failureCode,
    history: [...revision.history, {
      status: 'failed',
      at: result.at,
      reason: failureCode,
      ...(result.kind === 'unconfigured' ? { notSent: true as const } : {}),
    }],
  };
}

export function planExternalAssignmentCancellation(input: {
  existing: ExternalDeliveryRoot;
  companyId: string;
  actorUid: string;
  nowIso: string;
  idempotencyKey: string;
}): ExternalDeliverySuccess<{ root: ExternalDeliveryRoot; revision: ExternalDeliveryRevision }> | ExternalDeliveryFailure {
  if (input.existing.companyId !== input.companyId) return fail('cross_company', 'deliveryId');
  if (input.existing.assignmentState === 'cancelled') {
    return fail('already_cancelled', 'deliveryId');
  }
  const keyHash = hashExternalDeliveryKey(input.companyId, input.idempotencyKey);
  const revisionNumber = input.existing.currentRevision + 1;
  const revision: ExternalDeliveryRevision = {
    schemaVersion: 1,
    deliveryId: input.existing.deliveryId,
    companyId: input.companyId,
    dispatchId: input.existing.dispatchId,
    revision: revisionNumber,
    action: 'cancelled',
    assignmentState: 'cancelled',
    externalDriverId: input.existing.externalDriverId,
    channel: input.existing.channel,
    status: input.existing.currentStatus,
    idempotencyKeyHash: keyHash,
    supersedesRevision: input.existing.currentRevision,
    createdAt: input.nowIso,
    createdBy: input.actorUid,
    history: [],
  };
  return {
    ok: true,
    revision,
    root: {
      ...input.existing,
      currentRevision: revisionNumber,
      assignmentState: 'cancelled',
      lastIdempotencyKeyHash: keyHash,
      updatedAt: input.nowIso,
      updatedBy: input.actorUid,
    },
  };
}

export function planExternalResponse(
  current: ExternalDeliveryStatus,
  response: 'delivered' | 'accepted' | 'declined',
): ExternalDeliverySuccess<{ status: ExternalDeliveryStatus }> | ExternalDeliveryFailure {
  const allowed: Record<'delivered' | 'accepted' | 'declined', ExternalDeliveryStatus[]> = {
    delivered: ['sent'],
    accepted: ['sent', 'delivered'],
    declined: ['sent', 'delivered'],
  };
  if (!allowed[response].includes(current)) return fail('invalid_delivery_transition', `${current}->${response}`);
  return { ok: true, status: response };
}
