import { createHash } from 'crypto';
import {
  bindingsEqual,
  isRequestId,
  liveState,
  type AuthPrincipal,
  type JsaAuthorityBinding,
  type JsaCompletionAction,
  type JsaGovernedRecord,
} from './jsaReceiptCore.js';

export const JSA_ARTIFACT_COLLECTION = 'jsa_governed_artifacts';
export const JSA_ARTIFACT_SCHEMA_VERSION = 1;
export const JSA_SIGNATURE_MAX_BYTES = 128 * 1024;
export const JSA_SNAPSHOT_MAX_JSON_CHARS = 180_000;

const SNAPSHOT_KEYS = [
  'prepared', 'locationAcks', 'locations', 'stepsAcknowledged', 'stepAcks',
  'ppeSelected', 'ppeOtherItems', 'notes', 'pusher', 'otherInfo', 'printedName',
  'signature', 'truckNumber', 'formDate',
] as const;
const LIMITS = { mapKeys: 40, locations: 24, locationItem: 120, ppeOther: 16, ppeOtherItem: 80,
  notes: 4000, pusher: 120, otherInfo: 2000, printedName: 120, truckNumber: 32 };
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export type ArtifactRefusal =
  | 'malformed' | 'not_found' | 'pending' | 'binding_mismatch' | 'conflict';
export type ArtifactDecision<T> = { ok: true; value: T } | { ok: false; refusal: ArtifactRefusal; detail: string };

export interface GovernedSnapshot {
  prepared: Record<string, boolean>;
  locationAcks: Record<string, boolean>;
  locations: string[];
  stepsAcknowledged: boolean;
  stepAcks: Record<string, boolean>;
  ppeSelected: Record<string, boolean>;
  ppeOtherItems: string[];
  notes: string;
  pusher: string;
  otherInfo: string;
  printedName: string;
  signature: { mimeType: 'image/png'; data: string };
  truckNumber?: string;
  formDate?: string;
}

export interface StoredArtifact {
  schemaVersion: 1;
  requestId: string;
  driverId: string;
  companyId: string;
  actorUidHash: string;
  jobRef: string;
  groupRef: string | null;
  binding: JsaAuthorityBinding;
  action: JsaCompletionAction;
  snapshotHash: string;
  signature: { mimeType: 'image/png'; encoding: 'base64'; byteSize: number; sha256: string };
  snapshot: GovernedSnapshot;
  artifactWrittenAtMs: number;
}

function fail(refusal: ArtifactRefusal, detail: string): ArtifactDecision<never> {
  return { ok: false, refusal, detail };
}
function rec(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}
function sortedBoolMap(v: unknown, detail: string): ArtifactDecision<Record<string, boolean>> {
  const o = rec(v);
  if (!o) return fail('malformed', detail);
  const keys = Object.keys(o).sort();
  if (keys.length > LIMITS.mapKeys) return fail('malformed', `${detail}_count`);
  const out: Record<string, boolean> = {};
  for (const key of keys) {
    if (!key || key.length > 64 || key.trim() !== key || /[\x00-\x1f\x7f]/.test(key) || typeof o[key] !== 'boolean') {
      return fail('malformed', detail);
    }
    out[key] = o[key] as boolean;
  }
  return { ok: true, value: out };
}
function stringList(v: unknown, detail: string, count: number, length: number): ArtifactDecision<string[]> {
  if (!Array.isArray(v) || v.length > count) return fail('malformed', detail);
  if (v.some((x) => typeof x !== 'string' || !x || x.length > length || x.trim() !== x)) return fail('malformed', detail);
  return { ok: true, value: v.slice() as string[] };
}
function boundedString(v: unknown, detail: string, length: number, required = false): ArtifactDecision<string> {
  if (typeof v !== 'string' || v.length > length || v.trim() !== v || (required && !v)) return fail('malformed', detail);
  return { ok: true, value: v };
}

export function parseArtifactInput(data: unknown): ArtifactDecision<{ requestId: string; snapshot: GovernedSnapshot; signatureBytes: Buffer }> {
  const root = rec(data);
  if (!root || Object.keys(root).some((k) => k !== 'requestId' && k !== 'snapshot') || !isRequestId(root.requestId)) {
    return fail('malformed', 'root');
  }
  if (JSON.stringify(root).length > JSA_SNAPSHOT_MAX_JSON_CHARS + 64) return fail('malformed', 'payload_size');
  const s = rec(root.snapshot);
  if (!s || Object.keys(s).some((k) => !(SNAPSHOT_KEYS as readonly string[]).includes(k))) return fail('malformed', 'snapshot');
  const prepared = sortedBoolMap(s.prepared, 'prepared'); if (!prepared.ok) return prepared;
  const locationAcks = sortedBoolMap(s.locationAcks, 'locationAcks'); if (!locationAcks.ok) return locationAcks;
  const stepAcks = sortedBoolMap(s.stepAcks, 'stepAcks'); if (!stepAcks.ok) return stepAcks;
  const ppeSelected = sortedBoolMap(s.ppeSelected, 'ppeSelected'); if (!ppeSelected.ok) return ppeSelected;
  const locations = stringList(s.locations, 'locations', LIMITS.locations, LIMITS.locationItem); if (!locations.ok) return locations;
  const ppeOtherItems = stringList(s.ppeOtherItems, 'ppeOtherItems', LIMITS.ppeOther, LIMITS.ppeOtherItem); if (!ppeOtherItems.ok) return ppeOtherItems;
  const notes = boundedString(s.notes, 'notes', LIMITS.notes); if (!notes.ok) return notes;
  const pusher = boundedString(s.pusher, 'pusher', LIMITS.pusher); if (!pusher.ok) return pusher;
  const otherInfo = boundedString(s.otherInfo, 'otherInfo', LIMITS.otherInfo); if (!otherInfo.ok) return otherInfo;
  const printedName = boundedString(s.printedName, 'printedName', LIMITS.printedName, true); if (!printedName.ok) return printedName;
  if (typeof s.stepsAcknowledged !== 'boolean') return fail('malformed', 'stepsAcknowledged');
  const sig = rec(s.signature);
  if (!sig || Object.keys(sig).some((k) => k !== 'mimeType' && k !== 'data') || sig.mimeType !== 'image/png'
    || typeof sig.data !== 'string' || !sig.data || sig.data.length % 4 || !BASE64_RE.test(sig.data)) return fail('malformed', 'signature');
  const signatureBytes = Buffer.from(sig.data, 'base64');
  if (!signatureBytes.length || signatureBytes.length > JSA_SIGNATURE_MAX_BYTES
    || signatureBytes.toString('base64') !== sig.data || !signatureBytes.subarray(0, 8).equals(PNG_MAGIC)) return fail('malformed', 'signature');
  const snapshot: GovernedSnapshot = {
    prepared: prepared.value, locationAcks: locationAcks.value, locations: locations.value,
    stepsAcknowledged: s.stepsAcknowledged, stepAcks: stepAcks.value, ppeSelected: ppeSelected.value,
    ppeOtherItems: ppeOtherItems.value, notes: notes.value, pusher: pusher.value,
    otherInfo: otherInfo.value, printedName: printedName.value,
    signature: { mimeType: 'image/png', data: sig.data },
  };
  if (s.truckNumber !== undefined) { const x = boundedString(s.truckNumber, 'truckNumber', LIMITS.truckNumber); if (!x.ok) return x; if (x.value) snapshot.truckNumber = x.value; }
  if (s.formDate !== undefined) { if (typeof s.formDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.formDate)) return fail('malformed', 'formDate'); snapshot.formDate = s.formDate; }
  return { ok: true, value: { requestId: root.requestId, snapshot, signatureBytes } };
}

export function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
export function artifactPath(requestId: string): string { return `${JSA_ARTIFACT_COLLECTION}/${requestId}`; }

export function decideArtifactWrite(input: {
  request: JsaGovernedRecord | null; existing: StoredArtifact | null; requestId: string;
  snapshot: GovernedSnapshot; signatureBytes: Buffer; principal: AuthPrincipal;
  binding: JsaAuthorityBinding; nowMs: number;
}): ArtifactDecision<{ artifact: StoredArtifact; write: 'create' | 'reuse' }> {
  const r = input.request;
  if (!r || r.requestId !== input.requestId) return fail('not_found', 'request');
  if (r.driverId !== input.principal.driverId || r.companyId !== input.principal.companyId) return fail('binding_mismatch', 'actor');
  if (!bindingsEqual(r.binding, input.binding)) return fail('binding_mismatch', 'shift');
  if (liveState(r, input.nowMs) !== 'completed' || !r.action) return fail('pending', 'completion');
  const snapshotHash = sha256(JSON.stringify(input.snapshot));
  const actorUidHash = sha256(input.principal.uid);
  if (input.existing) {
    if (input.existing.requestId !== input.requestId || input.existing.driverId !== r.driverId
      || input.existing.companyId !== r.companyId || input.existing.actorUidHash !== actorUidHash) return fail('binding_mismatch', 'artifact_actor');
    if (input.existing.action !== r.action || input.existing.snapshotHash !== snapshotHash) return fail('conflict', 'immutable');
    return { ok: true, value: { artifact: input.existing, write: 'reuse' } };
  }
  return { ok: true, value: { write: 'create', artifact: {
    schemaVersion: 1, requestId: input.requestId, driverId: r.driverId, companyId: r.companyId,
    actorUidHash, jobRef: r.jobRef, groupRef: r.groupRef, binding: r.binding, action: r.action,
    snapshotHash, signature: { mimeType: 'image/png', encoding: 'base64', byteSize: input.signatureBytes.length, sha256: sha256(input.signatureBytes) },
    snapshot: input.snapshot, artifactWrittenAtMs: input.nowMs,
  } } };
}
