import type { LocationRef, SourceRef } from './types';

export function normalizeLocationName(name: string): string {
  return name.toLowerCase().trim().replace(/_/g, ' ').replace(/\s+/g, ' ');
}

export interface NdicEntry {
  name: string;
  operator?: string;
  county?: string;
  apiNo?: string;
  lat?: number;
  lng?: number;
}

export interface SwdEntry {
  name: string;
  apiNo?: string;
  lat?: number;
  lng?: number;
  isBlacklisted?: boolean;
}

export interface WellConfigEntry {
  name: string;
}

export interface LocationCatalog {
  ndic?: NdicEntry[];
  swd?: SwdEntry[];
  wellConfig?: WellConfigEntry[];
}

export interface LocationResolveInput {
  name?: string;
  rawAliases?: string[];
  apiNo?: string;
  operator?: string;
  county?: string;
  lat?: number;
  lng?: number;
  kind?: LocationRef['kind'];
  pickupDropoffHint?: 'pickup' | 'dropoff';
  sourceRef?: SourceRef;
  catalog?: LocationCatalog;
}

function findInCatalog<T extends { name: string }>(
  catalog: T[] | undefined,
  normalized: string
): T | undefined {
  if (!catalog) return undefined;
  for (const entry of catalog) {
    if (normalizeLocationName(entry.name) === normalized) return entry;
  }
  return undefined;
}

export function resolveLocationRef(
  input: LocationResolveInput
): LocationRef | null {
  const rawName = input.name?.trim();
  if (!rawName) return null;

  const normalized = normalizeLocationName(rawName);
  if (!normalized) return null;

  const aliasSet = new Set<string>([rawName]);
  for (const alias of input.rawAliases ?? []) {
    const t = alias?.trim();
    if (t) aliasSet.add(t);
  }

  const ndicMatch = findInCatalog(input.catalog?.ndic, normalized);
  const swdMatch = !ndicMatch
    ? findInCatalog(input.catalog?.swd, normalized)
    : undefined;
  const wellConfigMatch = !ndicMatch && !swdMatch
    ? findInCatalog(input.catalog?.wellConfig, normalized)
    : undefined;

  let kind: LocationRef['kind'] = input.kind;
  let confidence: LocationRef['confidence'] = 'weak';
  let preferredName = rawName;
  let officialName: string | undefined;
  let ndicName: string | undefined;
  let apiNo = input.apiNo;
  let operator = input.operator;
  let county = input.county;
  let lat = input.lat;
  let lng = input.lng;

  if (ndicMatch) {
    kind = kind ?? 'well';
    confidence = 'strong';
    preferredName = ndicMatch.name;
    officialName = ndicMatch.name;
    ndicName = ndicMatch.name;
    apiNo = apiNo ?? ndicMatch.apiNo;
    operator = operator ?? ndicMatch.operator;
    county = county ?? ndicMatch.county;
    lat = lat ?? ndicMatch.lat;
    lng = lng ?? ndicMatch.lng;
  } else if (swdMatch) {
    kind = kind ?? 'disposal';
    confidence = 'strong';
    preferredName = swdMatch.name;
    officialName = swdMatch.name;
    apiNo = apiNo ?? swdMatch.apiNo;
    lat = lat ?? swdMatch.lat;
    lng = lng ?? swdMatch.lng;
  } else if (wellConfigMatch) {
    kind = kind ?? 'well';
    confidence = 'medium';
    preferredName = wellConfigMatch.name;
    officialName = wellConfigMatch.name;
  } else {
    if (!kind) {
      if (input.pickupDropoffHint === 'dropoff') kind = 'disposal';
      else kind = 'unknown';
    }
  }

  if (preferredName) aliasSet.add(preferredName);

  const ref: LocationRef = {
    locationKey: `loc:${normalized}`,
    preferredName,
    aliases: Array.from(aliasSet).sort((a, b) => a.localeCompare(b)),
    sourceRefs: input.sourceRef ? [input.sourceRef] : [],
    confidence,
  };
  if (officialName !== undefined) ref.officialName = officialName;
  if (ndicName !== undefined) ref.ndicName = ndicName;
  if (apiNo !== undefined) ref.apiNo = apiNo;
  if (kind !== undefined) ref.kind = kind;
  if (operator !== undefined) ref.operator = operator;
  if (county !== undefined) ref.county = county;
  if (lat !== undefined) ref.lat = lat;
  if (lng !== undefined) ref.lng = lng;
  return ref;
}

function bumpConfidence(
  a: LocationRef['confidence'],
  b: LocationRef['confidence']
): LocationRef['confidence'] {
  const rank = { weak: 0, medium: 1, strong: 2 } as const;
  const av = a ? rank[a] : 0;
  const bv = b ? rank[b] : 0;
  const max = Math.max(av, bv);
  if (max === 2) return 'strong';
  if (max === 1) return 'medium';
  return 'weak';
}

export function mergeLocationRefs(refs: LocationRef[]): LocationRef[] {
  const byKey = new Map<string, LocationRef>();
  for (const r of refs) {
    const existing = byKey.get(r.locationKey);
    if (!existing) {
      byKey.set(r.locationKey, {
        ...r,
        aliases: [...r.aliases],
        sourceRefs: [...r.sourceRefs],
      });
      continue;
    }
    const aliases = new Set<string>([...existing.aliases, ...r.aliases]);
    const existingRank = existing.confidence === 'strong' ? 2 : existing.confidence === 'medium' ? 1 : 0;
    const incomingRank = r.confidence === 'strong' ? 2 : r.confidence === 'medium' ? 1 : 0;
    const preferredName = incomingRank > existingRank ? r.preferredName : existing.preferredName;
    const merged: LocationRef = {
      locationKey: existing.locationKey,
      preferredName,
      aliases: Array.from(aliases).sort((a, b) => a.localeCompare(b)),
      officialName: existing.officialName ?? r.officialName,
      ndicName: existing.ndicName ?? r.ndicName,
      apiNo: existing.apiNo ?? r.apiNo,
      kind:
        existing.kind && existing.kind !== 'unknown'
          ? existing.kind
          : r.kind && r.kind !== 'unknown'
          ? r.kind
          : existing.kind ?? r.kind,
      operator: existing.operator ?? r.operator,
      county: existing.county ?? r.county,
      lat: existing.lat ?? r.lat,
      lng: existing.lng ?? r.lng,
      sourceRefs: [...existing.sourceRefs, ...r.sourceRefs],
      confidence: bumpConfidence(existing.confidence, r.confidence),
    };
    byKey.set(r.locationKey, merged);
  }
  return Array.from(byKey.values()).sort((a, b) =>
    a.locationKey.localeCompare(b.locationKey)
  );
}
