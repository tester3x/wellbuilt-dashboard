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
  decideGetContext,
  decideInvoiceJobFields,
  applyJobDisplayFields,
  jobDisplayRequired,
  decideRegister,
  fromStored,
  parseAuthPrincipal,
  parseCompleteInput,
  parseConsumeInput,
  parseGetContextInput,
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
import {
  artifactPath,
  canonicalizeAuthoredSnapshot,
  decideInvoiceArtifactBinding,
  decidePersist,
  decodeSignaturePng,
  encodeCanonicalBase64,
  fromStoredArtifact,
  parseAuthoredSnapshot,
  parsePersistInput,
  persistView,
  toStoredArtifact,
  type PersistView,
} from './jsaArtifactCore.js';

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
  /**
   * Admin invoice lookup. Called only AFTER request authorization
   * accepted a pending read-stage get. Never before.
   */
  readInvoice(jobRef: string): Promise<{ exists: boolean; data?: Record<string, unknown> }>;
  runTransaction<T>(fn: (txn: ReceiptTxn) => Promise<T>): Promise<T>;
  log(event: string, extra: Record<string, string>): void;
}

/** Persist-only I/O. Existing register/complete/consume deps stay unchanged. */
export interface ArtifactDeps extends ReceiptDeps {
  sha256Hex(bytes: Uint8Array): string;
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
    not_owner: 'permission-denied',
    no_qualifying_read: 'failed-precondition',
    period_unverifiable: 'failed-precondition',
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

/**
 * jsaGetReadRequest — the authoritative workflow-context read for the
 * JSA audience. Repeatable and SIDE-EFFECT FREE: nothing is written,
 * marked, or consumed, so process death / background / resume can call
 * it any number of times. The canonical current access decision runs
 * first (same decideJsaAccess as issuance/registration/completion), so a
 * policy tightened, a shift drifted, or JSA disabled since registration
 * refuses here — BEFORE any Read/Acknowledge UI is shown.
 */
export async function handleGetContext(
  deps: ReceiptDeps,
  auth: { uid?: string | null; claims?: Record<string, unknown> | null },
  data: unknown,
): Promise<import('./jsaReceiptCore.js').RequestContextView> {
  const p = principal(auth, JSA_APP_JSA);
  const body = unwrap(parseGetContextInput(data));
  const { binding } = await authorBinding(deps, p);
  const path = recordPath(body.requestId);
  const out = await deps.runTransaction(async (txn) => {
    const snap = await txn.get(path);
    const existing = snap.exists ? fromStored(snap.data) : null;
    const decided = decideGetContext({
      existing,
      requestId: body.requestId,
      principal: p,
      binding,
      nowMs: deps.nowMs(),
    });
    return unwrap(decided);
  });
  if (!jobDisplayRequired(out)) {
    deps.log('jsa.receipt.get', { state: out.state, intent: out.intent });
    return out;
  }
  const invoice = await deps.readInvoice(out.jobRef);
  const fields = decideInvoiceJobFields({
    expectedCompanyId: p.companyId,
    expectedDriverId: p.driverId,
    invoice: {
      exists: invoice.exists,
      ...(invoice.data || {}),
    },
  });
  const resolved = unwrap(fields);
  const view = applyJobDisplayFields(out, resolved);
  deps.log('jsa.receipt.get', { state: view.state, intent: view.intent });
  return view;
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

/**
 * jsaPersistGovernedArtifact — first immutable write of a completed
 * request's bounded authored snapshot. Identity/job/shift/well come
 * from the server-held request + its request-bound invoice. The
 * current shift is not re-authored: a completed record is already
 * terminal evidence. Signature PNG bytes are stored inside the
 * Admin-only Firestore document — never in Storage — so the open
 * storage.rules surface cannot mutate them.
 */
export async function handlePersist(
  deps: ArtifactDeps,
  auth: { uid?: string | null; claims?: Record<string, unknown> | null },
  data: unknown,
): Promise<PersistView> {
  const p = principal(auth, JSA_APP_JSA);
  const body = unwrap(parsePersistInput(data));
  const authored = unwrap(parseAuthoredSnapshot(body.snapshot));
  const decoded = unwrap(decodeSignaturePng(
    (body.snapshot as { signature?: unknown }).signature,
  ));
  const signatureSha256 = deps.sha256Hex(decoded.bytes);
  const signature = {
    mimeType: decoded.mimeType,
    encoding: 'base64' as const,
    byteSize: decoded.bytes.length,
    sha256: signatureSha256,
    dataBase64: encodeCanonicalBase64(decoded.bytes),
  };
  const snapshotHash = deps.sha256Hex(Buffer.from(
    canonicalizeAuthoredSnapshot(authored, signature),
    'utf8',
  ));

  const reqPath = recordPath(body.requestId);
  const artPath = artifactPath(body.requestId);

  const loaded = await deps.runTransaction(async (txn) => {
    const reqSnap = await txn.get(reqPath);
    const artSnap = await txn.get(artPath);
    return {
      request: reqSnap.exists ? fromStored(reqSnap.data) : null,
      artifact: artSnap.exists ? fromStoredArtifact(artSnap.data) : null,
    };
  });

  if (loaded.artifact) {
    const decided = decidePersist({
      existingRequest: loaded.request,
      existingArtifact: loaded.artifact,
      requestId: body.requestId,
      principal: p,
      snapshotHash,
      signatureSha256,
      nowMs: deps.nowMs(),
      uid: p.uid,
      wellName: loaded.artifact.wellName,
      jobType: loaded.artifact.jobType,
      authored,
      signature,
    });
    const out = unwrap(decided);
    deps.log('jsa.receipt.persist', { write: out.write });
    return persistView(out.artifact, out.write === 'reuse');
  }

  const gate = decidePersist({
    existingRequest: loaded.request,
    existingArtifact: null,
    requestId: body.requestId,
    principal: p,
    snapshotHash,
    signatureSha256,
    nowMs: deps.nowMs(),
    uid: p.uid,
    wellName: 'pending-invoice',
    authored,
    signature,
  });
  unwrap(gate);

  const request = loaded.request!;
  const invoice = await deps.readInvoice(request.jobRef);
  const fields = unwrap(decideInvoiceArtifactBinding({
    requestJobRef: request.jobRef,
    loadedJobRef: request.jobRef,
    requestCompanyId: request.companyId,
    requestDriverId: request.driverId,
    invoice: { exists: invoice.exists, ...(invoice.data || {}) },
  }));

  return deps.runTransaction(async (txn) => {
    const reqSnap = await txn.get(reqPath);
    const existingRequest = reqSnap.exists ? fromStored(reqSnap.data) : null;
    const artSnap = await txn.get(artPath);
    const existingArtifact = artSnap.exists ? fromStoredArtifact(artSnap.data) : null;
    const decided = decidePersist({
      existingRequest,
      existingArtifact,
      requestId: body.requestId,
      principal: p,
      snapshotHash,
      signatureSha256,
      nowMs: deps.nowMs(),
      uid: p.uid,
      wellName: fields.wellName,
      jobType: fields.jobType,
      authored,
      signature,
    });
    const out = unwrap(decided);
    if (out.write === 'create') {
      txn.create(artPath, toStoredArtifact(out.artifact));
    }
    deps.log('jsa.receipt.persist', { write: out.write });
    return persistView(out.artifact, out.write === 'reuse');
  });
}
