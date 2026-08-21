/**
 * Canonical WB-M pull authorization. Catalog filtering is not enough —
 * ingest must refuse out-of-scope and cross-company wells.
 */
import {
  evaluateWbmWellScope,
  wellBelongsToDriverCompany,
  wellMatchesWbmScope,
} from './wbmWellScope';

const PULL_REQUIRED_STRINGS = ['wellName', 'dateTimeUTC'] as const;
const MAX_PACKET_BYTES = 200_000;

export type WbmPullDecision =
  | { ok: true; wellName: string; idempotencyKey: string }
  | { ok: false; reason: string };

export function evaluateWbmPull(input: {
  packet: unknown;
  companyId: string;
  assignedRoutes: unknown;
  assignedWells: unknown;
  wellConfig: Record<string, unknown>;
}): WbmPullDecision {
  if (!input.packet || typeof input.packet !== 'object' || Array.isArray(input.packet)) {
    return { ok: false, reason: 'packet_required' };
  }
  const packet = input.packet as Record<string, unknown>;
  const raw = JSON.stringify(packet);
  if (raw.length > MAX_PACKET_BYTES) return { ok: false, reason: 'packet_too_large' };

  const requestType = typeof packet.requestType === 'string' ? packet.requestType : '';
  if (requestType !== 'pull') return { ok: false, reason: 'unsupported_request_type' };

  for (const field of PULL_REQUIRED_STRINGS) {
    if (typeof packet[field] !== 'string' || !(packet[field] as string).trim()) {
      return { ok: false, reason: `missing_${field}` };
    }
  }
  if (typeof packet.tankLevelFeet !== 'number' || !Number.isFinite(packet.tankLevelFeet)) {
    return { ok: false, reason: 'missing_tankLevelFeet' };
  }
  if (typeof packet.bblsTaken !== 'number' || !Number.isFinite(packet.bblsTaken)) {
    return { ok: false, reason: 'missing_bblsTaken' };
  }
  const idempotencyKey = typeof packet.idempotencyKey === 'string' ? packet.idempotencyKey.trim() : '';
  if (idempotencyKey.length < 8) return { ok: false, reason: 'missing_idempotency_key' };

  const wellName = (packet.wellName as string).trim();
  const scope = evaluateWbmWellScope(input.assignedRoutes, input.assignedWells);
  if (!scope.ok) return { ok: false, reason: scope.reason };

  const wellRaw = input.wellConfig[wellName];
  if (wellRaw === undefined) return { ok: false, reason: 'well_not_found' };
  const well = wellRaw && typeof wellRaw === 'object' && !Array.isArray(wellRaw)
    ? wellRaw as Record<string, unknown>
    : {};
  if (!wellBelongsToDriverCompany(well, input.companyId)) {
    return { ok: false, reason: 'cross_company_well' };
  }
  if (!wellMatchesWbmScope(wellName, well, scope)) {
    return { ok: false, reason: 'well_out_of_scope' };
  }
  return { ok: true, wellName, idempotencyKey };
}

/** Driver-scoped so Driver B cannot collide with Driver A's idempotency key. */
export function wbmPullIdempotencyKey(driverId: string, idempotencyKey: string): string {
  const safe = idempotencyKey.replace(/[.#$\[\]/]/g, '_').slice(0, 80);
  return `wbm_${driverId.slice(0, 12)}_${safe}`;
}
