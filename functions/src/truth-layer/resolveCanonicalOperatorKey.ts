import type { OperatorRef, SourceRef } from './types';
import type { OperatorCanonicalView } from './types.canonical';
import { normalizeName, normalizePersonName } from './normalizeOperator';

const CONF_RANK = { weak: 0, medium: 1, strong: 2 } as const;
type Conf = 'strong' | 'medium' | 'weak';

function bumpConfidence(a: Conf, b: Conf): Conf {
  const max = Math.max(CONF_RANK[a], CONF_RANK[b]);
  if (max === 2) return 'strong';
  if (max === 1) return 'medium';
  return 'weak';
}

class UF {
  private parent: number[];
  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }
  union(i: number, j: number): void {
    const ri = this.find(i);
    const rj = this.find(j);
    if (ri !== rj) this.parent[ri] = rj;
  }
}

export function resolveCanonicalOperatorKey(
  refs: OperatorRef[]
): OperatorCanonicalView[] {
  const n = refs.length;
  if (n === 0) return [];
  const uf = new UF(n);

  const byHash = new Map<string, number>();
  const byUid = new Map<string, number>();
  const byName = new Map<string, number>();

  for (let i = 0; i < n; i++) {
    const r = refs[i];
    if (r.hash) {
      const first = byHash.get(r.hash);
      if (first !== undefined) uf.union(i, first);
      else byHash.set(r.hash, i);
    }
    if (r.uid) {
      const first = byUid.get(r.uid);
      if (first !== undefined) uf.union(i, first);
      else byUid.set(r.uid, i);
    }
    const nameSource = r.displayName ?? r.legalName;
    if (nameSource) {
      const key = normalizeName(nameSource);
      if (key) {
        const first = byName.get(key);
        if (first !== undefined) uf.union(i, first);
        else byName.set(key, i);
      }
    }
  }

  // ── Legal-name bridge pass ──────────────────────────────────────────────
  // Goal: merge name-only refs (typically from invoices carrying only a
  // `driver` string, no `driverHash`) into their hash-backed canonical
  // identity when the name-only ref's normalized displayName or legalName
  // matches the hash-backed ref's normalized legalName exactly.
  //
  // Deterministic — no fuzzy match, no partial match, no "closest".
  // Additive — only introduces new unions; never splits existing groups.
  // One-directional — the bridge is driven by hash-backed legalName, so two
  // name-only refs cannot merge through this pass (they already merge via
  // the byName map above when they share a normalized display/legal name).
  const hashBackedLegalNameIndex = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const r = refs[i];
    if (!r.hash) continue;
    const legalNorm = normalizePersonName(r.legalName);
    if (!legalNorm) continue;
    if (!hashBackedLegalNameIndex.has(legalNorm)) {
      hashBackedLegalNameIndex.set(legalNorm, i);
    }
  }
  if (hashBackedLegalNameIndex.size > 0) {
    for (let i = 0; i < n; i++) {
      const r = refs[i];
      if (r.hash) continue; // only name-only refs cross the bridge
      const candidates = [
        normalizePersonName(r.displayName),
        normalizePersonName(r.legalName),
      ].filter((s) => s.length > 0);
      for (const c of candidates) {
        const target = hashBackedLegalNameIndex.get(c);
        if (target !== undefined) {
          uf.union(i, target);
          break; // one merge is enough; other candidates would land in same group
        }
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    const arr = groups.get(root) ?? [];
    arr.push(i);
    groups.set(root, arr);
  }

  const views: OperatorCanonicalView[] = [];
  for (const indices of groups.values()) {
    const members = indices.map((i) => refs[i]);

    let canonicalHash: string | undefined;
    let canonicalUid: string | undefined;
    let displayName: string | undefined;
    let legalName: string | undefined;
    let companyId: string | undefined;
    let companyName: string | undefined;
    let confidence: Conf = 'weak';
    const linkedKeys = new Set<string>();
    const sourceRefs: SourceRef[] = [];

    for (const r of members) {
      linkedKeys.add(r.operatorKey);
      canonicalHash = canonicalHash ?? r.hash;
      canonicalUid = canonicalUid ?? r.uid;
      displayName = displayName ?? r.displayName;
      legalName = legalName ?? r.legalName;
      companyId = companyId ?? r.companyId;
      companyName = companyName ?? r.companyName;
      sourceRefs.push(...r.sourceRefs);
      confidence = bumpConfidence(confidence, r.confidence ?? 'weak');
    }

    let canonicalOperatorKey: string;
    if (canonicalHash) {
      canonicalOperatorKey = `op:${canonicalHash}`;
    } else if (canonicalUid) {
      canonicalOperatorKey = `op-uid:${canonicalUid}`;
    } else {
      const nameSource = displayName ?? legalName;
      if (nameSource) {
        canonicalOperatorKey = `op-name:${normalizeName(nameSource)}`;
      } else {
        canonicalOperatorKey = `op-unresolved:${members[0].operatorKey}`;
      }
    }

    const linkedSorted = Array.from(linkedKeys).sort();
    const mergedFrom = linkedSorted.filter((k) => k !== canonicalOperatorKey);

    const view: OperatorCanonicalView = {
      canonicalOperatorKey,
      linkedKeys: linkedSorted,
      mergedFrom,
      confidence,
      sourceRefs,
    };
    if (canonicalHash !== undefined) view.hash = canonicalHash;
    if (canonicalUid !== undefined) view.uid = canonicalUid;
    if (displayName !== undefined) view.displayName = displayName;
    if (legalName !== undefined) view.legalName = legalName;
    if (companyId !== undefined) view.companyId = companyId;
    if (companyName !== undefined) view.companyName = companyName;
    views.push(view);
  }

  return views.sort((a, b) =>
    a.canonicalOperatorKey.localeCompare(b.canonicalOperatorKey)
  );
}
