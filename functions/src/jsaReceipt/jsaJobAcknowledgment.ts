/**
 * jsaAcknowledgeJob — durable per-job acknowledgment after a governed
 * first-read. Identity and period are server-derived. The client may
 * send only jobRef plus optional attested observation metadata.
 *
 * WORLD-WRITABLE INVOICE/DISPATCH FIELDS ARE PRE-EXISTING CONTAINMENT
 * DEBT. Rules still allow client writes. This handler never trusts
 * client departedEvent / arrivedEvent / body createdAt. Job start is
 * Firestore document metadata createTime. Ownership is a best-effort
 * cross-check of every present identifier against verified claims;
 * disagreement or missing required ownership refuses. This phase does
 * NOT create a retroactive jsa_job_bindings record.
 *
 * Unverifiable history never degrades to the current open period.
 */
import {
  decideCurrentShiftReadEvidence,
  jsaJobAckIdPreimage,
  JSA_JOB_ACK_COLLECTION,
  JSA_JOB_ACK_METHOD,
  JSA_JOB_ACK_PROTOCOL_VERSION,
  JSA_JOB_ACK_SCHEMA_VERSION,
  validateJsaJobAckRequest,
  validateJsaJobAckResponse,
  type JsaCurrentShiftReadEvidenceRecord,
  type JsaJobAckRecord,
  type JsaJobAckResponse,
} from '@tester3x/wellbuilt-contracts';
import {
  originDayOf,
  shiftDayPath,
  type ShiftAuthorityRecord,
  type ResolveResult,
} from '../security/operational/shiftAuthority.js';
import {
  parseAuthPrincipal,
  requireAudience,
  JSA_APP_WBT,
  type AuthPrincipal,
} from './jsaReceiptCore.js';
import { JsaReceiptError } from './jsaReceiptHandlers.js';

export const JSA_JOB_ACK_HISTORY_DAY_BOUND = 31;
export const JSA_JOB_ACK_MAX_CANDIDATE_DAYS = 40;

export type ShiftLifecycleEventView = {
  type: string;
  shiftId: string;
  timestamp: string;
  source: string;
};

export type ShiftDayView = {
  date: string;
  currentShiftId?: string | null;
  events: ShiftLifecycleEventView[];
};

export type InvoiceView = {
  exists: boolean;
  createTimeMs: number | null;
  data: Record<string, unknown> | null;
};

export type DispatchView = {
  exists: boolean;
  data: Record<string, unknown> | null;
};

export type JobAckTxn = {
  get(path: string): Promise<{ exists: boolean; data?: Record<string, unknown> }>;
  create(path: string, data: Record<string, unknown>): void;
};

export type JobAckDeps = {
  nowMs(): number;
  sha256Hex(input: string): string;
  resolveShift(driverId: string, companyId: string): Promise<ResolveResult>;
  readAuthority(driverId: string): Promise<ShiftAuthorityRecord | null>;
  readShiftDay(driverId: string, localDate: string): Promise<ShiftDayView | null>;
  readInvoice(jobRef: string): Promise<InvoiceView>;
  readDispatch(dispatchId: string): Promise<DispatchView>;
  listGovernedByPeriod(
    companyId: string,
    driverId: string,
    periodId: string,
  ): Promise<JsaCurrentShiftReadEvidenceRecord[]>;
  runTransaction<T>(fn: (txn: JobAckTxn) => Promise<T>): Promise<T>;
  log(event: string, extra: Record<string, string>): void;
};

function throwAuth(d: { ok: false; refusal: string; detail: string }): never {
  if (d.refusal === 'unauthenticated') {
    throw new JsaReceiptError('unauthenticated', 'unauthenticated', d.detail);
  }
  throw new JsaReceiptError('permission-denied', d.refusal as never, d.detail);
}

function principalOf(auth: { uid?: string | null; claims?: Record<string, unknown> | null }): AuthPrincipal {
  const p = parseAuthPrincipal(auth);
  if (!p.ok) throwAuth(p);
  const aud = requireAudience(p.value, JSA_APP_WBT);
  if (!aud.ok) throwAuth(aud);
  return p.value;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

export function ackDocumentId(
  sha256Hex: (s: string) => string,
  companyId: string,
  driverId: string,
  jobRef: string,
): string {
  return sha256Hex(jsaJobAckIdPreimage(companyId, driverId, jobRef));
}

export function ackDocumentPath(id: string): string {
  return `${JSA_JOB_ACK_COLLECTION}/${id}`;
}

/**
 * Best-effort ownership. Any present company/driver identifier that
 * disagrees with claims is not_owner. Missing every required signal is
 * authority_unverifiable — we refuse rather than guess.
 */
export function decideJobOwnership(
  invoice: Record<string, unknown> | null,
  dispatch: Record<string, unknown> | null,
  expect: { companyId: string; driverId: string },
): { ok: true } | { ok: false; refusal: 'not_owner' | 'authority_unverifiable'; detail: string } {
  const docs = [invoice, dispatch].filter(Boolean) as Record<string, unknown>[];
  const companies: string[] = [];
  const driverIds: string[] = [];
  for (const d of docs) {
    const c = str(d.companyId);
    if (c) companies.push(c);
    for (const k of ['driverId', 'assignedDriverId', 'assignedDriverHash', 'driverHash']) {
      const v = str(d[k]);
      if (v) driverIds.push(v);
    }
  }
  if (companies.length === 0 || driverIds.length === 0) {
    return { ok: false, refusal: 'authority_unverifiable', detail: 'ownership_missing' };
  }
  if (companies.some((c) => c !== expect.companyId)) {
    return { ok: false, refusal: 'not_owner', detail: 'company' };
  }
  if (driverIds.some((id) => id !== expect.driverId)) {
    return { ok: false, refusal: 'not_owner', detail: 'driver' };
  }
  return { ok: true };
}

function utcDay(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addUtcDays(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return utcDay(dt.getTime());
}

export function candidateOriginDays(
  authority: ShiftAuthorityRecord | null,
  jobCreateTimeMs: number,
  bound = JSA_JOB_ACK_HISTORY_DAY_BOUND,
): { days: string[]; exhausted: boolean } {
  const out = new Set<string>();
  if (authority?.originLocalDate) out.add(authority.originLocalDate);
  if (authority?.lastClosedPeriodId) {
    const d = originDayOf(authority.lastClosedPeriodId);
    if (d) out.add(d);
  }
  const origin = utcDay(jobCreateTimeMs);
  for (let i = -bound; i <= 1; i++) out.add(addUtcDays(origin, i));
  const days = [...out];
  return { days, exhausted: days.length > JSA_JOB_ACK_MAX_CANDIDATE_DAYS };
}

type Interval = {
  periodId: string;
  originLocalDate: string;
  startMs: number;
  endMs: number;
};

function parseEventMs(ts: string): number | null {
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : null;
}

/**
 * Reconstruct the unique server period whose [login, logout) interval
 * contains jobCreateTimeMs. Never substitutes the live pointer or
 * lastClosedPeriodId when history does not uniquely cover the job start.
 */
export function reconstructPeriodForJobStart(input: {
  authority: ShiftAuthorityRecord | null;
  expect: { driverId: string; companyId: string };
  jobCreateTimeMs: number;
  days: ShiftDayView[];
  exhausted?: boolean;
}): { ok: true; periodId: string; originLocalDate: string }
  | { ok: false; refusal: 'period_unverifiable' | 'authority_unverifiable'; detail: string } {
  if (input.exhausted) {
    return { ok: false, refusal: 'period_unverifiable', detail: 'history_bound' };
  }
  if (!input.authority || input.authority.initialized !== true) {
    return { ok: false, refusal: 'authority_unverifiable', detail: 'authority' };
  }
  if (input.authority.driverId !== input.expect.driverId
    || input.authority.companyId !== input.expect.companyId) {
    return { ok: false, refusal: 'authority_unverifiable', detail: 'driver_mismatch' };
  }
  if (!Number.isFinite(input.jobCreateTimeMs) || input.jobCreateTimeMs <= 0) {
    return { ok: false, refusal: 'period_unverifiable', detail: 'create_time' };
  }

  const byPeriod = new Map<string, { origin: string; logins: number[]; logouts: number[] }>();
  for (const day of input.days) {
    if (!day || typeof day.date !== 'string') {
      return { ok: false, refusal: 'period_unverifiable', detail: 'malformed_day' };
    }
    for (const ev of day.events || []) {
      if (!ev || ev.source !== 'server') continue;
      if (ev.type !== 'login' && ev.type !== 'logout') continue;
      if (typeof ev.shiftId !== 'string' || !originDayOf(ev.shiftId)) {
        return { ok: false, refusal: 'period_unverifiable', detail: 'malformed_event' };
      }
      const ms = parseEventMs(ev.timestamp);
      if (ms == null) return { ok: false, refusal: 'period_unverifiable', detail: 'malformed_timestamp' };
      const origin = originDayOf(ev.shiftId) as string;
      let slot = byPeriod.get(ev.shiftId);
      if (!slot) {
        slot = { origin, logins: [], logouts: [] };
        byPeriod.set(ev.shiftId, slot);
      }
      if (ev.type === 'login') slot.logins.push(ms);
      else slot.logouts.push(ms);
    }
  }

  const intervals: Interval[] = [];
  const openId = input.authority.openPeriodId;
  for (const [periodId, slot] of byPeriod) {
    if (slot.logins.length === 0) {
      return { ok: false, refusal: 'period_unverifiable', detail: 'missing_login' };
    }
    const startMs = Math.min(...slot.logins);
    const laterLogouts = slot.logouts.filter((t) => t >= startMs);
    const isOpen = openId === periodId;
    if (!isOpen && laterLogouts.length === 0) {
      return { ok: false, refusal: 'period_unverifiable', detail: 'missing_logout' };
    }
    if (isOpen && laterLogouts.length > 0) {
      return { ok: false, refusal: 'period_unverifiable', detail: 'open_has_logout' };
    }
    const endMs = isOpen ? Number.POSITIVE_INFINITY : Math.min(...laterLogouts);
    if (!isOpen && endMs <= startMs) {
      return { ok: false, refusal: 'period_unverifiable', detail: 'inverted_interval' };
    }
    intervals.push({ periodId, originLocalDate: slot.origin, startMs, endMs });
  }

  if (intervals.length === 0) {
    return { ok: false, refusal: 'period_unverifiable', detail: 'zero_interval' };
  }

  // Overlap check (closed-open intervals).
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startMs < sorted[i - 1].endMs) {
      return { ok: false, refusal: 'period_unverifiable', detail: 'overlap' };
    }
  }

  const hits = intervals.filter((iv) =>
    input.jobCreateTimeMs >= iv.startMs && input.jobCreateTimeMs < iv.endMs);
  if (hits.length === 0) {
    return { ok: false, refusal: 'period_unverifiable', detail: 'not_in_interval' };
  }
  if (hits.length > 1) {
    return { ok: false, refusal: 'period_unverifiable', detail: 'multiple_intervals' };
  }
  return { ok: true, periodId: hits[0].periodId, originLocalDate: hits[0].originLocalDate };
}

function storedScopeOk(
  data: Record<string, unknown>,
  expect: { companyId: string; driverId: string; jobRef: string },
): boolean {
  return data.companyId === expect.companyId
    && data.driverId === expect.driverId
    && data.jobRef === expect.jobRef
    && data.schemaVersion === JSA_JOB_ACK_SCHEMA_VERSION
    && data.method === JSA_JOB_ACK_METHOD;
}

export async function handleAcknowledgeJob(
  deps: JobAckDeps,
  auth: { uid?: string | null; claims?: Record<string, unknown> | null },
  data: unknown,
): Promise<JsaJobAckResponse> {
  const parsed = validateJsaJobAckRequest(data);
  if (!parsed.ok) {
    throw new JsaReceiptError(
      parsed.errorCode === 'unsupported_protocol' ? 'failed-precondition' : 'invalid-argument',
      parsed.errorCode === 'client_identity' ? 'client_identity' : 'malformed',
      parsed.field,
    );
  }
  const req = parsed.value;
  const p = principalOf(auth);

  let invoice: InvoiceView;
  try {
    invoice = await deps.readInvoice(req.jobRef);
  } catch {
    throw new JsaReceiptError('permission-denied', 'authority_unverifiable', 'invoice_read');
  }
  if (!invoice.exists || !invoice.data) {
    throw new JsaReceiptError('failed-precondition', 'not_found', 'invoice');
  }
  if (invoice.createTimeMs == null || invoice.createTimeMs <= 0) {
    throw new JsaReceiptError('permission-denied', 'authority_unverifiable', 'create_time');
  }

  let dispatch: DispatchView = { exists: false, data: null };
  const dispatchId = str(invoice.data.dispatchId);
  if (dispatchId) {
    try {
      dispatch = await deps.readDispatch(dispatchId);
    } catch {
      throw new JsaReceiptError('permission-denied', 'authority_unverifiable', 'dispatch_read');
    }
  }

  const owner = decideJobOwnership(invoice.data, dispatch.data, {
    companyId: p.companyId,
    driverId: p.driverId,
  });
  if (!owner.ok) {
    throw new JsaReceiptError('permission-denied', owner.refusal, owner.detail);
  }

  let authority: ShiftAuthorityRecord | null;
  try {
    authority = await deps.readAuthority(p.driverId);
  } catch {
    throw new JsaReceiptError('permission-denied', 'authority_unverifiable', 'authority_read');
  }

  const candidates = candidateOriginDays(authority, invoice.createTimeMs);
  if (candidates.exhausted) {
    throw new JsaReceiptError('failed-precondition', 'period_unverifiable', 'history_bound');
  }
  const days: ShiftDayView[] = [];
  try {
    for (const date of candidates.days) {
      const day = await deps.readShiftDay(p.driverId, date);
      if (day) days.push(day);
    }
  } catch {
    throw new JsaReceiptError('permission-denied', 'authority_unverifiable', 'shift_day_read');
  }

  const period = reconstructPeriodForJobStart({
    authority,
    expect: { driverId: p.driverId, companyId: p.companyId },
    jobCreateTimeMs: invoice.createTimeMs,
    days,
    exhausted: candidates.exhausted,
  });
  if (!period.ok) {
    throw new JsaReceiptError('failed-precondition', period.refusal, period.detail);
  }

  let records: JsaCurrentShiftReadEvidenceRecord[];
  try {
    records = await deps.listGovernedByPeriod(p.companyId, p.driverId, period.periodId);
  } catch {
    throw new JsaReceiptError('failed-precondition', 'authority_unverifiable', 'query_failed');
  }
  const evidence = decideCurrentShiftReadEvidence(period.periodId, records, {
    companyId: p.companyId,
    driverId: p.driverId,
  });
  if (evidence !== 'read_bootstrapped') {
    throw new JsaReceiptError('failed-precondition', 'no_qualifying_read', 'evidence');
  }

  const id = ackDocumentId(deps.sha256Hex, p.companyId, p.driverId, req.jobRef);
  const path = ackDocumentPath(id);
  const expectScope = { companyId: p.companyId, driverId: p.driverId, jobRef: req.jobRef };

  const state = await deps.runTransaction(async (txn) => {
    const existing = await txn.get(path);
    if (existing.exists) {
      if (!existing.data || !storedScopeOk(existing.data, expectScope)) {
        throw new JsaReceiptError('failed-precondition', 'period_unverifiable', 'scope_mismatch');
      }
      return 'already_recorded' as const;
    }
    const record: JsaJobAckRecord = {
      schemaVersion: JSA_JOB_ACK_SCHEMA_VERSION,
      companyId: p.companyId,
      driverId: p.driverId,
      jobRef: req.jobRef,
      periodId: period.periodId,
      originLocalDate: period.originLocalDate,
      recordedAtMs: deps.nowMs(),
      method: JSA_JOB_ACK_METHOD,
    };
    if (req.acknowledgedAtMs !== undefined) record.clientObservedAtMs = req.acknowledgedAtMs;
    if (req.ceremonyId !== undefined) record.ceremonyId = req.ceremonyId;
    txn.create(path, { ...record });
    return 'recorded' as const;
  });

  const body: JsaJobAckResponse = {
    protocolVersion: JSA_JOB_ACK_PROTOCOL_VERSION,
    state,
  };
  const checked = validateJsaJobAckResponse(body);
  if (!checked.ok) throw new JsaReceiptError('failed-precondition', 'malformed', 'response');
  deps.log('jsa.job_ack', { state });
  return checked.value;
}

export { shiftDayPath };
