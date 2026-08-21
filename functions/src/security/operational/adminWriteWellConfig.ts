import { callerCanViewGlobalWellPool, WELL_CONFIG_ALLOWLIST } from '../dashboardCatalogProjection';
import type { DashboardCaller } from '../adminAuth';

export type WellConfigOp = 'add' | 'update' | 'rename' | 'setRoute' | 'deleteConfig';

export type WellConfigWriteResult =
  | { ok: true; op: WellConfigOp; wellName: string; newName?: string; wellNames?: string[] }
  | { ok: false; reason: string };

const FORBIDDEN_PURGE = new Set(['purgeHistory', 'deletePackets', 'wipePerformance']);

export function evaluateAdminWriteWellConfig(input: {
  op: WellConfigOp;
  wellName: string;
  newName?: string;
  record?: Record<string, unknown>;
  existingNames: string[];
  caller: Pick<DashboardCaller, 'companyId' | 'isPlatformAdmin'>;
}): WellConfigWriteResult {
  if (!callerCanViewGlobalWellPool(input.caller)) {
    return { ok: false, reason: 'well_pool_forbidden' };
  }
  const wellName = (input.wellName || '').trim();
  if (!wellName) return { ok: false, reason: 'well_name_required' };
  if (wellName.includes('/') || wellName.includes('.')) return { ok: false, reason: 'invalid_well_name' };

  const record = input.record || {};
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_PURGE.has(key)) return { ok: false, reason: 'history_purge_forbidden' };
  }

  if (input.op === 'add') {
    if (input.existingNames.includes(wellName)) return { ok: false, reason: 'well_exists' };
    return { ok: true, op: 'add', wellName };
  }
  if (!input.existingNames.includes(wellName)) return { ok: false, reason: 'unknown_well' };

  if (input.op === 'rename') {
    const newName = (input.newName || '').trim();
    if (!newName) return { ok: false, reason: 'new_name_required' };
    if (newName.includes('/') || newName.includes('.')) return { ok: false, reason: 'invalid_well_name' };
    if (newName !== wellName && input.existingNames.includes(newName)) {
      return { ok: false, reason: 'well_exists' };
    }
    return { ok: true, op: 'rename', wellName, newName };
  }
  if (input.op === 'setRoute') {
    const route = typeof record.route === 'string' ? record.route.trim() : '';
    if (!route) return { ok: false, reason: 'route_required' };
    const extra = Array.isArray(record.wellNames)
      ? (record.wellNames as unknown[]).filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
      : [];
    const wellNames = [...new Set([wellName, ...extra.map((n) => n.trim())])];
    if (wellNames.some((n) => !input.existingNames.includes(n))) {
      return { ok: false, reason: 'unknown_well' };
    }
    return { ok: true, op: 'setRoute', wellName, wellNames };
  }
  if (input.op === 'deleteConfig') {
    return { ok: true, op: 'deleteConfig', wellName };
  }
  return { ok: true, op: 'update', wellName };
}

export function pickWellConfigFields(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of WELL_CONFIG_ALLOWLIST) {
    if (key in record && record[key] !== undefined) out[key] = record[key];
  }
  return out;
}
