/**
 * Governed job-packet publication (G-008). Source-only control plane.
 * Packet meaning is Contracts 0.7.0 definitionSchema. Hashes/IDs reuse G-005.
 */
import { validate, definitionSchema } from '@tester3x/wellbuilt-contracts/transport';
import {
  INDEX_COLLECTION,
  PACKAGE_ID_RE,
  SERVER_IMPLEMENTED_EFFECTS,
  encodeLengthPrefixedParts,
  fail,
  persistJobPacketRevision,
  revisionDocId,
  validatePublishInput,
  validateStoredRevisionForBinding,
  type RevisionStoreTx,
  type StoreResult,
} from './jobPacketRevisionStore';
import type { TrustedCompanyAuthority } from '../trustedStaffAuthority';

export const PUBLISH_JOB_PACKET_REVISION_CALLABLE = 'publishJobPacketRevision';
export const RECEIPT_COLLECTION = 'job_packet_publication_receipts';
export const HEAD_COLLECTION = INDEX_COLLECTION;

export const PUBLISH_REQUEST_KEYS = Object.freeze([
  'requestId',
  'expectedLatestRevision',
  'packetDraft',
] as const);

export const PUBLISH_FORBIDDEN_KEYS = Object.freeze([
  'companyId',
  'publisherUid',
  'publishedBy',
  'publishedByUid',
  'publisher',
  'revision',
  'contentHash',
  'policyHash',
  'implementedEffects',
  'publishedAt',
  'createdAt',
  'status',
  'targetCompanyId',
  'packageId',
  'packetRevision',
  'schemaVersion',
  'hashSchemaVersion',
  'hashAlgorithm',
  'supersedes',
  'latest',
] as const);

/** Contracts definition requires schemaVersion. Authority fields remain forbidden on the draft. */
const DRAFT_FORBIDDEN_KEYS = Object.freeze(
  (PUBLISH_FORBIDDEN_KEYS as readonly string[]).filter((k) => k !== 'schemaVersion'),
);

const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_DRAFT_CHARS = 200_000;
const POLICY_CONFIG_KEYS = Object.freeze([
  'allocationPolicy',
  'activationPolicy',
  'authorityPolicy',
  'evidencePolicy',
] as const);

export type PublishResult = 'created' | 'unchanged';

export type PublicationHead = {
  schemaVersion: 1;
  companyId: string;
  packageId: string;
  latestRevision: number;
  contentHash: string;
  policyHash: string;
  updatedByUid: string;
  updatedAt: unknown;
};

export type PublicationReceiptDoc = {
  schemaVersion: 1;
  companyId: string;
  packageId: string;
  requestId: string;
  fingerprint: string;
  revision: number;
  contentHash: string;
  policyHash: string;
  result: PublishResult;
  publishedByUid: string;
  publishedAt: unknown;
};

export type PublishStoreTx = RevisionStoreTx & {
  getHead(docId: string): Promise<Record<string, unknown> | null>;
  createHead(docId: string, data: Record<string, unknown>): void;
  updateHead(docId: string, data: Record<string, unknown>): void;
  getReceipt(docId: string): Promise<Record<string, unknown> | null>;
  createReceipt(docId: string, data: Record<string, unknown>): void;
};

export function packageIndexDocId(companyId: string, packageId: string): string {
  return encodeLengthPrefixedParts([companyId, packageId]);
}

export function publicationReceiptDocId(companyId: string, packageId: string, requestId: string): string {
  return encodeLengthPrefixedParts([companyId, packageId, requestId]);
}

export function decidePublishStaffAccess(
  caller: TrustedCompanyAuthority | null,
): StoreResult<{ companyId: string; publisherUid: string }> {
  if (!caller?.uid) return fail('unauthenticated');
  const companyId = typeof caller.companyId === 'string' ? caller.companyId.trim() : '';
  if (!companyId) return fail('missing_company');
  if (!PACKAGE_ID_RE.test(companyId)) return fail('malformed_id', 'companyId');
  return { ok: true, companyId, publisherUid: caller.uid };
}

function asRecord(raw: unknown, field: string): StoreResult<{ value: Record<string, unknown> }> {
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('record_must_be_object', field);
  }
  return { ok: true, value: raw as Record<string, unknown> };
}

function rejectForbidden(obj: Record<string, unknown>, prefix: string): StoreResult<{ ok: true }> {
  for (const key of Object.keys(obj)) {
    if ((PUBLISH_FORBIDDEN_KEYS as readonly string[]).includes(key)) {
      return fail('caller_authority_field', prefix ? `${prefix}.${key}` : key);
    }
  }
  return { ok: true };
}

export function parsePublishRequest(raw: unknown): StoreResult<{
  requestId: string;
  expectedLatestRevision: number;
  packetDraft: unknown;
}> {
  const rec = asRecord(raw, 'request');
  if (!rec.ok) return rec;
  const forbidden = rejectForbidden(rec.value, '');
  if (!forbidden.ok) return forbidden;
  for (const key of Object.keys(rec.value)) {
    if (rec.value[key] === undefined) continue;
    if (!(PUBLISH_REQUEST_KEYS as readonly string[]).includes(key)) {
      return fail('unknown_field', key);
    }
  }
  const requestId = typeof rec.value.requestId === 'string' ? rec.value.requestId.trim() : '';
  if (!requestId || !REQUEST_ID_RE.test(requestId) || requestId.includes('/')) {
    return fail('malformed_request_id', 'requestId');
  }
  const expected = rec.value.expectedLatestRevision;
  if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 0) {
    return fail('malformed_expected_revision', 'expectedLatestRevision');
  }
  if (expected === Number.POSITIVE_INFINITY) return fail('malformed_expected_revision', 'expectedLatestRevision');
  if (!Object.prototype.hasOwnProperty.call(rec.value, 'packetDraft')) {
    return fail('packet_draft_required', 'packetDraft');
  }
  if (rec.value.packetDraft === 'latest') return fail('latest_rejected', 'packetDraft');
  return { ok: true, requestId, expectedLatestRevision: expected, packetDraft: rec.value.packetDraft };
}

function rejectDraftAuthority(draft: unknown): StoreResult<{ ok: true }> {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return { ok: true };
  const obj = draft as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if ((DRAFT_FORBIDDEN_KEYS as readonly string[]).includes(key)) {
      return fail('caller_authority_field', `packetDraft.${key}`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(obj, 'execution')) {
    return fail('execution_not_persisted', 'packetDraft.execution');
  }
  return { ok: true };
}

function contractsDraft(raw: unknown): StoreResult<{
  packetId: string;
  industryId: string;
  segmentId: string;
  jobTypes: unknown;
  capabilities: unknown;
  definition: Record<string, unknown>;
}> {
  const authority = rejectDraftAuthority(raw);
  if (!authority.ok) return authority;
  let serialized = '';
  try {
    serialized = JSON.stringify(raw);
  } catch {
    return fail('oversized_draft', 'packetDraft');
  }
  if (!serialized || serialized.length > MAX_DRAFT_CHARS) return fail('oversized_draft', 'packetDraft');
  const checked = validate(definitionSchema, raw);
  if (!checked.ok) return fail(`contracts_${checked.code}`, checked.path);
  const def = checked.value;
  const policyGate = rejectNonemptyPolicyRefs(def.capabilities as unknown[]);
  if (!policyGate.ok) return policyGate;
  return {
    ok: true,
    packetId: def.packetId,
    industryId: def.industryId,
    segmentId: def.segmentId,
    jobTypes: def.jobTypes,
    capabilities: def.capabilities,
    definition: JSON.parse(JSON.stringify(def)) as Record<string, unknown>,
  };
}

function rejectNonemptyPolicyRefs(capabilities: unknown[]): StoreResult<{ ok: true }> {
  for (let i = 0; i < capabilities.length; i++) {
    const cap = capabilities[i];
    if (!cap || typeof cap !== 'object' || Array.isArray(cap)) continue;
    const cfg = (cap as { configuration?: unknown }).configuration;
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) continue;
    for (const key of Object.keys(cfg as Record<string, unknown>)) {
      if ((POLICY_CONFIG_KEYS as readonly string[]).includes(key)) {
        return fail('policy_refs_not_empty', `packetDraft.capabilities[${i}].configuration.${key}`);
      }
      const val = (cfg as Record<string, unknown>)[key];
      if (val && typeof val === 'object' && !Array.isArray(val) && 'policyId' in (val as object)) {
        return fail('unknown_policy_reference', `packetDraft.capabilities[${i}].configuration.${key}`);
      }
    }
  }
  return { ok: true };
}

function storePayload(
  def: {
    packetId: string;
    industryId: string;
    segmentId: string;
    jobTypes: unknown;
    capabilities: unknown;
    definition: Record<string, unknown>;
  },
  revision: number,
  supersedes: { packageId: string; revision: number; contentHash: string } | null,
): Record<string, unknown> {
  return {
    packageId: def.packetId,
    revision,
    displayVersion: `${revision}.0.0`,
    industryId: def.industryId,
    segmentId: def.segmentId,
    jobTypes: def.jobTypes,
    capabilities: def.capabilities,
    policyRefs: [],
    definition: def.definition,
    supersedes,
  };
}

function readHead(
  raw: Record<string, unknown> | null,
  expected: { companyId: string; packageId: string },
): StoreResult<{ present: false } | { present: true; latestRevision: number; contentHash: string; policyHash: string }> {
  if (!raw) return { ok: true, present: false };
  const companyId = typeof raw.companyId === 'string' ? raw.companyId.trim() : '';
  const packageId = typeof raw.packageId === 'string' ? raw.packageId.trim() : '';
  if (companyId !== expected.companyId) return fail('head_tenant_mismatch', 'companyId');
  if (packageId !== expected.packageId) return fail('head_package_mismatch', 'packageId');
  const latestRevision = typeof raw.latestRevision === 'number' ? raw.latestRevision : NaN;
  const contentHash = typeof raw.contentHash === 'string' ? raw.contentHash.trim() : '';
  const policyHash = typeof raw.policyHash === 'string' ? raw.policyHash.trim() : '';
  if (!Number.isInteger(latestRevision) || latestRevision < 1 || !/^[a-f0-9]{64}$/.test(contentHash) || !/^[a-f0-9]{64}$/.test(policyHash)) {
    return fail('malformed_head', 'head');
  }
  return { ok: true, present: true, latestRevision, contentHash, policyHash };
}

function readReceipt(
  raw: Record<string, unknown> | null,
): StoreResult<{ present: false } | { present: true; doc: PublicationReceiptDoc }> {
  if (!raw) return { ok: true, present: false };
  const companyId = typeof raw.companyId === 'string' ? raw.companyId.trim() : '';
  const packageId = typeof raw.packageId === 'string' ? raw.packageId.trim() : '';
  const requestId = typeof raw.requestId === 'string' ? raw.requestId.trim() : '';
  const fingerprint = typeof raw.fingerprint === 'string' ? raw.fingerprint.trim() : '';
  const revision = typeof raw.revision === 'number' ? raw.revision : NaN;
  const contentHash = typeof raw.contentHash === 'string' ? raw.contentHash.trim() : '';
  const policyHash = typeof raw.policyHash === 'string' ? raw.policyHash.trim() : '';
  const result = raw.result === 'created' || raw.result === 'unchanged' ? raw.result : '';
  const publishedByUid = typeof raw.publishedByUid === 'string' ? raw.publishedByUid : '';
  if (
    !companyId || !packageId || !requestId || !/^[a-f0-9]{64}$/.test(fingerprint)
    || !Number.isInteger(revision) || revision < 1
    || !/^[a-f0-9]{64}$/.test(contentHash) || !/^[a-f0-9]{64}$/.test(policyHash)
    || !result || !publishedByUid
  ) {
    return fail('malformed_receipt', 'receipt');
  }
  return {
    ok: true,
    present: true,
    doc: {
      schemaVersion: 1,
      companyId,
      packageId,
      requestId,
      fingerprint,
      revision,
      contentHash,
      policyHash,
      result,
      publishedByUid,
      publishedAt: raw.publishedAt,
    },
  };
}

export async function runPublishJobPacketRevision(input: {
  caller: TrustedCompanyAuthority | null;
  request: unknown;
  store: PublishStoreTx;
  publishedAt: unknown;
}): Promise<StoreResult<{
  result: PublishResult;
  packageId: string;
  revision: number;
  packetRevision: number;
  contentHash: string;
  policyHash: string;
}>> {
  const access = decidePublishStaffAccess(input.caller);
  if (!access.ok) return access;
  const parsed = parsePublishRequest(input.request);
  if (!parsed.ok) return parsed;
  const def = contractsDraft(parsed.packetDraft);
  if (!def.ok) return def;
  if (!PACKAGE_ID_RE.test(def.packetId)) return fail('malformed_id', 'packetDraft.packetId');

  const preview = validatePublishInput(
    storePayload(def, 1, null),
    { companyId: access.companyId, publishedByUid: access.publisherUid },
  );
  if (!preview.ok) return preview;
  if (JSON.stringify(preview.envelope.implementedEffects) !== JSON.stringify(SERVER_IMPLEMENTED_EFFECTS)) {
    return fail('implemented_effects_mismatch', 'implementedEffects');
  }
  const fingerprint = preview.contentHash;
  const receiptId = publicationReceiptDocId(access.companyId, def.packetId, parsed.requestId);
  const headId = packageIndexDocId(access.companyId, def.packetId);

  const receiptRaw = await input.store.getReceipt(receiptId);
  const existingReceipt = readReceipt(receiptRaw);
  if (!existingReceipt.ok) return existingReceipt;
  if (existingReceipt.present) {
    const rec = existingReceipt.doc;
    if (rec.companyId !== access.companyId) return fail('conflict', 'companyId');
    if (rec.packageId !== def.packetId) return fail('conflict', 'packageId');
    if (rec.requestId !== parsed.requestId) return fail('conflict', 'requestId');
    if (rec.fingerprint !== fingerprint) return fail('conflict', 'requestId');
    const revId = revisionDocId(access.companyId, def.packetId, rec.revision);
    const existingRev = await input.store.getRevision(revId);
    if (!existingRev) return fail('receipt_revision_missing', 'revision');
    const bound = validateStoredRevisionForBinding(existingRev, {
      companyId: access.companyId,
      packageId: def.packetId,
      revision: rec.revision,
    });
    if (!bound.ok) return fail('store_integrity', bound.field || 'revision');
    if (bound.envelope.contentHash !== rec.contentHash || bound.envelope.policyHash !== rec.policyHash) {
      return fail('receipt_hash_mismatch', 'receipt');
    }
    return {
      ok: true,
      result: rec.result,
      packageId: def.packetId,
      revision: rec.revision,
      packetRevision: rec.revision,
      contentHash: rec.contentHash,
      policyHash: rec.policyHash,
    };
  }

  const headRaw = await input.store.getHead(headId);
  const head = readHead(headRaw, { companyId: access.companyId, packageId: def.packetId });
  if (!head.ok) return head;
  const currentLatest = head.present ? head.latestRevision : 0;
  if (currentLatest !== parsed.expectedLatestRevision) {
    return fail('stale_expected_revision', 'expectedLatestRevision');
  }

  let currentHashes: { contentHash: string; policyHash: string; revision: number } | null = null;
  if (head.present) {
    const currentId = revisionDocId(access.companyId, def.packetId, head.latestRevision);
    const currentRaw = await input.store.getRevision(currentId);
    if (!currentRaw) return fail('head_revision_missing', 'latestRevision');
    const bound = validateStoredRevisionForBinding(currentRaw, {
      companyId: access.companyId,
      packageId: def.packetId,
      revision: head.latestRevision,
    });
    if (!bound.ok) return fail('store_integrity', bound.field || 'revision');
    if (bound.envelope.contentHash !== head.contentHash || bound.envelope.policyHash !== head.policyHash) {
      return fail('head_hash_mismatch', 'head');
    }
    currentHashes = {
      contentHash: bound.envelope.contentHash,
      policyHash: bound.envelope.policyHash,
      revision: head.latestRevision,
    };
  }

  if (currentHashes && currentHashes.contentHash === fingerprint && currentHashes.policyHash === preview.envelope.policyHash) {
    const receipt: PublicationReceiptDoc = {
      schemaVersion: 1,
      companyId: access.companyId,
      packageId: def.packetId,
      requestId: parsed.requestId,
      fingerprint,
      revision: currentHashes.revision,
      contentHash: currentHashes.contentHash,
      policyHash: currentHashes.policyHash,
      result: 'unchanged',
      publishedByUid: access.publisherUid,
      publishedAt: input.publishedAt,
    };
    input.store.createReceipt(receiptId, receipt);
    return {
      ok: true,
      result: 'unchanged',
      packageId: def.packetId,
      revision: currentHashes.revision,
      packetRevision: currentHashes.revision,
      contentHash: currentHashes.contentHash,
      policyHash: currentHashes.policyHash,
    };
  }

  const nextRevision = currentLatest + 1;
  const nextId = revisionDocId(access.companyId, def.packetId, nextRevision);
  const collision = await input.store.getRevision(nextId);
  if (collision) return fail('revision_collision', 'revision');
  const supersedes = currentHashes
    ? { packageId: def.packetId, revision: currentHashes.revision, contentHash: currentHashes.contentHash }
    : null;
  const built = validatePublishInput(
    storePayload(def, nextRevision, supersedes),
    { companyId: access.companyId, publishedByUid: access.publisherUid },
  );
  if (!built.ok) return built;
  const persisted = await persistJobPacketRevision(
    input.store,
    { envelope: built.envelope, contentHash: built.contentHash },
    input.publishedAt,
  );
  if (!persisted.ok) return persisted;
  const receipt: PublicationReceiptDoc = {
    schemaVersion: 1,
    companyId: access.companyId,
    packageId: persisted.revision.packageId,
    requestId: parsed.requestId,
    fingerprint,
    revision: persisted.revision.revision,
    contentHash: persisted.revision.contentHash,
    policyHash: persisted.revision.policyHash,
    result: 'created',
    publishedByUid: access.publisherUid,
    publishedAt: input.publishedAt,
  };
  const headDoc: PublicationHead = {
    schemaVersion: 1,
    companyId: access.companyId,
    packageId: persisted.revision.packageId,
    latestRevision: persisted.revision.revision,
    contentHash: persisted.revision.contentHash,
    policyHash: persisted.revision.policyHash,
    updatedByUid: access.publisherUid,
    updatedAt: input.publishedAt,
  };
  input.store.createReceipt(receiptId, receipt);
  if (!head.present) input.store.createHead(headId, headDoc);
  else input.store.updateHead(headId, headDoc);
  return {
    ok: true,
    result: 'created',
    packageId: persisted.revision.packageId,
    revision: persisted.revision.revision,
    packetRevision: persisted.revision.revision,
    contentHash: persisted.revision.contentHash,
    policyHash: persisted.revision.policyHash,
  };
}

export const PUBLISH_COLLECTIONS = Object.freeze({
  head: HEAD_COLLECTION,
  receipts: RECEIPT_COLLECTION,
} as const);
