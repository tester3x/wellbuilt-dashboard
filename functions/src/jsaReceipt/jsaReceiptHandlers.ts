/**
 * Register / complete / consume handlers. Identity from Auth + authority
 * records. Storage via injected transaction.
 */
import { decideJsaBinding, type JsaBindingShape } from '../sso/jsaAuthorization.js';
import type { ResolveResult } from '../security/operational/shiftAuthority.js';
import {
  decideComplete,
  decideConsume,
  decideRegister,
  fromStored,
  parseAuthPrincipal,
  parseCompleteInput,
  parseConsumeInput,
  parseRegisterInput,
  recordPath,
  requireAudience,
  toStored,
  JSA_APP_JSA,
  JSA_APP_WBT,
  type AuthPrincipal,
  type ConsumeView,
  type Decision,
  type JsaAuthorityBinding,
  type JsaCompanyPolicy,
  type JsaGovernedRecord,
  type ReceiptRefusal,
} from './jsaReceiptCore.js';

export class JsaReceiptError extends Error {
  constructor(
    public readonly http: 'unauthenticated' | 'permission-denied' | 'invalid-argument' | 'failed-precondition' | 'already-exists',
    public readonly refusal: ReceiptRefusal,
    detail: string,
  ) {
    super(detail);
    this.name = 'JsaReceiptError';
  }
}

export interface ReceiptTxn {
  get(path: string): Promise<{ exists: boolean; data?: Record<string, unknown> }>;
  create(path: string, data: Record<string, unknown>): void;
  update(path: string, fields: Record<string, unknown>): void;
}

export interface ReceiptDeps {
  nowMs(): number;
  randomBytes(n: number): Uint8Array;
  base64Url(bytes: Uint8Array): string;
  getJsaPolicy(companyId: string): Promise<JsaCompanyPolicy>;
  resolveShift(driverId: string, companyId: string): Promise<ResolveResult>;
  runTransaction<T>(fn: (txn: ReceiptTxn) => Promise<T>): Promise<T>;
  log(event: string, extra: Record<string, string>): void;
}

function throwDecision(d: Decision<unknown>): never {
  const map: Record<ReceiptRefusal, JsaReceiptError['http']> = {
    unauthenticated: 'unauthenticated',
    wrong_audience: 'permission-denied',
    not_a_driver: 'permission-denied',
    malformed: 'invalid-argument',
    client_identity: 'invalid-argument',
    jsa_disabled: 'permission-denied',
    active_shift_required: 'permission-denied',
    authority_unverifiable: 'permission-denied',
    intent_not_permitted: 'failed-precondition',
    collision: 'already-exists',
    not_found: 'failed-precondition',
    expired: 'failed-precondition',
    pending: 'failed-precondition',
    binding_mismatch: 'permission-denied',
    job_mismatch: 'failed-precondition',
    action_not_permitted: 'failed-precondition',
    conflict: 'failed-precondition',
    already_consumed: 'failed-precondition',
  };
  throw new JsaReceiptError(map[d.refusal], d.refusal, d.detail);
}

function unwrap<T>(d: Decision<T>): T {
  if (!d.ok) throwDecision(d);
  return d.value;
}

function principal(auth: { uid?: string | null; claims?: Record<string, unknown> | null }, audience: string): AuthPrincipal {
  const p = unwrap(parseAuthPrincipal(auth));
  unwrap(requireAudience(p, audience));
  return p;
}

async function authorBinding(
  deps: ReceiptDeps,
  p: AuthPrincipal,
): Promise<{ binding: JsaAuthorityBinding; policy: JsaCompanyPolicy }> {
  const policy = await deps.getJsaPolicy(p.companyId);
  const shift = await deps.resolveShift(p.driverId, p.companyId);
  const decided = decideJsaBinding({
    shift,
    requiresActiveShift: policy.requiresActiveShift,
    jsaEnabled: policy.jsaEnabled,
  });
  if (!decided.ok) {
    throw new JsaReceiptError(
      'permission-denied',
      decided.refusal === 'active_shift_required' ? 'active_shift_required' : 'authority_unverifiable',
      decided.detail,
    );
  }
  return { binding: decided.binding as JsaBindingShape, policy };
}

export async function handleRegister(
  deps: ReceiptDeps,
  auth: { uid?: string | null; claims?: Record<string, unknown> | null },
  data: unknown,
): Promise<{ requestId: string; state: 'pending' | 'completed'; reused: boolean }> {
  const p = principal(auth, JSA_APP_WBT);
  const meta = unwrap(parseRegisterInput(data));
  const { binding, policy } = await authorBinding(deps, p);
  return deps.runTransaction(async (txn) => {
    const path = recordPath(meta.requestId);
    const snap = await txn.get(path);
    const existing = snap.exists ? fromStored(snap.data) : null;
    const handle = deps.base64Url(deps.randomBytes(32));
    const decided = decideRegister({
      existing,
      meta,
      principal: p,
      binding,
      policy,
      nowMs: deps.nowMs(),
      receiptHandle: handle,
    });
    const out = unwrap(decided);
    if (out.write === 'create') {
      txn.create(path, toStored(out.record));
    }
    deps.log('jsa.receipt.register', { write: out.write, intent: meta.intent });
    return {
      requestId: out.record.requestId,
      state: out.record.state === 'completed' ? 'completed' : 'pending',
      reused: out.write === 'reuse',
    };
  });
}

export async function handleComplete(
  deps: ReceiptDeps,
  auth: { uid?: string | null; claims?: Record<string, unknown> | null },
  data: unknown,
): Promise<{ requestId: string; action: string; reused: boolean }> {
  const p = principal(auth, JSA_APP_JSA);
  const body = unwrap(parseCompleteInput(data));
  const { binding } = await authorBinding(deps, p);
  return deps.runTransaction(async (txn) => {
    const path = recordPath(body.requestId);
    const snap = await txn.get(path);
    const existing = snap.exists ? fromStored(snap.data) : null;
    const decided = decideComplete({
      existing,
      requestId: body.requestId,
      action: body.action,
      principal: p,
      binding,
      nowMs: deps.nowMs(),
    });
    const out = unwrap(decided);
    if (out.write === 'complete') {
      txn.update(path, {
        state: out.record.state,
        action: out.record.action,
        completedAtMs: out.record.completedAtMs,
      });
    }
    deps.log('jsa.receipt.complete', { write: out.write, action: body.action });
    return { requestId: out.record.requestId, action: body.action, reused: out.write === 'reuse' };
  });
}

export async function handleConsume(
  deps: ReceiptDeps,
  auth: { uid?: string | null; claims?: Record<string, unknown> | null },
  data: unknown,
): Promise<ConsumeView> {
  const p = principal(auth, JSA_APP_WBT);
  const body = unwrap(parseConsumeInput(data));
  return deps.runTransaction(async (txn) => {
    const path = recordPath(body.requestId);
    const snap = await txn.get(path);
    const existing = snap.exists ? fromStored(snap.data) : null;
    const decided = decideConsume({
      existing,
      requestId: body.requestId,
      principal: p,
      nowMs: deps.nowMs(),
    });
    const out = unwrap(decided);
    if (out.write === 'mark') {
      txn.update(path, { wbtConsumedAtMs: deps.nowMs() });
    }
    deps.log('jsa.receipt.consume', { write: out.write });
    return out.view;
  });
}
