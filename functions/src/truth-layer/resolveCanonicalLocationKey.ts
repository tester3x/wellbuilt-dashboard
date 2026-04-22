import type { LocationRef, SourceRef } from './types';
import type { LocationCanonicalView } from './types.canonical';

type Conf = 'strong' | 'medium' | 'weak';
const CONF_RANK = { weak: 0, medium: 1, strong: 2 } as const;

function bumpConfidence(a: Conf, b: Conf): Conf {
  const max = Math.max(CONF_RANK[a], CONF_RANK[b]);
  if (max === 2) return 'strong';
  if (max === 1) return 'medium';
  return 'weak';
}

export function resolveCanonicalLocationKey(
  refs: LocationRef[]
): LocationCanonicalView[] {
  const groups = new Map<string, LocationRef[]>();
  for (const r of refs) {
    const arr = groups.get(r.locationKey) ?? [];
    arr.push(r);
    groups.set(r.locationKey, arr);
  }

  const views: LocationCanonicalView[] = [];
  for (const [canonicalLocationKey, members] of groups.entries()) {
    let confidence: Conf = 'weak';
    const aliases = new Set<string>();
    const sourceRefs: SourceRef[] = [];
    let preferredName: string | undefined;
    let officialName: string | undefined;
    let ndicName: string | undefined;
    let apiNo: string | undefined;
    let operator: string | undefined;
    let county: string | undefined;
    let lat: number | undefined;
    let lng: number | undefined;
    let kind: LocationRef['kind'] | undefined;
    let strongestRank = -1;

    for (const r of members) {
      for (const a of r.aliases) aliases.add(a);
      aliases.add(r.preferredName);
      for (const s of r.sourceRefs) sourceRefs.push(s);
      const rConf: Conf = r.confidence ?? 'weak';
      confidence = bumpConfidence(confidence, rConf);
      const rRank = CONF_RANK[rConf];
      if (rRank > strongestRank) {
        strongestRank = rRank;
        preferredName = r.preferredName;
      }
      officialName = officialName ?? r.officialName;
      ndicName = ndicName ?? r.ndicName;
      apiNo = apiNo ?? r.apiNo;
      operator = operator ?? r.operator;
      county = county ?? r.county;
      lat = lat ?? r.lat;
      lng = lng ?? r.lng;
      if (!kind || kind === 'unknown') {
        if (r.kind && r.kind !== 'unknown') kind = r.kind;
        else if (!kind) kind = r.kind;
      }
    }

    const linkedKeys = [canonicalLocationKey];
    const mergedFrom: string[] = [];

    const view: LocationCanonicalView = {
      canonicalLocationKey,
      preferredName: preferredName ?? canonicalLocationKey,
      aliases: Array.from(aliases).sort((a, b) => a.localeCompare(b)),
      linkedKeys,
      mergedFrom,
      confidence,
      sourceRefs,
    };
    if (kind !== undefined) view.kind = kind;
    if (operator !== undefined) view.operator = operator;
    if (county !== undefined) view.county = county;
    if (apiNo !== undefined) view.apiNo = apiNo;
    if (officialName !== undefined) view.officialName = officialName;
    if (ndicName !== undefined) view.ndicName = ndicName;
    if (lat !== undefined) view.lat = lat;
    if (lng !== undefined) view.lng = lng;
    views.push(view);
  }

  return views.sort((a, b) =>
    a.canonicalLocationKey.localeCompare(b.canonicalLocationKey)
  );
}
