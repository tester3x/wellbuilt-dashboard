import type * as admin from 'firebase-admin';
import { canonicalWellId } from './dashboardCatalogProjection';

export interface ResolvedWellConfig {
  key: string;
  config: Record<string, any>;
  companyId: string;
  wellId: string;
  wellName: string;
}

/**
 * Server-authoritative well configuration binding.
 *
 * Rules:
 * 1. If targetCompanyId is specified (from authenticated driver credentials on ingest/recovery):
 *    - All candidates belonging to another company are strictly disqualified.
 *    - Untrusted client packet fields pointing to other tenants are ignored/rejected.
 * 2. If targetCompanyId is absent (wellName-only ambiguous packet):
 *    - If multiple companies configure this wellName, it is strictly ambiguous and fails closed.
 *    - Insertion order cannot select the company.
 * 3. Requires authoritative companyId and canonical wellId on the resolved well_config.
 */
export async function resolveAuthoritativeWellConfig(input: {
  db: admin.database.Database;
  wellName: string;
  targetCompanyId?: string;
  candidateWellId?: string;
}): Promise<{ ok: true; resolved: ResolvedWellConfig } | { ok: false; reason: string }> {
  const wellName = (input.wellName || '').trim();
  const cleanName = wellName.replace(/\s/g, '');
  const targetCompany = (input.targetCompanyId || '').trim();
  const candId = (input.candidateWellId || '').trim();

  const allConfigSnap = await input.db.ref('well_config').once('value');
  const allConfigs: Record<string, any> = allConfigSnap.val() || {};

  interface MatchItem {
    key: string;
    config: any;
    companyId: string;
    wellId: string;
    wellName: string;
  }

  const allMatches: MatchItem[] = [];
  for (const [cfgKey, val] of Object.entries(allConfigs)) {
    if (!val || typeof val !== 'object' || Array.isArray(val)) continue;
    const cfg = val as Record<string, any>;
    const cfgWellName = typeof cfg.wellName === 'string' ? cfg.wellName.trim() : '';
    const cfgClean = cfgWellName.replace(/\s/g, '');
    const cfgCompany = typeof cfg.companyId === 'string' ? cfg.companyId.trim() : '';
    const wid = canonicalWellId(cfg) || cfgKey;

    const nameMatches =
      (wellName && (cfgWellName === wellName || cfgClean === cleanName)) ||
      cfgKey === wellName ||
      cfgKey === cleanName;

    const idMatches = candId ? (wid === candId || cfgKey === candId) : false;

    if (nameMatches || idMatches) {
      allMatches.push({
        key: cfgKey,
        config: cfg,
        companyId: cfgCompany,
        wellId: wid,
        wellName: cfgWellName || wellName,
      });
    }
  }

  let candidates: MatchItem[] = [];
  if (targetCompany) {
    candidates = allMatches.filter((m) => m.companyId === targetCompany);
    if (candId && candidates.length > 1) {
      const idMatch = candidates.filter((m) => m.wellId === candId || m.key === candId);
      if (idMatch.length > 0) candidates = idMatch;
    }
  } else {
    // Missing companyId on packet: if multiple companies configure this wellName, it is strictly ambiguous
    const distinctCompanies = new Set(allMatches.map((m) => m.companyId).filter(Boolean));
    if (distinctCompanies.size > 1 || allMatches.length !== 1) {
      return {
        ok: false,
        reason: `Ambiguous incoming packet lacks authoritative companyId (${distinctCompanies.size} companies match for "${wellName}")`,
      };
    }
    candidates = allMatches;
  }

  if (candidates.length === 0) {
    return { ok: false, reason: `No well configuration found for "${wellName}" (company="${targetCompany}")` };
  }
  if (candidates.length > 1) {
    return { ok: false, reason: `Multiple well configurations found for "${wellName}" in company "${targetCompany}"` };
  }

  const chosen = candidates[0];
  if (!chosen.companyId || !chosen.wellId) {
    return {
      ok: false,
      reason: `Bound configuration lacks authoritative companyId or canonical wellId (companyId="${chosen.companyId}", wellId="${chosen.wellId}")`,
    };
  }

  return { ok: true, resolved: chosen };
}
