import type { OperatorRef, SourceRef, SourceSystem } from './types';

export function normalizeName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

interface Extracted {
  hash?: string;
  driverId?: string;
  uid?: string;
  displayName?: string;
  legalName?: string;
  companyId?: string;
  companyName?: string;
}

const HASH_LIKE = /^[0-9a-f]{20,}$/i;
const HASH_FIELDS = ['hash', 'passcodeHash', 'driverHash', 'key'] as const;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function extract(input: unknown): Extracted {
  if (input == null) return {};

  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return {};
    const driverMatch = trimmed.match(/^driver:(.+)$/);
    if (driverMatch) return { hash: driverMatch[1] };
    const userMatch = trimmed.match(/^user:(.+)$/);
    if (userMatch) return { uid: userMatch[1] };
    if (HASH_LIKE.test(trimmed)) return { hash: trimmed };
    return { displayName: trimmed };
  }

  if (typeof input !== 'object') return {};
  const obj = input as Record<string, unknown>;
  const out: Extracted = {};

  for (const f of HASH_FIELDS) {
    const v = str(obj[f]);
    if (v) {
      out.hash = v;
      break;
    }
  }

  const driverIdStr = str(obj.driverId);
  if (driverIdStr) {
    out.driverId = driverIdStr;
    if (!out.hash) out.hash = driverIdStr;
  }

  const uidStr = str(obj.uid);
  if (uidStr) out.uid = uidStr;

  out.displayName =
    str(obj.displayName) ||
    str(obj.driverName) ||
    str(obj.driver) ||
    str(obj.driverFirstName) ||
    str(obj.name);
  out.legalName = str(obj.legalName);
  out.companyId = str(obj.companyId);
  out.companyName = str(obj.companyName);

  if (obj.profile && typeof obj.profile === 'object') {
    const prof = obj.profile as Record<string, unknown>;
    out.displayName = out.displayName ?? str(prof.displayName);
    out.legalName = out.legalName ?? str(prof.legalName);
    out.companyId = out.companyId ?? str(prof.companyId);
    out.companyName = out.companyName ?? str(prof.companyName);
  }

  if (!out.displayName && !out.legalName) {
    for (const [k, v] of Object.entries(obj)) {
      if (HASH_FIELDS.includes(k as (typeof HASH_FIELDS)[number])) continue;
      if (k === 'profile') continue;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const nested = v as Record<string, unknown>;
        const nestedName = str(nested.displayName) || str(nested.name);
        if (nestedName) {
          out.displayName = nestedName;
          out.legalName = out.legalName ?? str(nested.legalName);
          out.companyId = out.companyId ?? str(nested.companyId);
          out.companyName = out.companyName ?? str(nested.companyName);
          break;
        }
      }
    }
  }

  return out;
}

function operatorKey(e: Extracted): string | null {
  if (e.hash) return `op:${e.hash}`;
  if (e.uid) return `op-uid:${e.uid}`;
  if (e.displayName) return `op-name:${normalizeName(e.displayName)}`;
  return null;
}

function scoreConfidence(e: Extracted): 'strong' | 'medium' | 'weak' {
  const hasHash = !!e.hash;
  const hasName = !!e.displayName;
  const hasCompany = !!e.companyId;
  if (hasHash && (hasName || hasCompany)) return 'strong';
  if (hasHash) return 'medium';
  if (hasName && hasCompany) return 'medium';
  return 'weak';
}

export interface OperatorResolveContext {
  sourceRef?: SourceRef;
  sourceSystem?: SourceSystem;
}

export function resolveOperatorRef(
  input: unknown,
  context: OperatorResolveContext = {}
): OperatorRef | null {
  const e = extract(input);
  const key = operatorKey(e);
  if (!key) return null;

  const ref: OperatorRef = {
    operatorKey: key,
    sourceRefs: context.sourceRef ? [context.sourceRef] : [],
    confidence: scoreConfidence(e),
  };
  if (e.hash !== undefined) ref.hash = e.hash;
  if (e.driverId !== undefined) ref.driverId = e.driverId;
  if (e.uid !== undefined) ref.uid = e.uid;
  if (e.displayName !== undefined) ref.displayName = e.displayName;
  if (e.legalName !== undefined) ref.legalName = e.legalName;
  if (e.companyId !== undefined) ref.companyId = e.companyId;
  if (e.companyName !== undefined) ref.companyName = e.companyName;
  return ref;
}

export function mergeOperatorRefs(refs: OperatorRef[]): OperatorRef[] {
  const byKey = new Map<string, OperatorRef>();
  for (const r of refs) {
    const existing = byKey.get(r.operatorKey);
    if (!existing) {
      byKey.set(r.operatorKey, { ...r, sourceRefs: [...r.sourceRefs] });
      continue;
    }
    const merged: OperatorRef = {
      operatorKey: existing.operatorKey,
      hash: existing.hash ?? r.hash,
      driverId: existing.driverId ?? r.driverId,
      uid: existing.uid ?? r.uid,
      displayName: existing.displayName ?? r.displayName,
      legalName: existing.legalName ?? r.legalName,
      companyId: existing.companyId ?? r.companyId,
      companyName: existing.companyName ?? r.companyName,
      sourceRefs: [...existing.sourceRefs, ...r.sourceRefs],
    };
    const mergedExtract: Extracted = {
      hash: merged.hash,
      driverId: merged.driverId,
      uid: merged.uid,
      displayName: merged.displayName,
      legalName: merged.legalName,
      companyId: merged.companyId,
      companyName: merged.companyName,
    };
    merged.confidence = scoreConfidence(mergedExtract);
    byKey.set(r.operatorKey, merged);
  }
  return Array.from(byKey.values()).sort((a, b) =>
    a.operatorKey.localeCompare(b.operatorKey)
  );
}
