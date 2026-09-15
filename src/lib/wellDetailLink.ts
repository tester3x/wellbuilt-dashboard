import type { WellResponse } from './wellPoolCore';

/**
 * Canonical WB-M well-detail link.
 *
 * Every queue → well navigation must resolve the EXACT well by canonical company +
 * well identity (companyId + NDIC API number), never by wellName — two companies can
 * own wells with the same display name (see the well-pool cross-tenant work). When a
 * well lacks either canonical part, there is NO fuzzy/name fallback: the link is
 * unavailable (null) and the caller renders a non-navigable "unavailable" affordance.
 */
export function wellDetailHref(
  well: Pick<WellResponse, 'companyId' | 'ndicApiNo'> | null | undefined,
): string | null {
  const companyId = well?.companyId?.trim();
  const api = well?.ndicApiNo?.trim();
  if (!companyId || !api) return null;
  return `/well?company=${encodeURIComponent(companyId)}&api=${encodeURIComponent(api)}`;
}

/** Does this well carry a resolvable canonical identity? */
export function hasCanonicalWellIdentity(
  well: Pick<WellResponse, 'companyId' | 'ndicApiNo'> | null | undefined,
): boolean {
  return wellDetailHref(well) != null;
}
