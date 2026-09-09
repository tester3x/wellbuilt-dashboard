/**
 * Single-well WB-T configuration lookup. Never returns a well catalog.
 * Company-matched, fail-closed on missing / ambiguous / stale / wrong-company.
 * API number is preferred; canonical name is the fallback.
 */
import { WELL_CONFIG_ALLOWLIST, pickAllowlisted } from '../dashboardCatalogProjection';
import { wellBelongsToDriverCompany } from './wbmWellScope';

export const WBT_WELL_CONFIG_ALLOWLIST = WELL_CONFIG_ALLOWLIST;

export type WbtWellLookupOk = {
  ok: true;
  wellConfigKey: string;
  wellName: string;
  wellId: string | null;
  companyId: string;
  config: Record<string, unknown>;
};

export type WbtWellLookupDecision =
  | WbtWellLookupOk
  | { ok: false; reason: string };

function asWell(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function ndicApi(well: Record<string, unknown>): string {
  return typeof well.ndicApiNo === 'string' ? well.ndicApiNo.trim() : '';
}

function ndicName(well: Record<string, unknown>): string {
  return typeof well.ndicName === 'string' ? well.ndicName.trim() : '';
}

export function evaluateWbtWellLookup(input: {
  wellConfigKey?: unknown;
  wellName?: unknown;
  wellId?: unknown;
  companyId: string;
  wellConfig: Record<string, unknown>;
}): WbtWellLookupDecision {
  if (!input.companyId) return { ok: false, reason: 'company_required' };
  const keySel = typeof input.wellConfigKey === 'string' ? input.wellConfigKey.trim() : '';
  const nameSel = typeof input.wellName === 'string' ? input.wellName.trim() : '';
  const idSel = typeof input.wellId === 'string' ? input.wellId.trim() : '';
  if (!keySel && !nameSel && !idSel) return { ok: false, reason: 'missing_well_identity' };

  if (keySel) {
    if (!keySel || keySel.length > 120 || /[.#$\[\]/]/.test(keySel)) {
      return { ok: false, reason: 'invalid_wellConfigKey' };
    }
    const raw = input.wellConfig[keySel];
    if (raw === undefined) return { ok: false, reason: 'well_not_found' };
    const well = asWell(raw);
    if (!wellBelongsToDriverCompany(well, input.companyId)) {
      return { ok: false, reason: 'cross_company_well' };
    }
    if (idSel && ndicApi(well) && ndicApi(well) !== idSel) {
      return { ok: false, reason: 'stale_well_binding' };
    }
    if (nameSel) {
      const n = norm(nameSel);
      const keyNorm = norm(keySel);
      const ndic = norm(ndicName(well));
      if (n !== keyNorm && n !== ndic && n.replace(/ /g, '_') !== keyNorm.replace(/ /g, '_')) {
        return { ok: false, reason: 'stale_well_binding' };
      }
    }
    return finish(keySel, well, input.companyId);
  }

  const matches: string[] = [];
  for (const [wellKey, raw] of Object.entries(input.wellConfig || {})) {
    const well = asWell(raw);
    if (!wellBelongsToDriverCompany(well, input.companyId)) continue;
    // API number first.
    if (idSel && ndicApi(well) === idSel) {
      matches.push(wellKey);
      continue;
    }
    if (idSel) continue;
    // Canonical name fallback.
    if (!nameSel) continue;
    const n = norm(nameSel);
    if (norm(wellKey) === n) {
      matches.push(wellKey);
      continue;
    }
    if (norm(wellKey.replace(/\s+/g, '_')) === n.replace(/\s+/g, '_')) {
      matches.push(wellKey);
      continue;
    }
    if (ndicName(well) && norm(ndicName(well)) === n) {
      matches.push(wellKey);
    }
  }

  const unique = Array.from(new Set(matches));
  if (unique.length === 0) return { ok: false, reason: 'well_not_found' };
  if (unique.length > 1) return { ok: false, reason: 'ambiguous_well' };
  const wellKey = unique[0];
  return finish(wellKey, asWell(input.wellConfig[wellKey]), input.companyId);
}

function finish(
  wellConfigKey: string,
  well: Record<string, unknown>,
  companyId: string,
): WbtWellLookupOk {
  const config = pickAllowlisted(well, WBT_WELL_CONFIG_ALLOWLIST);
  delete config.companyId;
  const wellId = ndicApi(well) || null;
  const wellName = ndicName(well) || wellConfigKey;
  return {
    ok: true,
    wellConfigKey,
    wellName,
    wellId,
    companyId,
    config,
  };
}
