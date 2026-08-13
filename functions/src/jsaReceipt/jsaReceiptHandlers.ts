/**
 * Register / complete / consume handlers. Identity from Auth + authority
 * records. Storage via injected transaction.
 *
 * POLICY HAS ONE SOURCE. Registration and completion decide JSA access
 * through decideJsaAccess — the SAME canonical function the SSO issuance
 * handler uses — over the SAME authoritative inputs (contract state,
 * commercial plan inclusion, company app configuration, shift
 * authority). The older company-doc-only policy interpretation is gone
 * from the entitlement dimensions; the company doc contributes ONLY the
 * completion-style policy (allowRead/allowAcknowledge), which is
 * operational UI policy, not entitlement.
 */
import type { PlanDefinition } from '@tester3x/wellbuilt-contracts';
import { decideJsaAccess } from '../sso/jsaAuthorization.js';
import type { WellbuiltContract, CompanyContractState } from '../admin/companyContract.js';
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
  type ReceiptRefusal,
} from './jsaReceiptCore.js';

export type JsaReceiptHttp =
  | 'unauthenticated' | 'permission-denied' | 'invalid-argument'
  | 'failed-precondition' | 'already-exists';

// Erasable-syntax only (no constructor parameter properties) so the
// harness can execute this module under node --experimental-strip-types.
export class JsaReceiptError extends Error {
  readonly http: JsaReceiptHttp;
  readonly refusal: ReceiptRefusal;

  constructor(http: JsaReceiptHttp, refusal: ReceiptRefusal, detail: string) {
    super(detail);
    this.name = 'JsaReceiptError';
    this.http = http;
    this.refusal = refusal;
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
  /** SAME reader the SSO issuance deps use — canonical contract parsing. */
  getCompanyContract(companyId: string): Promise<{
    state: CompanyContractState['state'];
    contract: WellbuiltContract | null;
  }>;
  /** SAME reader the SSO issuance deps use. */
  getPlan(planId: string): Promise<PlanDefinition | null>;
  /**
   * Completion-STYLE policy only (which completion interactions the
   * company's JSA workflow offers). Deliberately NOT entitlement: it can
   * narrow the intent surface but can never enable JSA, waive a shift
   * gate, or otherwise widen what decideJsaAccess decided.
   */
  getJsaStylePolicy(companyId: string): Promise<{
    allowRead: boolean;
    allowAcknowledge: boolean;
  }>;
  resolveShift(driverId: string, companyId: string): Promise<ResolveResult>;
  runTransaction<T>(fn: (txn: ReceiptTxn) => Promise<T>): Promise<T>;
  log(event: string, extra: Record<string, string>): void;
}

function throwDecision(d: Decision<unknown> & { ok: false }): never {
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
  // THE canonical decision — identical inputs and identical function to
  // SSO issuance, so registration and issuance agree byte-for-byte.
  const contractState = await deps.getCompanyContract(p.companyId);
  const plan = contractState.contract
    ? await deps.getPlan(contractState.contract.planId)
    : null;
  const shift = await deps.resolveShift(p.driverId, p.companyId);
  const access = decideJsaAccess({
    contractState: contractState.state,
    contract: contractState.contract,
    plan,
    shift,
  });
  if (!access.ok) {
    // Bounded mapping; the precise canonical reason stays in `detail` for
    // the operator log, the client sees the coarse refusal class.
    const refusal =
      access.refusal === 'active_shift_required' ? 'active_shift_required'
        : access.refusal === 'authority_unverifiable' ? 'authority_unverifiable'
          : 'jsa_disabled';
    throw new JsaReceiptError('permission-denied', refusal, access.detail);
  }
  const style = await deps.getJsaStylePolicy(p.companyId);
  return {
    binding: access.binding,
    policy: {
      jsaEnabled: access.jsaEnabled,
      requiresActiveShift: access.requiresActiveShift,
      allowRead: style.allowRead,
      allowAcknowledge: style.allowAcknowledge,
    },
  };
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
