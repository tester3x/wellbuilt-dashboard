/**
 * Governed JSA request/receipt — pure decision core.
 *
 * Server-owned records. Identity and shift come from authenticated claims
 * plus authoritative binding. Clients may send only bounded request
 * metadata (requestId, jobRef, optional groupRef, policy intent).
 *
 * No firebase-admin, no clock I/O, no names, tokens, or hashes.
 */

export const JSA_GOVERNED_COLLECTION = 'jsa_governed_requests';
export const JSA_REQUEST_ID_RE = /^[A-Za-z0-9_-]{43}$/;
export const JSA_REF_RE = /^[A-Za-z0-9._-]{1,128}$/;
export const JSA_PENDING_TTL_MS = 2 * 60 * 60 * 1000;
export const JSA_APP_WBT = 'wbt';
export const JSA_APP_JSA = 'jsa';
export const JSA_WELL_NAME_MAX = 120;
export const JSA_JOB_TYPE_MAX = 64;

export type JsaPolicyIntent = 'read' | 'acknowledge' | 'read_and_acknowledge';
/**
 * TERMINAL EVIDENCE, not UI events. Each names exactly which stages
 * actually occurred:
 *
 *   read_completed        — the full first read occurred; no acknowledgment.
 *   acknowledged          — an acknowledgment occurred; no full read.
 *   read_and_acknowledged — BOTH stages occurred (in one interaction or
 *                           two — the client submits this single terminal
 *                           action only once both are true).
 *
 * Satisfaction is MONOTONE and never downgrades (see
 * decideActionSatisfies): stronger evidence satisfies a weaker registered
 * intent, but `read_and_acknowledge` is satisfied ONLY by
 * `read_and_acknowledged` — neither stage alone completes it.
 */
export type JsaCompletionAction = 'read_completed' | 'acknowledged' | 'read_and_acknowledged';
export type JsaRequestState = 'pending' | 'completed' | 'expired';
export type JsaShiftState = 'open' | 'none';

export interface JsaAuthorityBinding {
  shiftState: JsaShiftState;
  periodId?: string;
  originLocalDate?: string;
  requiresActiveShift: boolean;
  jsaEnabled: boolean;
}

export interface JsaRequestMeta {
  requestId: string;
  jobRef: string;
  groupRef: string | null;
  intent: JsaPolicyIntent;
}

export interface JsaGovernedRecord {
  requestId: string;
  jobRef: string;
  groupRef: string | null;
  intent: JsaPolicyIntent;
  driverId: string;
  companyId: string;
  binding: JsaAuthorityBinding;
  state: JsaRequestState;
  action: JsaCompletionAction | null;
  receiptHandle: string;
  createdAtMs: number;
  expiresAtMs: number;
  completedAtMs: number | null;
  wbtConsumedAtMs: number | null;
}

export interface AuthPrincipal {
  uid: string;
  app: string | null;
  driverId: string;
  companyId: string;
  kind: string | null;
}

export type ReceiptRefusal =
  | 'unauthenticated'
  | 'wrong_audience'
  | 'not_a_driver'
  | 'malformed'
  | 'client_identity'
  | 'jsa_disabled'
  | 'active_shift_required'
  | 'authority_unverifiable'
  | 'intent_not_permitted'
  | 'collision'
  | 'not_found'
  | 'expired'
  | 'pending'
  | 'binding_mismatch'
  | 'job_mismatch'
  | 'action_not_permitted'
  | 'conflict';
// NOTE deliberately absent: an 'already_consumed' refusal. Repeated
// consumption by the same authorized WB-T binding is NOT an error —
// decideConsume returns the SAME immutable terminal view every time,
// with alreadyConsumed flagged. wbtConsumedAtMs is audit information,
// never a one-shot delivery lock; making it one would strand a client
// that died between the server mark and its local persistence.

export type Decision<T> =
  | { ok: true; value: T }
  | { ok: false; refusal: ReceiptRefusal; detail: string };

const FORBIDDEN_CLIENT_KEYS = [
  'uid', 'driverId', 'companyId', 'driverHash', 'passcode', 'hash',
  'shiftId', 'periodId', 'originLocalDate', 'name', 'displayName', 'legalName',
  'customToken', 'code', 'codeVerifier', 'verifier',
];

export function isRequestId(v: unknown): v is string {
  return typeof v === 'string' && JSA_REQUEST_ID_RE.test(v);
}

export function isJobRef(v: unknown): v is string {
  return typeof v === 'string' && JSA_REF_RE.test(v);
}

export function isPolicyIntent(v: unknown): v is JsaPolicyIntent {
  return v === 'read' || v === 'acknowledge' || v === 'read_and_acknowledge';
}

export function isCompletionAction(v: unknown): v is JsaCompletionAction {
  return v === 'read_completed' || v === 'acknowledged' || v === 'read_and_acknowledged';
}

export function recordPath(requestId: string): string {
  return `${JSA_GOVERNED_COLLECTION}/${requestId}`;
}

export function parseAuthPrincipal(auth: {
  uid?: string | null;
  claims?: Record<string, unknown> | null;
} | null | undefined): Decision<AuthPrincipal> {
  if (!auth?.uid) return { ok: false, refusal: 'unauthenticated', detail: 'no_auth' };
  const c = auth.claims || {};
  if (c.kind !== 'driver') return { ok: false, refusal: 'not_a_driver', detail: 'kind' };
  if (typeof c.driverId !== 'string' || !c.driverId) {
    return { ok: false, refusal: 'not_a_driver', detail: 'driverId' };
  }
  if (typeof c.companyId !== 'string' || !c.companyId) {
    return { ok: false, refusal: 'not_a_driver', detail: 'companyId' };
  }
  const app = typeof c.app === 'string' ? c.app : null;
  return {
    ok: true,
    value: { uid: auth.uid, app, driverId: c.driverId, companyId: c.companyId, kind: 'driver' },
  };
}

export function requireAudience(principal: AuthPrincipal, expected: string): Decision<true> {
  if (principal.app !== expected) {
    return { ok: false, refusal: 'wrong_audience', detail: 'app' };
  }
  return { ok: true, value: true };
}

export function parseRegisterInput(data: unknown): Decision<JsaRequestMeta> {
  const o = data as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || Array.isArray(o)) {
    return { ok: false, refusal: 'malformed', detail: 'root' };
  }
  const keys = Object.keys(o);
  if (keys.some((k) => FORBIDDEN_CLIENT_KEYS.includes(k))) {
    return { ok: false, refusal: 'client_identity', detail: 'forbidden_field' };
  }
  const allowed = ['requestId', 'jobRef', 'groupRef', 'intent'];
  if (!keys.every((k) => allowed.includes(k))) {
    return { ok: false, refusal: 'malformed', detail: 'unknown_key' };
  }
  if (!isRequestId(o.requestId)) return { ok: false, refusal: 'malformed', detail: 'requestId' };
  if (!isJobRef(o.jobRef)) return { ok: false, refusal: 'malformed', detail: 'jobRef' };
  if (o.groupRef != null && o.groupRef !== '' && !isJobRef(o.groupRef)) {
    return { ok: false, refusal: 'malformed', detail: 'groupRef' };
  }
  if (!isPolicyIntent(o.intent)) return { ok: false, refusal: 'malformed', detail: 'intent' };
  return {
    ok: true,
    value: {
      requestId: o.requestId,
      jobRef: o.jobRef,
      groupRef: o.groupRef ? String(o.groupRef) : null,
      intent: o.intent,
    },
  };
}

export function parseCompleteInput(data: unknown): Decision<{ requestId: string; action: JsaCompletionAction }> {
  const o = data as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || Array.isArray(o)) {
    return { ok: false, refusal: 'malformed', detail: 'root' };
  }
  if (Object.keys(o).some((k) => FORBIDDEN_CLIENT_KEYS.includes(k))) {
    return { ok: false, refusal: 'client_identity', detail: 'forbidden_field' };
  }
  if (!Object.keys(o).every((k) => ['requestId', 'action'].includes(k))) {
    return { ok: false, refusal: 'malformed', detail: 'unknown_key' };
  }
  if (!isRequestId(o.requestId)) return { ok: false, refusal: 'malformed', detail: 'requestId' };
  if (!isCompletionAction(o.action)) return { ok: false, refusal: 'malformed', detail: 'action' };
  return { ok: true, value: { requestId: o.requestId, action: o.action } };
}

/**
 * jsaGetReadRequest input — identical shape to consume ({requestId} and
 * nothing else) but parsed under its own name so the two operations'
 * surfaces can tighten independently and tests pin each exactly.
 */
export function parseGetContextInput(data: unknown): Decision<{ requestId: string }> {
  const o = data as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || Array.isArray(o)) {
    return { ok: false, refusal: 'malformed', detail: 'root' };
  }
  if (Object.keys(o).some((k) => FORBIDDEN_CLIENT_KEYS.includes(k))) {
    return { ok: false, refusal: 'client_identity', detail: 'forbidden_field' };
  }
  if (!Object.keys(o).every((k) => k === 'requestId')) {
    return { ok: false, refusal: 'malformed', detail: 'unknown_key' };
  }
  if (!isRequestId(o.requestId)) return { ok: false, refusal: 'malformed', detail: 'requestId' };
  return { ok: true, value: { requestId: o.requestId } };
}

export function parseConsumeInput(data: unknown): Decision<{ requestId: string }> {
  const o = data as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || Array.isArray(o)) {
    return { ok: false, refusal: 'malformed', detail: 'root' };
  }
  if (Object.keys(o).some((k) => FORBIDDEN_CLIENT_KEYS.includes(k))) {
    return { ok: false, refusal: 'client_identity', detail: 'forbidden_field' };
  }
  if (!Object.keys(o).every((k) => k === 'requestId')) {
    return { ok: false, refusal: 'malformed', detail: 'unknown_key' };
  }
  if (!isRequestId(o.requestId)) return { ok: false, refusal: 'malformed', detail: 'requestId' };
  return { ok: true, value: { requestId: o.requestId } };
}

/** Server policy: which intents the company allows. */
export interface JsaCompanyPolicy {
  jsaEnabled: boolean;
  requiresActiveShift: boolean;
  /** Permitted completion styles. */
  allowRead: boolean;
  allowAcknowledge: boolean;
}

export function decideIntentAllowed(
  intent: JsaPolicyIntent,
  policy: JsaCompanyPolicy,
): Decision<true> {
  if (!policy.jsaEnabled) return { ok: false, refusal: 'jsa_disabled', detail: 'disabled' };
  if (intent === 'acknowledge' && !policy.allowAcknowledge) {
    return { ok: false, refusal: 'intent_not_permitted', detail: 'ack_downgrade' };
  }
  if ((intent === 'read' || intent === 'read_and_acknowledge') && !policy.allowRead) {
    return { ok: false, refusal: 'intent_not_permitted', detail: 'read_required' };
  }
  return { ok: true, value: true };
}

/**
 * THE terminal-action table. Monotone — stronger evidence satisfies a
 * weaker registered intent; nothing ever satisfies a stronger one:
 *
 *   registered intent      | satisfying terminal actions
 *   -----------------------+--------------------------------------------
 *   read                   | read_completed, read_and_acknowledged
 *   acknowledge            | acknowledged,   read_and_acknowledged
 *   read_and_acknowledge   | read_and_acknowledged ONLY
 *
 * `read_and_acknowledge` is the first-shift full-read requirement:
 * neither `read_completed` nor `acknowledged` alone may complete it. A
 * JSA UI that performs both stages in one final interaction submits the
 * single terminal action `read_and_acknowledged`; a UI that runs them as
 * two steps submits it once, after the second stage.
 */
export function decideActionSatisfies(
  registered: JsaPolicyIntent,
  action: JsaCompletionAction,
): Decision<true> {
  if (action === 'read_and_acknowledged') {
    // Both stages occurred — satisfies every intent.
    return { ok: true, value: true };
  }
  if (registered === 'read_and_acknowledge') {
    // Neither stage alone may satisfy the combined requirement.
    return { ok: false, refusal: 'action_not_permitted', detail: 'both_stages_required' };
  }
  if (registered === 'acknowledge') {
    if (action !== 'acknowledged') {
      return { ok: false, refusal: 'action_not_permitted', detail: 'ack_only' };
    }
    return { ok: true, value: true };
  }
  // registered === 'read': a full read is required — ack is a downgrade.
  if (action !== 'read_completed') {
    return { ok: false, refusal: 'action_not_permitted', detail: 'read_required' };
  }
  return { ok: true, value: true };
}

export function bindingsEqual(a: JsaAuthorityBinding, b: JsaAuthorityBinding): boolean {
  return a.shiftState === b.shiftState
    && (a.periodId || '') === (b.periodId || '')
    && (a.originLocalDate || '') === (b.originLocalDate || '')
    && a.requiresActiveShift === b.requiresActiveShift
    && a.jsaEnabled === b.jsaEnabled;
}

export function metadataEqual(a: JsaRequestMeta, b: Pick<JsaGovernedRecord, 'requestId' | 'jobRef' | 'groupRef' | 'intent'>): boolean {
  return a.requestId === b.requestId
    && a.jobRef === b.jobRef
    && (a.groupRef || null) === (b.groupRef || null)
    && a.intent === b.intent;
}

export function decideRegister(input: {
  existing: JsaGovernedRecord | null;
  meta: JsaRequestMeta;
  principal: AuthPrincipal;
  binding: JsaAuthorityBinding;
  policy: JsaCompanyPolicy;
  nowMs: number;
  receiptHandle: string;
}): Decision<{ record: JsaGovernedRecord; write: 'create' | 'reuse' }> {
  const intentOk = decideIntentAllowed(input.meta.intent, input.policy);
  if (!intentOk.ok) return intentOk;
  if (!input.binding.jsaEnabled) return { ok: false, refusal: 'jsa_disabled', detail: 'binding' };

  if (!input.existing) {
    const record: JsaGovernedRecord = {
      requestId: input.meta.requestId,
      jobRef: input.meta.jobRef,
      groupRef: input.meta.groupRef,
      intent: input.meta.intent,
      driverId: input.principal.driverId,
      companyId: input.principal.companyId,
      binding: input.binding,
      state: 'pending',
      action: null,
      receiptHandle: input.receiptHandle,
      createdAtMs: input.nowMs,
      expiresAtMs: input.nowMs + JSA_PENDING_TTL_MS,
      completedAtMs: null,
      wbtConsumedAtMs: null,
    };
    return { ok: true, value: { record, write: 'create' } };
  }

  const sameActor = input.existing.driverId === input.principal.driverId
    && input.existing.companyId === input.principal.companyId;
  if (!sameActor) return { ok: false, refusal: 'collision', detail: 'foreign' };
  if (!metadataEqual(input.meta, input.existing)) {
    return { ok: false, refusal: 'collision', detail: 'metadata' };
  }
  if (!bindingsEqual(input.existing.binding, input.binding)) {
    return { ok: false, refusal: 'collision', detail: 'binding' };
  }
  return { ok: true, value: { record: input.existing, write: 'reuse' } };
}

export function liveState(record: JsaGovernedRecord, nowMs: number): JsaRequestState {
  if (record.state === 'completed') return 'completed';
  if (nowMs > record.expiresAtMs) return 'expired';
  return record.state;
}

export function decideComplete(input: {
  existing: JsaGovernedRecord | null;
  requestId: string;
  action: JsaCompletionAction;
  principal: AuthPrincipal;
  binding: JsaAuthorityBinding;
  nowMs: number;
}): Decision<{ record: JsaGovernedRecord; write: 'complete' | 'reuse' }> {
  if (!input.existing) return { ok: false, refusal: 'not_found', detail: 'unregistered' };
  if (input.existing.requestId !== input.requestId) {
    return { ok: false, refusal: 'not_found', detail: 'id' };
  }
  if (input.existing.driverId !== input.principal.driverId
    || input.existing.companyId !== input.principal.companyId) {
    return { ok: false, refusal: 'binding_mismatch', detail: 'actor' };
  }
  if (!bindingsEqual(input.existing.binding, input.binding)) {
    return { ok: false, refusal: 'binding_mismatch', detail: 'shift' };
  }
  const state = liveState(input.existing, input.nowMs);
  if (state === 'expired') return { ok: false, refusal: 'expired', detail: 'ttl' };

  const actionOk = decideActionSatisfies(input.existing.intent, input.action);
  if (!actionOk.ok) return actionOk;

  if (state === 'completed') {
    // TERMINAL IMMUTABILITY. A completed record is evidence; only the
    // byte-identical retry (crash/duplicate delivery) is reusable. A
    // DIFFERENT action — even a monotonically stronger one — conflicts:
    // upgrading terminal evidence in place would rewrite what was
    // attested. The stronger interaction belongs to a fresh request.
    if (input.existing.action === input.action) {
      return { ok: true, value: { record: input.existing, write: 'reuse' } };
    }
    return { ok: false, refusal: 'conflict', detail: 'terminal' };
  }

  const record: JsaGovernedRecord = {
    ...input.existing,
    state: 'completed',
    action: input.action,
    completedAtMs: input.nowMs,
  };
  return { ok: true, value: { record, write: 'complete' } };
}

/**
 * The MINIMUM authoritative workflow context WB-JSA needs before showing
 * any Read/Acknowledge UI. Deliberately CARRIES NO BINDING DATA: no
 * driverId, companyId, periodId, originLocalDate, names, credentials, or
 * tokens — the caller's session already proved who it is, and the shift
 * facts live in its own SsoJsaBinding from the exchange. What the client
 * may NOT invent — the registered intent — is exactly what this returns.
 */
export interface RequestContextView {
  requestId: string;
  state: 'pending' | 'completed';
  /** THE workflow selector. Launch hints are never authority; this is. */
  intent: JsaPolicyIntent;
  jobRef: string;
  groupRef: string | null;
  /** Pending only — UI countdown information, never authority. */
  expiresAtMs?: number;
  /** Completed only — supports safe idempotent resume after a crash. */
  action?: JsaCompletionAction;
  /**
   * Pending read-stage only — server-resolved invoice well. Never a
   * launch hint. Absent on acknowledge-only and completed views.
   */
  wellName?: string;
  /** Pending read-stage only — invoice commodityType when present. */
  jobType?: string;
}

/**
 * Side-effect-free context read for the JSA audience. Never writes;
 * repeatable across process death/background/resume by construction.
 *
 * `binding` is the CURRENT canonically-authored authority binding — the
 * caller re-runs decideJsaAccess before asking — and it must agree
 * exactly with the binding frozen at registration: any drift (opened or
 * closed shift, different period — the June-cache-vs-August case — or a
 * tightened OR loosened policy flag) refuses rather than letting a
 * request registered under one authority context be worked under
 * another. Fail closed; the driver relaunches from WB-T.
 */
export function decideGetContext(input: {
  existing: JsaGovernedRecord | null;
  requestId: string;
  principal: AuthPrincipal;
  binding: JsaAuthorityBinding;
  nowMs: number;
}): Decision<RequestContextView> {
  if (!input.existing) return { ok: false, refusal: 'not_found', detail: 'missing' };
  if (input.existing.requestId !== input.requestId) {
    return { ok: false, refusal: 'not_found', detail: 'id' };
  }
  if (input.existing.driverId !== input.principal.driverId
    || input.existing.companyId !== input.principal.companyId) {
    return { ok: false, refusal: 'binding_mismatch', detail: 'actor' };
  }
  if (!bindingsEqual(input.existing.binding, input.binding)) {
    return { ok: false, refusal: 'binding_mismatch', detail: 'shift' };
  }
  const state = liveState(input.existing, input.nowMs);
  if (state === 'expired') return { ok: false, refusal: 'expired', detail: 'ttl' };
  if (state === 'completed') {
    if (!input.existing.action) {
      return { ok: false, refusal: 'not_found', detail: 'state' };
    }
    return {
      ok: true,
      value: {
        requestId: input.existing.requestId,
        state: 'completed',
        intent: input.existing.intent,
        jobRef: input.existing.jobRef,
        groupRef: input.existing.groupRef,
        action: input.existing.action,
      },
    };
  }
  return {
    ok: true,
    value: {
      requestId: input.existing.requestId,
      state: 'pending',
      intent: input.existing.intent,
      jobRef: input.existing.jobRef,
      groupRef: input.existing.groupRef,
      expiresAtMs: input.existing.expiresAtMs,
    },
  };
}

/** Read-stage intents need an invoice well before Job Details may render. */
export function jobDisplayRequired(view: Pick<RequestContextView, 'intent' | 'state'>): boolean {
  return view.state === 'pending'
    && (view.intent === 'read' || view.intent === 'read_and_acknowledge');
}

export interface InvoiceJobSnapshot {
  exists: boolean;
  companyId?: unknown;
  company?: unknown;
  driverId?: unknown;
  assignedDriverId?: unknown;
  driverHash?: unknown;
  wellName?: unknown;
  commodityType?: unknown;
}

export interface InvoiceJobFields {
  wellName: string;
  jobType?: string;
}

function boundedDisplay(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t || t.length > max) return null;
  return t;
}

function invoiceCompanyOf(inv: InvoiceJobSnapshot): string | null {
  if (typeof inv.companyId === 'string' && inv.companyId.trim()) return inv.companyId.trim();
  if (typeof inv.company === 'string' && inv.company.trim()) return inv.company.trim();
  return null;
}

function invoiceDriverMatches(inv: InvoiceJobSnapshot, expectedDriverId: string): boolean {
  const ids = [inv.driverId, inv.assignedDriverId, inv.driverHash];
  return ids.some((id) => typeof id === 'string' && id === expectedDriverId);
}

function invoiceHasDriverIdentifier(inv: InvoiceJobSnapshot): boolean {
  return [inv.driverId, inv.assignedDriverId, inv.driverHash]
    .some((id) => typeof id === 'string' && id.length > 0);
}

/**
 * Bind a request-authorized jobRef to invoice display fields.
 * Missing, empty, foreign, or unverifiable invoices all refuse
 * `not_found` so a foreign document's existence is not leaked.
 */
export function decideInvoiceJobFields(input: {
  expectedCompanyId: string;
  expectedDriverId: string;
  invoice: InvoiceJobSnapshot;
}): Decision<InvoiceJobFields> {
  const hidden: Decision<InvoiceJobFields> = { ok: false, refusal: 'not_found', detail: 'job' };
  if (!input.invoice.exists) return hidden;
  const company = invoiceCompanyOf(input.invoice);
  if (!company || company !== input.expectedCompanyId) return hidden;
  if (!invoiceHasDriverIdentifier(input.invoice)) return hidden;
  if (!invoiceDriverMatches(input.invoice, input.expectedDriverId)) return hidden;
  const wellName = boundedDisplay(input.invoice.wellName, JSA_WELL_NAME_MAX);
  if (!wellName) return hidden;
  const jobType = input.invoice.commodityType === undefined || input.invoice.commodityType === null
    || input.invoice.commodityType === ''
    ? undefined
    : boundedDisplay(input.invoice.commodityType, JSA_JOB_TYPE_MAX);
  if (input.invoice.commodityType !== undefined
    && input.invoice.commodityType !== null
    && input.invoice.commodityType !== ''
    && !jobType) {
    return hidden;
  }
  return {
    ok: true,
    value: jobType ? { wellName, jobType } : { wellName },
  };
}

export function applyJobDisplayFields(
  view: RequestContextView,
  fields: InvoiceJobFields,
): RequestContextView {
  return {
    ...view,
    wellName: fields.wellName,
    ...(fields.jobType ? { jobType: fields.jobType } : {}),
  };
}

export interface ConsumeView {
  requestId: string;
  state: 'completed';
  action: JsaCompletionAction;
  jobRef: string;
  groupRef: string | null;
  shiftState: JsaShiftState;
  periodId?: string;
  originLocalDate?: string;
  alreadyConsumed: boolean;
}

export function decideConsume(input: {
  existing: JsaGovernedRecord | null;
  requestId: string;
  principal: AuthPrincipal;
  expectedJobRef?: string;
  expectedGroupRef?: string | null;
  nowMs: number;
}): Decision<{ view: ConsumeView; write: 'mark' | 'none' }> {
  if (!input.existing) return { ok: false, refusal: 'not_found', detail: 'missing' };
  if (input.existing.driverId !== input.principal.driverId
    || input.existing.companyId !== input.principal.companyId) {
    return { ok: false, refusal: 'binding_mismatch', detail: 'actor' };
  }
  if (input.expectedJobRef && input.existing.jobRef !== input.expectedJobRef) {
    return { ok: false, refusal: 'job_mismatch', detail: 'jobRef' };
  }
  if (input.expectedGroupRef !== undefined
    && (input.existing.groupRef || null) !== (input.expectedGroupRef || null)) {
    return { ok: false, refusal: 'job_mismatch', detail: 'groupRef' };
  }
  const state = liveState(input.existing, input.nowMs);
  if (state === 'expired') return { ok: false, refusal: 'expired', detail: 'ttl' };
  if (state === 'pending') return { ok: false, refusal: 'pending', detail: 'incomplete' };
  if (state !== 'completed' || !input.existing.action) {
    return { ok: false, refusal: 'not_found', detail: 'state' };
  }
  const already = input.existing.wbtConsumedAtMs != null;
  const view: ConsumeView = {
    requestId: input.existing.requestId,
    state: 'completed',
    action: input.existing.action,
    jobRef: input.existing.jobRef,
    groupRef: input.existing.groupRef,
    shiftState: input.existing.binding.shiftState,
    ...(input.existing.binding.periodId ? { periodId: input.existing.binding.periodId } : {}),
    ...(input.existing.binding.originLocalDate
      ? { originLocalDate: input.existing.binding.originLocalDate }
      : {}),
    alreadyConsumed: already,
  };
  return { ok: true, value: { view, write: already ? 'none' : 'mark' } };
}

export function toStored(record: JsaGovernedRecord): Record<string, unknown> {
  return {
    requestId: record.requestId,
    jobRef: record.jobRef,
    groupRef: record.groupRef,
    intent: record.intent,
    driverId: record.driverId,
    companyId: record.companyId,
    binding: record.binding,
    state: record.state,
    action: record.action,
    receiptHandle: record.receiptHandle,
    createdAtMs: record.createdAtMs,
    expiresAtMs: record.expiresAtMs,
    completedAtMs: record.completedAtMs,
    wbtConsumedAtMs: record.wbtConsumedAtMs,
  };
}

export function fromStored(v: unknown): JsaGovernedRecord | null {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;
  if (!isRequestId(o.requestId) || !isJobRef(o.jobRef) || !isPolicyIntent(o.intent)) return null;
  if (typeof o.driverId !== 'string' || typeof o.companyId !== 'string') return null;
  const binding = o.binding as JsaAuthorityBinding | undefined;
  if (!binding || (binding.shiftState !== 'open' && binding.shiftState !== 'none')) return null;
  if (o.state !== 'pending' && o.state !== 'completed' && o.state !== 'expired') return null;
  return {
    requestId: o.requestId,
    jobRef: o.jobRef,
    groupRef: typeof o.groupRef === 'string' ? o.groupRef : null,
    intent: o.intent,
    driverId: o.driverId,
    companyId: o.companyId,
    binding,
    state: o.state,
    action: isCompletionAction(o.action) ? o.action : null,
    receiptHandle: typeof o.receiptHandle === 'string' ? o.receiptHandle : '',
    createdAtMs: Number(o.createdAtMs) || 0,
    expiresAtMs: Number(o.expiresAtMs) || 0,
    completedAtMs: typeof o.completedAtMs === 'number' ? o.completedAtMs : null,
    wbtConsumedAtMs: typeof o.wbtConsumedAtMs === 'number' ? o.wbtConsumedAtMs : null,
  };
}
