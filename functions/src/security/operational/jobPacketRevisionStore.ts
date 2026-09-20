/**
 * Dormant create-only job-packet revision store.
 * No live dispatch, catalog, or company-config path reads these documents.
 */
import { createHash } from 'crypto';
import { authorizeAdminCall, type ServerAdminAuthorization } from '../../admin/authority';

export const REVISION_COLLECTION = 'job_packet_revisions';
export const CLAIM_COLLECTION = 'job_packet_content_claims';
export const INDEX_COLLECTION = 'job_packet_package_index';

export const SCHEMA_VERSION = 1 as const;
export const HASH_SCHEMA_VERSION = 1 as const;
export const HASH_ALGORITHM = 'sha256' as const;
export const PUBLISHED_STATUS = 'published' as const;

export const PACKAGE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const ID_RE = PACKAGE_ID_RE;
const HASH_RE = /^[a-f0-9]{64}$/;

export const SUPPORTED_CAPABILITIES = Object.freeze([
  'lifecycle', 'pickup', 'dropoff', 'onSite', 'multiHaul',
  'splitTicket', 'transfer', 'photos', 'signatures',
] as const);
export type SupportedCapability = (typeof SUPPORTED_CAPABILITIES)[number];

export const RESERVED_CAPABILITIES = Object.freeze([
  'disposal', 'multiStop', 'photoCompliance', 'jsa', 'dvir', 'documents',
  'dispatchAcceptance', 'routeNavigation', 'editing', 'billing', 'payroll',
  'timekeeping', 'ticketGrouping', 'wellMonitoring',
] as const);

const SUPPORTED_SET = new Set<string>(SUPPORTED_CAPABILITIES);
const RESERVED_SET = new Set<string>(RESERVED_CAPABILITIES);

const UNITS = Object.freeze([
  'bbl', 'ton_us', 'tonne', 'hour', 'mile', 'kilometer', 'load', 'count',
] as const);
const UNIT_SET = new Set<string>(UNITS);

/** Server implementation inventory. Dormant: no live effect handlers are wired. */
export const SERVER_IMPLEMENTED_EFFECTS: readonly string[] = Object.freeze([]);

export const MAX_DEPTH = 12;
export const MAX_STRING_LENGTH = 4096;
export const MAX_ARRAY_LENGTH = 64;
export const MAX_OBJECT_KEYS = 48;
export const MAX_CANONICAL_CHARS = 200_000;
export const MAX_DISPLAY_VERSION_LENGTH = 32;
export const MAX_LABEL_LENGTH = 60;
export const MAX_JOB_TYPES = 64;
export const MAX_CAPABILITIES = 9;
export const MAX_POLICY_REFS = 16;

export const CALLER_ALLOWED_KEYS = Object.freeze([
  'packageId',
  'revision',
  'displayVersion',
  'industryId',
  'segmentId',
  'jobTypes',
  'capabilities',
  'policyRefs',
  'definition',
  'supersedes',
  'targetCompanyId',
] as const);

export const CALLER_FORBIDDEN_AUTHORITY_KEYS = Object.freeze([
  'companyId',
  'contentHash',
  'policyHash',
  'implementedEffects',
  'status',
  'publishedAt',
  'publishedByUid',
  'publishedBy',
  'publisher',
  'schemaVersion',
  'hashSchemaVersion',
  'hashAlgorithm',
] as const);

const DEFINITION_KEYS = Object.freeze([
  'schemaVersion', 'packetId', 'industryId', 'segmentId', 'label',
  'jobTypes', 'capabilities', 'fields', 'commandRules', 'workflow', 'compatibility',
] as const);
const DEFINITION_KEY_SET = new Set<string>(DEFINITION_KEYS);

const POLICY_REF_KEYS = Object.freeze(['kind', 'policyId', 'revision', 'contentHash'] as const);
const SUPERSEDES_KEYS = Object.freeze(['packageId', 'revision', 'contentHash'] as const);
const JOB_TYPE_KEYS = Object.freeze(['jobTypeId', 'label', 'capabilities'] as const);
const GRANT_KEYS = Object.freeze(['capabilityId', 'moduleVersion', 'configuration'] as const);
const CLAIM_KEYS = Object.freeze(['schemaVersion', 'companyId', 'packageId', 'revision', 'contentHash'] as const);

export type StoreFailure = { ok: false; reason: string; field?: string };
export type StoreSuccess<T> = { ok: true } & T;
export type StoreResult<T> = StoreSuccess<T> | StoreFailure;

export type PolicyRef = {
  kind: string;
  policyId: string;
  revision: number;
  contentHash: string;
};

export type JobTypeEntry = {
  jobTypeId: string;
  label: string;
  capabilities: string[];
};

export type CapabilityGrant = {
  capabilityId: SupportedCapability;
  moduleVersion: 1;
  configuration: Record<string, unknown>;
};

export type SupersedesRef = {
  packageId: string;
  revision: number;
  contentHash: string;
};

export type ImmutableRevisionEnvelope = {
  schemaVersion: 1;
  hashSchemaVersion: 1;
  companyId: string;
  packageId: string;
  revision: number;
  displayVersion: string;
  status: 'published';
  hashAlgorithm: 'sha256';
  contentHash: string;
  industryId: string;
  segmentId: string;
  jobTypes: JobTypeEntry[];
  capabilities: CapabilityGrant[];
  policyRefs: PolicyRef[];
  policyHash: string;
  implementedEffects: readonly string[];
  definition: Record<string, unknown>;
  publishedByUid: string;
  supersedes: SupersedesRef | null;
};

export type PersistedRevision = ImmutableRevisionEnvelope & { publishedAt: unknown };

export type ContentClaim = {
  schemaVersion: 1;
  companyId: string;
  packageId: string;
  revision: number;
  contentHash: string;
};

export interface RevisionStoreTx {
  getRevision(docId: string): Promise<Record<string, unknown> | null>;
  getClaim(docId: string): Promise<Record<string, unknown> | null>;
  createRevision(docId: string, data: Record<string, unknown>): void;
  createClaim(docId: string, data: Record<string, unknown>): void;
}

export function revisionDocId(companyId: string, packageId: string, revision: number): string {
  return `${companyId}__${packageId}__${revision}`;
}

export function claimDocId(companyId: string, packageId: string, contentHash: string): string {
  return `${companyId}__${packageId}__${contentHash}`;
}

export function fail(reason: string, field?: string): StoreFailure {
  return field ? { ok: false, reason, field } : { ok: false, reason };
}

function isOwnEnumerableData(desc: PropertyDescriptor): boolean {
  return desc.enumerable === true && desc.get === undefined && desc.set === undefined;
}

function snapshotOwn(value: unknown, path: string, depth: number): StoreResult<{ value: unknown }> {
  if (depth > MAX_DEPTH) return fail('excessive_depth', path);
  if (value === null) return { ok: true, value: null };
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) return fail('string_too_long', path);
    return { ok: true, value };
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return fail('invalid_number', path);
    return { ok: true, value };
  }
  if (typeof value === 'boolean') return { ok: true, value };
  if (typeof value !== 'object') return fail('unsupported_type', path);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return fail('non_plain_array', path);
    if (value.length > MAX_ARRAY_LENGTH) return fail('array_too_long', path);
    const symbols = Object.getOwnPropertySymbols(value);
    if (symbols.length) return fail('symbol_key', path);
    const out: unknown[] = [];
    const descs = Object.getOwnPropertyDescriptors(value);
    for (let i = 0; i < value.length; i++) {
      const d = descs[i];
      if (!d) return fail('sparse_array', path);
      if (d.get !== undefined || d.set !== undefined) return fail('accessor_forbidden', `${path}[${i}]`);
      const item = snapshotOwn(d.value, `${path}[${i}]`, depth + 1);
      if (!item.ok) return item;
      out.push(item.value);
    }
    return { ok: true, value: out };
  }

  const proto = Object.getPrototypeOf(value);
  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length) return fail('symbol_key', path);

  const obj = value as object;
  for (const key in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) return fail('inherited_property', path);
  }
  if (proto !== Object.prototype && proto !== null) return fail('non_plain_object', path);

  const descs = Object.getOwnPropertyDescriptors(obj);
  const keys = Object.keys(descs);
  if (keys.length > MAX_OBJECT_KEYS) return fail('too_many_keys', path);
  const out: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const d = descs[key];
    if (d.get !== undefined || d.set !== undefined) return fail('accessor_forbidden', `${path}.${key}`);
    if (!isOwnEnumerableData(d)) return fail('non_enumerable_property', `${path}.${key}`);
    const nested = snapshotOwn(d.value, `${path}.${key}`, depth + 1);
    if (!nested.ok) return nested;
    out[key] = nested.value;
  }
  return { ok: true, value: out };
}

function canonicalFromSnapshot(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'number') return Number.isInteger(value) ? String(value) : JSON.stringify(value);
  if (t === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalFromSnapshot(item)).join(',')}]`;
  }
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  const body = keys.map((k) => `${JSON.stringify(k)}:${canonicalFromSnapshot(rec[k])}`).join(',');
  return `{${body}}`;
}

export function snapshotPlain(value: unknown, path = '$'): StoreResult<{ value: unknown }> {
  return snapshotOwn(value, path, 0);
}

export function canonicalJson(value: unknown): StoreResult<{ json: string }> {
  const snapped = snapshotPlain(value);
  if (!snapped.ok) return snapped;
  const json = canonicalFromSnapshot(snapped.value);
  if (json.length > MAX_CANONICAL_CHARS) return fail('payload_too_large');
  return { ok: true, json };
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Canonical content identity. Excludes revision, display, publisher, and supersedes. */
export function contentHashMaterial(envelope: Omit<ImmutableRevisionEnvelope, 'contentHash'>): Record<string, unknown> {
  return {
    hashSchemaVersion: HASH_SCHEMA_VERSION,
    schemaVersion: envelope.schemaVersion,
    companyId: envelope.companyId,
    packageId: envelope.packageId,
    industryId: envelope.industryId,
    segmentId: envelope.segmentId,
    jobTypes: envelope.jobTypes,
    capabilities: envelope.capabilities,
    policyRefs: envelope.policyRefs,
    policyHash: envelope.policyHash,
    implementedEffects: envelope.implementedEffects,
    definition: envelope.definition,
  };
}

/** Full immutable revision identity, excluding contentHash and publishedAt. */
export function hashMaterial(envelope: Omit<ImmutableRevisionEnvelope, 'contentHash'>): Record<string, unknown> {
  return {
    ...contentHashMaterial(envelope),
    revision: envelope.revision,
    displayVersion: envelope.displayVersion,
    status: envelope.status,
    hashAlgorithm: envelope.hashAlgorithm,
    publishedByUid: envelope.publishedByUid,
    supersedes: envelope.supersedes,
  };
}

function exactKeys(obj: Record<string, unknown>, allowed: readonly string[], path: string): StoreFailure | null {
  for (const key of Object.keys(obj)) {
    if (!(allowed as readonly string[]).includes(key)) return fail('unknown_field', `${path}.${key}`);
  }
  return null;
}

function requireId(value: unknown, path: string): StoreResult<{ value: string }> {
  if (typeof value !== 'string') return fail('invalid_id', path);
  if (!ID_RE.test(value)) return fail('malformed_id', path);
  return { ok: true, value };
}

function requireRevision(value: unknown, path: string): StoreResult<{ value: number }> {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > Number.MAX_SAFE_INTEGER) {
    return fail('invalid_revision', path);
  }
  return { ok: true, value };
}

function requireHash(value: unknown, path: string): StoreResult<{ value: string }> {
  if (typeof value !== 'string' || !HASH_RE.test(value)) return fail('invalid_hash', path);
  return { ok: true, value };
}

function asRecord(value: unknown, path: string): StoreResult<{ value: Record<string, unknown> }> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail('must_be_object', path);
  return { ok: true, value: value as Record<string, unknown> };
}

function parsePolicyRef(raw: unknown, path: string): StoreResult<{ value: PolicyRef }> {
  const rec = asRecord(raw, path);
  if (!rec.ok) return rec;
  const bad = exactKeys(rec.value, POLICY_REF_KEYS, path);
  if (bad) return bad;
  const kind = requireId(rec.value.kind, `${path}.kind`);
  if (!kind.ok) return kind;
  const policyId = requireId(rec.value.policyId, `${path}.policyId`);
  if (!policyId.ok) return policyId;
  const revision = requireRevision(rec.value.revision, `${path}.revision`);
  if (!revision.ok) return revision;
  const contentHash = requireHash(rec.value.contentHash, `${path}.contentHash`);
  if (!contentHash.ok) return contentHash;
  return {
    ok: true,
    value: {
      kind: kind.value,
      policyId: policyId.value,
      revision: revision.value,
      contentHash: contentHash.value,
    },
  };
}

function parseConfig(capabilityId: SupportedCapability, raw: unknown, path: string): StoreResult<{ value: Record<string, unknown> }> {
  const rec = asRecord(raw, path);
  if (!rec.ok) return rec;
  const cfg = rec.value;
  const unit = (): StoreResult<{ value: string }> => {
    if (typeof cfg.unit !== 'string' || !UNIT_SET.has(cfg.unit)) return fail('invalid_unit', `${path}.unit`);
    return { ok: true, value: cfg.unit };
  };
  if (capabilityId === 'lifecycle' || capabilityId === 'onSite') {
    const bad = exactKeys(cfg, [], path);
    if (bad) return bad;
    return { ok: true, value: {} };
  }
  if (capabilityId === 'pickup' || capabilityId === 'dropoff') {
    const bad = exactKeys(cfg, ['unit'], path);
    if (bad) return bad;
    const u = unit();
    if (!u.ok) return u;
    return { ok: true, value: { unit: u.value } };
  }
  if (capabilityId === 'multiHaul') {
    const bad = exactKeys(cfg, ['allocationPolicy'], path);
    if (bad) return bad;
    const pol = parsePolicyRef(cfg.allocationPolicy, `${path}.allocationPolicy`);
    if (!pol.ok) return pol;
    return { ok: true, value: { allocationPolicy: pol.value } };
  }
  if (capabilityId === 'splitTicket') {
    const bad = exactKeys(cfg, ['unit', 'activationPolicy'], path);
    if (bad) return bad;
    const u = unit();
    if (!u.ok) return u;
    const pol = parsePolicyRef(cfg.activationPolicy, `${path}.activationPolicy`);
    if (!pol.ok) return pol;
    return { ok: true, value: { unit: u.value, activationPolicy: pol.value } };
  }
  if (capabilityId === 'transfer') {
    const bad = exactKeys(cfg, ['authorityPolicy'], path);
    if (bad) return bad;
    const pol = parsePolicyRef(cfg.authorityPolicy, `${path}.authorityPolicy`);
    if (!pol.ok) return pol;
    return { ok: true, value: { authorityPolicy: pol.value } };
  }
  if (capabilityId === 'photos' || capabilityId === 'signatures') {
    const bad = exactKeys(cfg, ['evidencePolicy'], path);
    if (bad) return bad;
    const pol = parsePolicyRef(cfg.evidencePolicy, `${path}.evidencePolicy`);
    if (!pol.ok) return pol;
    return { ok: true, value: { evidencePolicy: pol.value } };
  }
  return fail('unsupported_capability', path);
}

function parseGrant(raw: unknown, path: string): StoreResult<{ value: CapabilityGrant }> {
  const rec = asRecord(raw, path);
  if (!rec.ok) return rec;
  const bad = exactKeys(rec.value, GRANT_KEYS, path);
  if (bad) return bad;
  const idRaw = rec.value.capabilityId;
  if (typeof idRaw !== 'string') return fail('invalid_capability', `${path}.capabilityId`);
  if (RESERVED_SET.has(idRaw)) return fail('reserved_capability', `${path}.capabilityId`);
  if (!SUPPORTED_SET.has(idRaw)) return fail('unknown_capability', `${path}.capabilityId`);
  if (rec.value.moduleVersion !== 1) return fail('unsupported_module_version', `${path}.moduleVersion`);
  const cfg = parseConfig(idRaw as SupportedCapability, rec.value.configuration, `${path}.configuration`);
  if (!cfg.ok) return cfg;
  return {
    ok: true,
    value: {
      capabilityId: idRaw as SupportedCapability,
      moduleVersion: 1,
      configuration: cfg.value,
    },
  };
}

function parseJobType(raw: unknown, path: string, granted: Set<string>): StoreResult<{ value: JobTypeEntry }> {
  const rec = asRecord(raw, path);
  if (!rec.ok) return rec;
  const bad = exactKeys(rec.value, JOB_TYPE_KEYS, path);
  if (bad) return bad;
  const id = requireId(rec.value.jobTypeId, `${path}.jobTypeId`);
  if (!id.ok) return id;
  if (typeof rec.value.label !== 'string') return fail('invalid_label', `${path}.label`);
  const label = rec.value.label.trim();
  if (!label || label.length > MAX_LABEL_LENGTH) return fail('invalid_label', `${path}.label`);
  if (label !== rec.value.label) return fail('label_not_canonical', `${path}.label`);
  if (!Array.isArray(rec.value.capabilities)) return fail('capabilities_must_be_array', `${path}.capabilities`);
  if (rec.value.capabilities.length < 1 || rec.value.capabilities.length > MAX_CAPABILITIES) {
    return fail('capabilities_count', `${path}.capabilities`);
  }
  const caps: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rec.value.capabilities.length; i++) {
    const c = rec.value.capabilities[i];
    if (typeof c !== 'string') return fail('invalid_capability', `${path}.capabilities[${i}]`);
    if (RESERVED_SET.has(c)) return fail('reserved_capability', `${path}.capabilities[${i}]`);
    if (!SUPPORTED_SET.has(c)) return fail('unknown_capability', `${path}.capabilities[${i}]`);
    if (!granted.has(c)) return fail('ungranted_job_type_capability', `${path}.capabilities[${i}]`);
    if (seen.has(c)) return fail('duplicate_id', `${path}.capabilities[${i}]`);
    seen.add(c);
    caps.push(c);
  }
  return { ok: true, value: { jobTypeId: id.value, label, capabilities: caps } };
}

function parseSupersedes(raw: unknown, path: string): StoreResult<{ value: SupersedesRef | null }> {
  if (raw === null) return { ok: true, value: null };
  const rec = asRecord(raw, path);
  if (!rec.ok) return rec;
  const bad = exactKeys(rec.value, SUPERSEDES_KEYS, path);
  if (bad) return bad;
  const packageId = requireId(rec.value.packageId, `${path}.packageId`);
  if (!packageId.ok) return packageId;
  const revision = requireRevision(rec.value.revision, `${path}.revision`);
  if (!revision.ok) return revision;
  const contentHash = requireHash(rec.value.contentHash, `${path}.contentHash`);
  if (!contentHash.ok) return contentHash;
  return {
    ok: true,
    value: { packageId: packageId.value, revision: revision.value, contentHash: contentHash.value },
  };
}

function parseDefinition(
  raw: unknown,
  path: string,
  expected: { packageId: string; industryId: string; segmentId: string },
): StoreResult<{ value: Record<string, unknown> }> {
  const rec = asRecord(raw, path);
  if (!rec.ok) return rec;
  for (const key of Object.keys(rec.value)) {
    if (!DEFINITION_KEY_SET.has(key)) return fail('unknown_field', `${path}.${key}`);
  }
  if (rec.value.schemaVersion !== 1) return fail('unsupported_version', `${path}.schemaVersion`);
  const packetId = requireId(rec.value.packetId, `${path}.packetId`);
  if (!packetId.ok) return packetId;
  if (packetId.value !== expected.packageId) return fail('definition_packet_mismatch', `${path}.packetId`);
  const industryId = requireId(rec.value.industryId, `${path}.industryId`);
  if (!industryId.ok) return industryId;
  if (industryId.value !== expected.industryId) return fail('definition_industry_mismatch', `${path}.industryId`);
  const segmentId = requireId(rec.value.segmentId, `${path}.segmentId`);
  if (!segmentId.ok) return segmentId;
  if (segmentId.value !== expected.segmentId) return fail('definition_segment_mismatch', `${path}.segmentId`);
  if (typeof rec.value.label !== 'string') return fail('invalid_label', `${path}.label`);
  const label = rec.value.label.trim();
  if (!label || label.length > MAX_LABEL_LENGTH || label !== rec.value.label) {
    return fail('invalid_label', `${path}.label`);
  }
  return { ok: true, value: rec.value };
}

export function decidePublishAccess(params: {
  authUid?: string | null;
  tenantCaller?: { companyId?: string | null; caps: string[] } | null;
  platformAdminDecision?: Pick<ServerAdminAuthorization, 'ok'> & { reason?: string } | null;
  requestedTargetCompanyId?: string;
}): StoreResult<{ companyId: string; via: 'tenant' | 'platform_admin' }> {
  if (!params.authUid) return fail('unauthenticated');
  const tenantCompany = (params.tenantCaller?.companyId || '').trim();
  const caps = params.tenantCaller?.caps || [];
  const canPublishTenant = caps.includes('manageDrivers') || caps.includes('manageCompany');
  const requested = (params.requestedTargetCompanyId || '').trim();

  if (tenantCompany && canPublishTenant) {
    if (requested && requested !== tenantCompany) {
      if (!params.platformAdminDecision || params.platformAdminDecision.ok !== true) {
        return fail('platform_admin_required');
      }
      if (!ID_RE.test(requested)) return fail('malformed_id', 'targetCompanyId');
      return { ok: true, companyId: requested, via: 'platform_admin' };
    }
    if (!ID_RE.test(tenantCompany)) return fail('malformed_id', 'companyId');
    return { ok: true, companyId: tenantCompany, via: 'tenant' };
  }

  if (!params.platformAdminDecision || params.platformAdminDecision.ok !== true) {
    const reason = params.platformAdminDecision && 'reason' in params.platformAdminDecision
      ? String(params.platformAdminDecision.reason || 'platform_admin_required')
      : 'platform_admin_required';
    return fail(reason === 'unauthenticated' ? 'unauthenticated' : 'platform_admin_required');
  }
  if (!requested) return fail('target_company_required', 'targetCompanyId');
  if (!ID_RE.test(requested)) return fail('malformed_id', 'targetCompanyId');
  return { ok: true, companyId: requested, via: 'platform_admin' };
}

export function tenantPublishCapsFromRoles(
  roles: string[],
  overrides: Record<string, string[]>,
): string[] {
  const DEFAULTS: Record<string, string[]> = {
    it: ['manageDrivers', 'viewAllCompanies', 'manageEquipment'],
    admin: ['manageDrivers', 'manageEquipment'],
    manager: ['manageDrivers'],
  };
  const caps = new Set<string>();
  for (const role of roles) {
    const list = overrides[role] ?? DEFAULTS[role] ?? [];
    for (const c of list) caps.add(c);
  }
  return [...caps];
}

export function validatePublishInput(
  raw: unknown,
  ctx: { companyId: string; publishedByUid: string },
): StoreResult<{ envelope: Omit<ImmutableRevisionEnvelope, 'contentHash'>; contentHash: string; targetCompanyId?: string }> {
  const snapped = snapshotPlain(raw, '$');
  if (!snapped.ok) return snapped;
  const rec = asRecord(snapped.value, '$');
  if (!rec.ok) return rec;
  const obj = rec.value;

  for (const key of Object.keys(obj)) {
    if ((CALLER_FORBIDDEN_AUTHORITY_KEYS as readonly string[]).includes(key)) {
      return fail('caller_authority_field', key);
    }
    if (!(CALLER_ALLOWED_KEYS as readonly string[]).includes(key)) {
      return fail('unknown_field', key);
    }
  }

  const packageId = requireId(obj.packageId, 'packageId');
  if (!packageId.ok) return packageId;
  const revision = requireRevision(obj.revision, 'revision');
  if (!revision.ok) return revision;
  if (typeof obj.displayVersion !== 'string') return fail('invalid_display_version', 'displayVersion');
  const displayVersion = obj.displayVersion.trim();
  if (!displayVersion || displayVersion.length > MAX_DISPLAY_VERSION_LENGTH || displayVersion !== obj.displayVersion) {
    return fail('invalid_display_version', 'displayVersion');
  }
  const industryId = requireId(obj.industryId, 'industryId');
  if (!industryId.ok) return industryId;
  const segmentId = requireId(obj.segmentId, 'segmentId');
  if (!segmentId.ok) return segmentId;
  if (!ID_RE.test(ctx.companyId)) return fail('malformed_id', 'companyId');
  if (!ctx.publishedByUid || typeof ctx.publishedByUid !== 'string') return fail('invalid_publisher');

  if (!Array.isArray(obj.capabilities)) return fail('capabilities_must_be_array', 'capabilities');
  if (obj.capabilities.length < 1 || obj.capabilities.length > MAX_CAPABILITIES) {
    return fail('capabilities_count', 'capabilities');
  }
  const grants: CapabilityGrant[] = [];
  const granted = new Set<string>();
  for (let i = 0; i < obj.capabilities.length; i++) {
    const g = parseGrant(obj.capabilities[i], `capabilities[${i}]`);
    if (!g.ok) return g;
    if (granted.has(g.value.capabilityId)) return fail('duplicate_id', `capabilities[${i}].capabilityId`);
    granted.add(g.value.capabilityId);
    grants.push(g.value);
  }

  if (!Array.isArray(obj.jobTypes)) return fail('job_types_must_be_array', 'jobTypes');
  if (obj.jobTypes.length < 1 || obj.jobTypes.length > MAX_JOB_TYPES) return fail('job_types_count', 'jobTypes');
  const jobTypes: JobTypeEntry[] = [];
  const seenIds = new Set<string>();
  const seenLabels = new Set<string>();
  for (let i = 0; i < obj.jobTypes.length; i++) {
    const jt = parseJobType(obj.jobTypes[i], `jobTypes[${i}]`, granted);
    if (!jt.ok) return jt;
    if (seenIds.has(jt.value.jobTypeId)) return fail('duplicate_id', `jobTypes[${i}].jobTypeId`);
    const alias = jt.value.label.toLowerCase();
    if (seenLabels.has(alias)) return fail('conflicting_alias', `jobTypes[${i}].label`);
    seenIds.add(jt.value.jobTypeId);
    seenLabels.add(alias);
    jobTypes.push(jt.value);
  }

  if (!Array.isArray(obj.policyRefs)) return fail('policy_refs_must_be_array', 'policyRefs');
  if (obj.policyRefs.length > MAX_POLICY_REFS) return fail('policy_refs_count', 'policyRefs');
  const policyRefs: PolicyRef[] = [];
  const seenKinds = new Set<string>();
  for (let i = 0; i < obj.policyRefs.length; i++) {
    const p = parsePolicyRef(obj.policyRefs[i], `policyRefs[${i}]`);
    if (!p.ok) return p;
    if (seenKinds.has(p.value.kind)) return fail('duplicate_id', `policyRefs[${i}].kind`);
    seenKinds.add(p.value.kind);
    policyRefs.push(p.value);
  }

  const definition = parseDefinition(obj.definition, 'definition', {
    packageId: packageId.value,
    industryId: industryId.value,
    segmentId: segmentId.value,
  });
  if (!definition.ok) return definition;

  const supersedes = parseSupersedes(obj.supersedes === undefined ? null : obj.supersedes, 'supersedes');
  if (!supersedes.ok) return supersedes;
  if (supersedes.value) {
    if (supersedes.value.packageId !== packageId.value) return fail('supersedes_package_mismatch', 'supersedes.packageId');
    if (supersedes.value.revision >= revision.value) return fail('supersedes_not_advancing', 'supersedes.revision');
  }

  let targetCompanyId: string | undefined;
  if (obj.targetCompanyId !== undefined) {
    const t = requireId(obj.targetCompanyId, 'targetCompanyId');
    if (!t.ok) return t;
    targetCompanyId = t.value;
  }

  const policyCanon = canonicalJson({ hashSchemaVersion: HASH_SCHEMA_VERSION, policyRefs });
  if (!policyCanon.ok) return policyCanon;
  const policyHash = sha256Hex(policyCanon.json);

  const envelope: Omit<ImmutableRevisionEnvelope, 'contentHash'> = {
    schemaVersion: SCHEMA_VERSION,
    hashSchemaVersion: HASH_SCHEMA_VERSION,
    companyId: ctx.companyId,
    packageId: packageId.value,
    revision: revision.value,
    displayVersion,
    status: PUBLISHED_STATUS,
    hashAlgorithm: HASH_ALGORITHM,
    industryId: industryId.value,
    segmentId: segmentId.value,
    jobTypes,
    capabilities: grants,
    policyRefs,
    policyHash,
    implementedEffects: SERVER_IMPLEMENTED_EFFECTS,
    definition: definition.value,
    publishedByUid: ctx.publishedByUid,
    supersedes: supersedes.value,
  };

  const materialCanon = canonicalJson(contentHashMaterial(envelope));
  if (!materialCanon.ok) return materialCanon;
  const contentHash = sha256Hex(materialCanon.json);
  return { ok: true, envelope, contentHash, targetCompanyId };
}

function storedAsRevision(raw: Record<string, unknown>): StoreResult<{ envelope: ImmutableRevisionEnvelope; publishedAt: unknown }> {
  const publishedAt = raw.publishedAt;
  const { publishedAt: _drop, ...rest } = raw;
  void _drop;
  const hash = requireHash(rest.contentHash, 'contentHash');
  if (!hash.ok) return fail('store_integrity', 'contentHash');
  const material = { ...rest } as Record<string, unknown>;
  delete material.contentHash;
  const typed = material as unknown as Omit<ImmutableRevisionEnvelope, 'contentHash'>;
  const recomputed = canonicalJson(contentHashMaterial(typed));
  if (!recomputed.ok) return fail('store_integrity', 'canonical');
  if (sha256Hex(recomputed.json) !== hash.value) return fail('store_integrity', 'contentHash');
  return {
    ok: true,
    envelope: { ...(rest as unknown as Omit<ImmutableRevisionEnvelope, 'contentHash'>), contentHash: hash.value },
    publishedAt,
  };
}

function storedAsClaim(raw: Record<string, unknown>): StoreResult<{ value: ContentClaim }> {
  const bad = exactKeys(raw, CLAIM_KEYS, 'claim');
  if (bad) return fail('store_integrity', bad.field);
  if (raw.schemaVersion !== 1) return fail('store_integrity', 'claim.schemaVersion');
  const companyId = requireId(raw.companyId, 'claim.companyId');
  if (!companyId.ok) return fail('store_integrity', 'claim.companyId');
  const packageId = requireId(raw.packageId, 'claim.packageId');
  if (!packageId.ok) return fail('store_integrity', 'claim.packageId');
  const revision = requireRevision(raw.revision, 'claim.revision');
  if (!revision.ok) return fail('store_integrity', 'claim.revision');
  const contentHash = requireHash(raw.contentHash, 'claim.contentHash');
  if (!contentHash.ok) return fail('store_integrity', 'claim.contentHash');
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      companyId: companyId.value,
      packageId: packageId.value,
      revision: revision.value,
      contentHash: contentHash.value,
    },
  };
}

function stripHash(envelope: ImmutableRevisionEnvelope): Omit<ImmutableRevisionEnvelope, 'contentHash'> {
  const { contentHash: _c, ...rest } = envelope;
  void _c;
  return rest;
}

function envelopesEqual(a: ImmutableRevisionEnvelope, b: ImmutableRevisionEnvelope): boolean {
  const ca = canonicalJson(hashMaterial(stripHash(a)));
  const cb = canonicalJson(hashMaterial(stripHash(b)));
  if (!ca.ok || !cb.ok) return false;
  return ca.json === cb.json && a.contentHash === b.contentHash;
}

export async function persistJobPacketRevision(
  tx: RevisionStoreTx,
  built: { envelope: Omit<ImmutableRevisionEnvelope, 'contentHash'>; contentHash: string },
  publishedAt: unknown,
): Promise<StoreResult<{ publication: 'created' | 'existing'; revision: PersistedRevision }>> {
  const envelope: ImmutableRevisionEnvelope = { ...built.envelope, contentHash: built.contentHash };
  const revId = revisionDocId(envelope.companyId, envelope.packageId, envelope.revision);
  const claimId = claimDocId(envelope.companyId, envelope.packageId, envelope.contentHash);

  const existingRev = await tx.getRevision(revId);
  const existingClaim = await tx.getClaim(claimId);

  if (envelope.supersedes) {
    const priorId = revisionDocId(envelope.companyId, envelope.supersedes.packageId, envelope.supersedes.revision);
    const prior = await tx.getRevision(priorId);
    if (!prior) return fail('supersedes_not_found', 'supersedes');
    const parsedPrior = storedAsRevision(prior);
    if (!parsedPrior.ok) return fail('supersedes_inconsistent', 'supersedes');
    if (parsedPrior.envelope.companyId !== envelope.companyId) return fail('supersedes_tenant_mismatch', 'supersedes');
    if (parsedPrior.envelope.packageId !== envelope.packageId) return fail('supersedes_package_mismatch', 'supersedes');
    if (parsedPrior.envelope.revision !== envelope.supersedes.revision) return fail('supersedes_mismatch', 'supersedes.revision');
    if (parsedPrior.envelope.contentHash !== envelope.supersedes.contentHash) {
      return fail('supersedes_mismatch', 'supersedes.contentHash');
    }
    if (parsedPrior.envelope.revision >= envelope.revision) return fail('supersedes_not_advancing', 'supersedes.revision');
  }

  if (existingRev) {
    const parsedRev = storedAsRevision(existingRev);
    if (!parsedRev.ok) return fail('store_integrity', 'revision');
    if (!envelopesEqual(envelope, parsedRev.envelope)) return fail('immutable_packet_revision');
    if (!existingClaim) return fail('store_integrity', 'claim');
    const claim = storedAsClaim(existingClaim);
    if (!claim.ok) return fail('store_integrity', 'claim');
    if (
      claim.value.revision !== envelope.revision
      || claim.value.contentHash !== envelope.contentHash
      || claim.value.companyId !== envelope.companyId
      || claim.value.packageId !== envelope.packageId
    ) {
      return fail('store_integrity', 'claim');
    }
    return {
      ok: true,
      publication: 'existing',
      revision: { ...parsedRev.envelope, publishedAt: parsedRev.publishedAt },
    };
  }

  if (existingClaim) {
    const claim = storedAsClaim(existingClaim);
    if (!claim.ok) return fail('store_integrity', 'claim');
    if (
      claim.value.companyId !== envelope.companyId
      || claim.value.packageId !== envelope.packageId
      || claim.value.contentHash !== envelope.contentHash
    ) {
      return fail('store_integrity', 'claim');
    }
    const claimedRevId = revisionDocId(claim.value.companyId, claim.value.packageId, claim.value.revision);
    const claimedRev = await tx.getRevision(claimedRevId);
    if (!claimedRev) return fail('store_integrity', 'claim.revision');
    const parsedClaimed = storedAsRevision(claimedRev);
    if (!parsedClaimed.ok) return fail('store_integrity', 'claim.revision');
    if (parsedClaimed.envelope.contentHash !== claim.value.contentHash) {
      return fail('store_integrity', 'claim.contentHash');
    }
    return fail('duplicate_content_revision', 'contentHash');
  }

  const persisted: PersistedRevision = {
    ...(JSON.parse(JSON.stringify(envelope)) as ImmutableRevisionEnvelope),
    publishedAt,
  };
  const claim: ContentClaim = {
    schemaVersion: 1,
    companyId: envelope.companyId,
    packageId: envelope.packageId,
    revision: envelope.revision,
    contentHash: envelope.contentHash,
  };
  tx.createRevision(revId, persisted);
  tx.createClaim(claimId, JSON.parse(JSON.stringify(claim)) as ContentClaim);
  return { ok: true, publication: 'created', revision: persisted };
}

export function evaluatePlatformAdminRecord(
  auth: { uid?: string | null; token?: Record<string, unknown> | null } | null,
  record: Record<string, unknown> | null,
): ServerAdminAuthorization {
  return authorizeAdminCall(auth, record);
}
