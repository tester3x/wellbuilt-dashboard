/**
 * Governed Dashboard Add Well create. Client RTDB well_config writes are
 * denied; this is the only create path.
 */
import { callerCanViewGlobalWellPool } from '../dashboardCatalogProjection.js';

export const WELL_CONFIG_CREATE_ALLOWLIST = [
  'route',
  'bottomLevel',
  'tanks',
  'numTanks',
  'pullBbls',
  'tankCapacity',
  'tankHeight',
  'bblPerFoot',
  'allowedBottom',
  'ndicName',
  'ndicApiNo',
  'waterWeight',
  'h2sStatus',
] as const;

/** Ordinary Edit Well save — never NDIC, rename, recordings, or AFR. */
export const WELL_CONFIG_UPDATE_ALLOWLIST = [
  'route',
  'bottomLevel',
  'tanks',
  'numTanks',
  'pullBbls',
  'tankCapacity',
  'tankHeight',
  'bblPerFoot',
  'allowedBottom',
  'waterWeight',
  'h2sStatus',
] as const;

const H2S = new Set(['none', 'low', 'high', 'unknown']);
const API_RE = /^\d{2}-\d{3}-\d{5}-\d{2}-\d{2}$/;
const FORBIDDEN_NAME = /[.$#[\]\/]/;

export type StaffWriteWellOp = 'create' | 'update';

export type WellConfigCreateRecord = {
  route: string;
  bottomLevel: number;
  tanks: number;
  allowedBottom: number;
  numTanks: number;
  pullBbls: number;
  tankCapacity: number;
  tankHeight: number;
  bblPerFoot: number;
  ndicName: string;
  ndicApiNo: string;
  h2sStatus: string;
  waterWeight?: number;
};

export type WellConfigUpdatePatch = {
  route: string;
  bottomLevel: number;
  tanks: number;
  allowedBottom: number;
  numTanks: number;
  pullBbls: number;
  tankCapacity: number;
  tankHeight: number;
  bblPerFoot: number;
  h2sStatus: string;
  waterWeight?: number;
};

export type StaffWriteWellDecision =
  | { ok: true; action: 'create'; wellName: string; payload: WellConfigCreateRecord }
  | { ok: true; action: 'already_exact'; wellName: string; payload: WellConfigCreateRecord | Record<string, unknown> }
  | { ok: true; action: 'update'; wellName: string; patch: WellConfigUpdatePatch; payload: Record<string, unknown> }
  | { ok: false; reason: string; message: string };

function positiveNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

function pickCreateRecord(raw: Record<string, unknown>):
  | { ok: true; record: WellConfigCreateRecord }
  | { ok: false; reason: string; message: string } {
  for (const key of Object.keys(raw)) {
    if (!(WELL_CONFIG_CREATE_ALLOWLIST as readonly string[]).includes(key)) {
      return { ok: false, reason: 'unexpected_field', message: `Unexpected field: ${key}` };
    }
  }
  const ndicApiNo = typeof raw.ndicApiNo === 'string' ? raw.ndicApiNo.trim() : '';
  const ndicName = typeof raw.ndicName === 'string' ? raw.ndicName.trim() : '';
  if (!ndicApiNo || !API_RE.test(ndicApiNo)) {
    return { ok: false, reason: 'invalid_api', message: 'A valid linked NDIC API is required.' };
  }
  if (!ndicName) {
    return { ok: false, reason: 'ndic_required', message: 'A linked NDIC well name is required.' };
  }
  const bottomLevel = positiveNumber(raw.bottomLevel);
  const tanks = positiveNumber(raw.tanks);
  const numTanks = positiveNumber(raw.numTanks);
  const pullBbls = positiveNumber(raw.pullBbls);
  const tankCapacity = positiveNumber(raw.tankCapacity);
  const tankHeight = positiveNumber(raw.tankHeight);
  const bblPerFoot = positiveNumber(raw.bblPerFoot);
  const allowedBottom = positiveNumber(raw.allowedBottom);
  if (!bottomLevel) return { ok: false, reason: 'invalid_bottom', message: 'Bottom must be a positive level.' };
  if (!tanks || !numTanks) return { ok: false, reason: 'invalid_tanks', message: 'Tank count must be a positive number.' };
  if (!pullBbls) return { ok: false, reason: 'invalid_pull_bbls', message: 'Pull BBLs must be a positive number.' };
  if (!tankCapacity) return { ok: false, reason: 'invalid_tank_capacity', message: 'Tank capacity must be a positive number.' };
  if (!tankHeight) return { ok: false, reason: 'invalid_tank_height', message: 'Tank height must be a positive number.' };
  if (!bblPerFoot) return { ok: false, reason: 'invalid_bbl_per_foot', message: 'BBL/ft must be a positive number.' };
  if (!allowedBottom) return { ok: false, reason: 'invalid_bottom', message: 'Bottom must be a positive level.' };
  const h2sStatus = typeof raw.h2sStatus === 'string' ? raw.h2sStatus : '';
  if (!H2S.has(h2sStatus)) {
    return { ok: false, reason: 'invalid_h2s', message: 'H2S status is invalid.' };
  }
  const route = typeof raw.route === 'string' && raw.route.trim() ? raw.route.trim() : 'Unrouted';
  const record: WellConfigCreateRecord = {
    route,
    bottomLevel,
    tanks,
    allowedBottom,
    numTanks,
    pullBbls,
    tankCapacity,
    tankHeight,
    bblPerFoot,
    ndicName,
    ndicApiNo,
    h2sStatus,
  };
  if (raw.waterWeight !== undefined) {
    const ww = positiveNumber(raw.waterWeight);
    if (!ww) return { ok: false, reason: 'invalid_water_weight', message: 'Water weight must be a positive number.' };
    record.waterWeight = ww;
  }
  return { ok: true, record };
}

function pickUpdatePatch(raw: Record<string, unknown>):
  | { ok: true; patch: WellConfigUpdatePatch }
  | { ok: false; reason: string; message: string } {
  for (const key of Object.keys(raw)) {
    if (!(WELL_CONFIG_UPDATE_ALLOWLIST as readonly string[]).includes(key)) {
      return { ok: false, reason: 'unexpected_field', message: `Unexpected field: ${key}` };
    }
  }
  const bottomLevel = positiveNumber(raw.bottomLevel);
  const tanks = positiveNumber(raw.tanks);
  const numTanks = positiveNumber(raw.numTanks);
  const pullBbls = positiveNumber(raw.pullBbls);
  const tankCapacity = positiveNumber(raw.tankCapacity);
  const tankHeight = positiveNumber(raw.tankHeight);
  const bblPerFoot = positiveNumber(raw.bblPerFoot);
  const allowedBottom = positiveNumber(raw.allowedBottom);
  if (!bottomLevel) return { ok: false, reason: 'invalid_bottom', message: 'Bottom must be a positive level.' };
  if (!tanks || !numTanks) return { ok: false, reason: 'invalid_tanks', message: 'Tank count must be a positive number.' };
  if (!pullBbls) return { ok: false, reason: 'invalid_pull_bbls', message: 'Pull BBLs must be a positive number.' };
  if (!tankCapacity) return { ok: false, reason: 'invalid_tank_capacity', message: 'Tank capacity must be a positive number.' };
  if (!tankHeight) return { ok: false, reason: 'invalid_tank_height', message: 'Tank height must be a positive number.' };
  if (!bblPerFoot) return { ok: false, reason: 'invalid_bbl_per_foot', message: 'BBL/ft must be a positive number.' };
  if (!allowedBottom) return { ok: false, reason: 'invalid_bottom', message: 'Bottom must be a positive level.' };
  const h2sStatus = typeof raw.h2sStatus === 'string' ? raw.h2sStatus : '';
  if (!H2S.has(h2sStatus)) {
    return { ok: false, reason: 'invalid_h2s', message: 'H2S status is invalid.' };
  }
  const route = typeof raw.route === 'string' && raw.route.trim() ? raw.route.trim() : 'Unrouted';
  const patch: WellConfigUpdatePatch = {
    route,
    bottomLevel,
    tanks,
    allowedBottom,
    numTanks,
    pullBbls,
    tankCapacity,
    tankHeight,
    bblPerFoot,
    h2sStatus,
  };
  if (raw.waterWeight !== undefined) {
    const ww = positiveNumber(raw.waterWeight);
    if (!ww) return { ok: false, reason: 'invalid_water_weight', message: 'Water weight must be a positive number.' };
    patch.waterWeight = ww;
  }
  return { ok: true, patch };
}

function existingScalar(existing: Record<string, unknown>, key: keyof WellConfigUpdatePatch): unknown {
  if (key === 'route') {
    const r = existing.route;
    return typeof r === 'string' && r.trim() ? r.trim() : 'Unrouted';
  }
  return existing[key];
}

function patchMatchesExisting(existing: Record<string, unknown>, patch: WellConfigUpdatePatch): boolean {
  const keys = Object.keys(patch) as (keyof WellConfigUpdatePatch)[];
  return keys.every((key) => existingScalar(existing, key) === patch[key]);
}

export function validateWellConfigName(name: string): string | null {
  const t = name.trim();
  if (!t) return 'Name cannot be empty';
  if (FORBIDDEN_NAME.test(t)) return 'Well name contains forbidden characters';
  if (t.length > 80) return 'Well name is too long';
  return null;
}

export function evaluateStaffWriteWellConfig(input: {
  op: StaffWriteWellOp;
  wellName: string;
  config: Record<string, unknown>;
  existingByName: Record<string, unknown> | null;
  existingNameKey: string | null;
  duplicateApiWell: string | null;
  callerCompanyId?: string;
  isPlatformAdmin: boolean;
}): StaffWriteWellDecision {
  if (!callerCanViewGlobalWellPool({
    companyId: input.callerCompanyId,
    isPlatformAdmin: input.isPlatformAdmin,
  })) {
    return {
      ok: false,
      reason: 'pool_forbidden',
      message: input.op === 'update'
        ? 'You are not authorized to update wells.'
        : 'You are not authorized to add wells.',
    };
  }
  if (input.op === 'update') {
    const nameError = validateWellConfigName(input.wellName);
    if (nameError) return { ok: false, reason: 'invalid_name', message: nameError };
    if (!input.existingByName || !input.existingNameKey) {
      return { ok: false, reason: 'not_found', message: 'Well does not exist.' };
    }
    const picked = pickUpdatePatch(input.config);
    if (!picked.ok) return picked;
    const wellName = input.existingNameKey;
    const payload = { ...input.existingByName, ...picked.patch };
    if (patchMatchesExisting(input.existingByName, picked.patch)) {
      return { ok: true, action: 'already_exact', wellName, payload };
    }
    return { ok: true, action: 'update', wellName, patch: picked.patch, payload };
  }
  if (input.op !== 'create') {
    return { ok: false, reason: 'invalid_op', message: 'Only create is supported.' };
  }
  const nameError = validateWellConfigName(input.wellName);
  if (nameError) return { ok: false, reason: 'invalid_name', message: nameError };
  const picked = pickCreateRecord(input.config);
  if (!picked.ok) return picked;

  const wellName = input.wellName.trim();
  if (input.existingNameKey && input.existingNameKey !== wellName) {
    return {
      ok: false,
      reason: 'name_taken',
      message: `Well already exists as "${input.existingNameKey}"`,
    };
  }

  if (input.existingByName) {
    const existingApi = typeof input.existingByName.ndicApiNo === 'string'
      ? input.existingByName.ndicApiNo
      : '';
    if (existingApi && existingApi === picked.record.ndicApiNo) {
      return { ok: true, action: 'already_exact', wellName, payload: picked.record };
    }
    return {
      ok: false,
      reason: 'name_taken',
      message: `Well already exists as "${wellName}"`,
    };
  }

  if (input.duplicateApiWell) {
    return {
      ok: false,
      reason: 'duplicate_api',
      message: `API ${picked.record.ndicApiNo} is already linked to "${input.duplicateApiWell}"`,
    };
  }

  return { ok: true, action: 'create', wellName, payload: picked.record };
}

export function findWellNameKey(all: Record<string, unknown>, wellName: string): string | null {
  const lower = wellName.trim().toLowerCase();
  return Object.keys(all).find((k) => k.toLowerCase() === lower) || null;
}

export function findDuplicateApiWell(
  all: Record<string, unknown>,
  apiNo: string,
  exceptName: string,
): string | null {
  const want = apiNo.trim();
  const except = exceptName.trim().toLowerCase();
  for (const [name, raw] of Object.entries(all)) {
    if (name.toLowerCase() === except) continue;
    const row = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
    if (row && typeof row.ndicApiNo === 'string' && row.ndicApiNo === want) return name;
  }
  return null;
}
