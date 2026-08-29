// ingestRefusalLog.ts — structured, redacted observability for governed
// ingest refusals (Phase 4 of the 2026-08-29 packet).
//
// WHY: on 2026-08-28 three ingestWbmPull requests returned HTTP 400 and left
// ZERO server-side material — no packet row, no audit row, no reason. The
// refused submissions could not be classified without device forensics.
// Every governed refusal now emits ONE structured log entry that identifies
// the request without exposing its payload.
//
// REDACTION CONTRACT (hard): never the packet body, never headers, never
// tokens/passcodes/signatures/credentials. Only the allowlisted identity and
// shape metadata below, each bounded and validated.

import { createHash } from 'crypto';

/** Bounded, allowlisted client build metadata supplied OUTSIDE the packet. */
export interface ClientMeta {
  appVersion?: string;
  versionCode?: string;
  channel?: string;
  platform?: string;
}

const META_FIELDS: Array<keyof ClientMeta> = ['appVersion', 'versionCode', 'channel', 'platform'];
const MAX_META_LEN = 64;

/** Validate/bound client-supplied build metadata; anything else is dropped. */
export function sanitizeClientMeta(raw: unknown): ClientMeta | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: ClientMeta = {};
  let any = false;
  for (const f of META_FIELDS) {
    const v = (raw as Record<string, unknown>)[f];
    if (typeof v === 'string' && v.trim() && v.length <= MAX_META_LEN) {
      out[f] = v.trim();
      any = true;
    }
  }
  return any ? out : null;
}

export interface IngestRefusalInput {
  endpoint: string;                       // e.g. 'ingestWbmPull'
  reason: string;                         // stable governed reason code
  uid?: string | null;                    // authenticated uid, when auth succeeded
  driverId?: string | null;
  companyId?: string | null;
  wellName?: string | null;               // only when it passed validation bounds
  operationType?: string | null;          // requestType, when a bounded string
  packetId?: string | null;               // only when Firebase-key-safe
  payloadDigest?: string | null;          // sha256 of the raw packet JSON, when computable
  clientMeta?: ClientMeta | null;
  nowMs: number;
}

export interface IngestRefusalEntry {
  event: 'ingest_refusal';
  endpoint: string;
  reason: string;
  uid: string | null;
  driverId: string | null;
  companyId: string | null;
  wellName: string | null;
  operationType: string | null;
  packetId: string | null;
  payloadDigest: string | null;
  clientMeta: ClientMeta | null;
  serverTs: string;
}

const SENSITIVE_KEY = /passcode|password|token|secret|authorization|signature|credential/i;

function bounded(v: unknown, max = 128): string | null {
  return typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null;
}

/** Pure entry builder — every field bounded; nothing sensitive can pass. */
export function buildIngestRefusalEntry(input: IngestRefusalInput): IngestRefusalEntry {
  const entry: IngestRefusalEntry = {
    event: 'ingest_refusal',
    endpoint: bounded(input.endpoint, 64) ?? 'unknown',
    reason: bounded(input.reason, 96) ?? 'unknown',
    uid: bounded(input.uid),
    driverId: bounded(input.driverId),
    companyId: bounded(input.companyId),
    wellName: bounded(input.wellName, 120),
    operationType: bounded(input.operationType, 32),
    packetId: bounded(input.packetId),
    payloadDigest: bounded(input.payloadDigest, 64),
    clientMeta: input.clientMeta ?? null,
    serverTs: new Date(input.nowMs).toISOString(),
  };
  // Belt-and-suspenders: a sensitive-looking value in any slot is dropped.
  for (const k of ['uid', 'driverId', 'companyId', 'wellName', 'operationType', 'packetId'] as const) {
    const v = entry[k];
    if (v && SENSITIVE_KEY.test(v)) entry[k] = null;
  }
  return entry;
}

/** Digest of the raw packet JSON — identifies a payload without revealing it. */
export function safePayloadDigest(rawPacket: unknown): string | null {
  try {
    if (rawPacket === undefined) return null;
    return createHash('sha256').update(JSON.stringify(rawPacket) ?? 'undefined', 'utf8').digest('hex');
  } catch {
    return null;
  }
}

/** Emit as ONE structured Cloud Logging line (jsonPayload via console). */
export function logIngestRefusal(input: IngestRefusalInput): IngestRefusalEntry {
  const entry = buildIngestRefusalEntry(input);
  console.warn('[ingest_refusal]', JSON.stringify(entry));
  return entry;
}
