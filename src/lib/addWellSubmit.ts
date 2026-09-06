/**
 * Dashboard Add Well submit: parse, validate, and apply a successful create.
 * The production write goes through staffCreateWellConfig — this module never
 * talks to RTDB.
 */

export const FORBIDDEN_WELL_NAME_CHARS = /[.$#[\]\/]/;

export type H2sStatus = 'none' | 'low' | 'high' | 'unknown';

export type LinkedNdicWell = {
  well_name: string;
  api_no: string;
  operator?: string;
};

export type AddWellFormInput = {
  wellName: string;
  route: string;
  bottomInput: string;
  tanks: string;
  pullBbls: string;
  tankCapacity: string;
  tankHeight: string;
  waterWeight: string;
  h2sStatus: H2sStatus;
  linkedWell: LinkedNdicWell | null;
};

export type WellConfigRecord = {
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
  h2sStatus: H2sStatus;
  waterWeight?: number;
};

export type AddWellUiDecision =
  | { action: 'submit'; wellName: string; config: WellConfigRecord }
  | { action: 'reject'; reason: string; message: string };

export type AddWellSubmitStatus =
  | { kind: 'idle' }
  | { kind: 'submitting'; wellName: string }
  | { kind: 'success'; wellName: string; idempotent: boolean; apiNo: string }
  | { kind: 'error'; message: string; reason: string };

/** "10'4\"" | "10 4" | "1.3" → decimal feet. "1.3" is 1.3 ft (~1'4"). */
export function parseLevelToFeet(input: string): number {
  const s = (input || '').trim();
  if (!s) return 0;
  const feetInchMatch = s.match(/^(\d+)\s*['']\s*(\d+)\s*[""]?\s*$/);
  if (feetInchMatch) return parseInt(feetInchMatch[1], 10) + parseInt(feetInchMatch[2], 10) / 12;
  const spaceMatch = s.match(/^(\d+)\s+(\d+)\s*$/);
  if (spaceMatch) return parseInt(spaceMatch[1], 10) + parseInt(spaceMatch[2], 10) / 12;
  const num = parseFloat(s);
  return Number.isFinite(num) ? num : 0;
}

export function feetToDisplay(ft: number): string {
  if (!Number.isFinite(ft) || ft < 0) return '—';
  const wholeFeet = Math.floor(ft);
  const inches = Math.round((ft - wholeFeet) * 12);
  return `${wholeFeet}'${inches}"`;
}

export function validateWellName(name: string): string | null {
  const t = name.trim();
  if (!t) return 'Name cannot be empty';
  if (FORBIDDEN_WELL_NAME_CHARS.test(t)) return 'Well name contains forbidden characters';
  if (t.length > 80) return 'Well name is too long';
  return null;
}

export function buildAddWellConfig(
  input: AddWellFormInput,
): { ok: true; wellName: string; config: WellConfigRecord } | { ok: false; reason: string; message: string } {
  const wellName = input.wellName.trim();
  const nameError = validateWellName(wellName);
  if (nameError) return { ok: false, reason: 'invalid_name', message: nameError };
  if (!input.linkedWell?.api_no?.trim() || !input.linkedWell?.well_name?.trim()) {
    return { ok: false, reason: 'ndic_required', message: 'Link a well from the database before adding.' };
  }

  const tankCap = parseInt(input.tankCapacity, 10);
  const tankHt = parseInt(input.tankHeight, 10);
  const numTanks = parseInt(input.tanks, 10);
  const pullBbls = parseInt(input.pullBbls, 10);
  if (!Number.isFinite(tankCap) || tankCap <= 0) {
    return { ok: false, reason: 'invalid_tank_capacity', message: 'Tank capacity must be a positive number.' };
  }
  if (!Number.isFinite(tankHt) || tankHt <= 0) {
    return { ok: false, reason: 'invalid_tank_height', message: 'Tank height must be a positive number.' };
  }
  if (!Number.isFinite(numTanks) || numTanks <= 0) {
    return { ok: false, reason: 'invalid_tanks', message: 'Tank count must be a positive number.' };
  }
  if (!Number.isFinite(pullBbls) || pullBbls <= 0) {
    return { ok: false, reason: 'invalid_pull_bbls', message: 'Pull BBLs must be a positive number.' };
  }

  const parsedBottom = parseLevelToFeet(input.bottomInput);
  if (!input.bottomInput.trim() || !(parsedBottom > 0)) {
    return { ok: false, reason: 'invalid_bottom', message: 'Bottom must be a positive level.' };
  }

  const config: WellConfigRecord = {
    route: input.route.trim() || 'Unrouted',
    bottomLevel: parsedBottom,
    tanks: numTanks,
    allowedBottom: parsedBottom,
    numTanks,
    pullBbls,
    tankCapacity: tankCap,
    tankHeight: tankHt,
    bblPerFoot: (tankCap / tankHt) * numTanks,
    ndicName: input.linkedWell.well_name.trim(),
    ndicApiNo: input.linkedWell.api_no.trim(),
    h2sStatus: input.h2sStatus,
  };
  if (input.waterWeight.trim()) {
    const ww = parseFloat(input.waterWeight);
    if (!Number.isFinite(ww) || ww <= 0) {
      return { ok: false, reason: 'invalid_water_weight', message: 'Water weight must be a positive number.' };
    }
    config.waterWeight = ww;
  }
  return { ok: true, wellName, config };
}

export function findDuplicateName(configs: Record<string, unknown>, wellName: string): string | null {
  const lower = wellName.trim().toLowerCase();
  return Object.keys(configs).find((k) => k.toLowerCase() === lower) || null;
}

export function findDuplicateApi(
  configs: Record<string, { ndicApiNo?: string }>,
  apiNo: string,
  exceptName?: string,
): string | null {
  const want = apiNo.trim();
  if (!want) return null;
  const except = (exceptName || '').trim().toLowerCase();
  for (const [name, cfg] of Object.entries(configs)) {
    if (except && name.toLowerCase() === except) continue;
    if (cfg && typeof cfg === 'object' && String(cfg.ndicApiNo || '') === want) return name;
  }
  return null;
}

/** Empty route is valid and stores as Unrouted. */
export function defaultAddWellRoute(route: string): string {
  const t = (route || '').trim();
  return t || 'Unrouted';
}

/**
 * Catalog/UI APIs may be `25-083-22277 (MT)` or 5-part `25-083-22277`.
 * well_config requires `##-###-#####-##-##`.
 */
export function normalizeLinkedApiNo(apiNo: string): string {
  let t = (apiNo || '').trim();
  t = t.replace(/\s*\((ND|MT)\)\s*$/i, '').trim();
  if (/^\d{2}-\d{3}-\d{5}$/.test(t)) return `${t}-00-00`;
  return t;
}

export function projectLinkedWell(linked: LinkedNdicWell | null): LinkedNdicWell | null {
  if (!linked) return null;
  return {
    well_name: linked.well_name,
    api_no: normalizeLinkedApiNo(linked.api_no),
    operator: linked.operator,
  };
}

export type AddWellClickDecision =
  | { action: 'submit'; wellName: string; config: WellConfigRecord }
  | { action: 'reject'; reason: string; message: string; focus?: 'ndic' | 'form' }
  | { action: 'busy'; message: string };

/** UI click: never a silent no-op. Route defaults to Unrouted. */
export function decideAddWellClick(input: {
  form: AddWellFormInput;
  configs: Record<string, { ndicApiNo?: string }>;
  inflight: boolean;
}): AddWellClickDecision {
  if (input.inflight) {
    return {
      action: 'busy',
      message: 'Already submitting this well. Wait for the current attempt to finish.',
    };
  }
  const form: AddWellFormInput = {
    ...input.form,
    route: defaultAddWellRoute(input.form.route),
    linkedWell: projectLinkedWell(input.form.linkedWell),
  };
  if (!form.linkedWell) {
    return {
      action: 'reject',
      reason: 'ndic_required',
      message: 'Link a well from the database before adding.',
      focus: 'ndic',
    };
  }
  const decided = decideAddWellSubmit(form, input.configs);
  if (decided.action === 'reject') {
    return {
      ...decided,
      focus: decided.reason === 'ndic_required' ? 'ndic' : 'form',
    };
  }
  return decided;
}

export function decideAddWellSubmit(
  input: AddWellFormInput,
  configs: Record<string, { ndicApiNo?: string }>,
): AddWellUiDecision {
  const built = buildAddWellConfig({
    ...input,
    route: defaultAddWellRoute(input.route),
    linkedWell: projectLinkedWell(input.linkedWell),
  });
  if (!built.ok) return { action: 'reject', reason: built.reason, message: built.message };

  const dupName = findDuplicateName(configs, built.wellName);
  if (dupName) {
    const existing = configs[dupName];
    if (existing && existing.ndicApiNo === built.config.ndicApiNo) {
      return { action: 'submit', wellName: built.wellName, config: built.config };
    }
    return {
      action: 'reject',
      reason: 'duplicate_name',
      message: `Well already exists as "${dupName}"`,
    };
  }

  const dupApi = findDuplicateApi(configs, built.config.ndicApiNo, built.wellName);
  if (dupApi) {
    return {
      action: 'reject',
      reason: 'duplicate_api',
      message: `API ${built.config.ndicApiNo} is already linked to "${dupApi}"`,
    };
  }

  return { action: 'submit', wellName: built.wellName, config: built.config };
}

export function classifyAddWellError(err: unknown): { reason: string; message: string } {
  const e = err && typeof err === 'object' ? (err as { code?: string; message?: string }) : {};
  const raw = String(e.code || e.message || 'unknown');
  if (/unauthenticated|auth/i.test(raw) && !/unauthor/i.test(raw)) {
    return { reason: 'unauthenticated', message: 'Sign in required to add a well.' };
  }
  if (/permission-denied|permission_denied|lacks manageDrivers|not authorized|pool_forbidden/i.test(raw)) {
    return { reason: 'permission-denied', message: 'You are not authorized to add wells.' };
  }
  if (/already-exists|duplicate_name|name_taken/i.test(raw)) {
    return { reason: 'duplicate_name', message: e.message || 'A well with that name already exists.' };
  }
  if (/duplicate_api/i.test(raw)) {
    return { reason: 'duplicate_api', message: e.message || 'That NDIC API is already linked to another well.' };
  }
  if (/not-found|missing-callable|not_found|404/i.test(raw)) {
    return { reason: 'missing-callable', message: 'Add Well is not available on the server yet.' };
  }
  if (/deadline|unavailable|network|Failed to fetch|internal/i.test(raw)) {
    return { reason: 'unavailable', message: 'Could not reach the server. Try again.' };
  }
  const msg = typeof e.message === 'string' && e.message.trim() ? e.message.trim() : 'Could not add well.';
  return { reason: 'failed', message: msg.slice(0, 200) };
}

export function createAddWellClickGuard() {
  let inflight = false;
  return {
    get inflight() {
      return inflight;
    },
    tryBegin(): boolean {
      if (inflight) return false;
      inflight = true;
      return true;
    },
    end(): void {
      inflight = false;
    },
  };
}

export function applyAddWellSuccess<T>(
  configs: Record<string, T>,
  wellName: string,
  config: T,
): Record<string, T> {
  return { ...configs, [wellName]: config };
}

export function rebuildRoutesFromConfigs(
  configs: Record<string, { route?: string }>,
): { routes: string[]; routeWells: Record<string, string[]> } {
  const routeSet = new Set<string>(['Unrouted']);
  const wellsByRoute: Record<string, string[]> = { Unrouted: [] };
  Object.entries(configs).forEach(([wellName, config]) => {
    const route = config.route || 'Unrouted';
    routeSet.add(route);
    if (!wellsByRoute[route]) wellsByRoute[route] = [];
    wellsByRoute[route].push(wellName);
  });
  Object.keys(wellsByRoute).forEach((route) => wellsByRoute[route].sort());
  return { routes: Array.from(routeSet).sort(), routeWells: wellsByRoute };
}

export const TORNADO_1_ATTEMPT: AddWellFormInput = {
  wellName: 'Tornado 1',
  route: '',
  bottomInput: '3',
  tanks: '1',
  pullBbls: '140',
  tankCapacity: '400',
  tankHeight: '20',
  waterWeight: '',
  h2sStatus: 'unknown',
  linkedWell: {
    well_name: 'Tornado 1-24H',
    api_no: '25-083-22277 (MT)',
  },
};

export const KAHUNA_2_ATTEMPT: AddWellFormInput = {
  wellName: 'Kahuna 2',
  route: 'Kahuna 381',
  bottomInput: '1.3',
  tanks: '6',
  pullBbls: '140',
  tankCapacity: '500',
  tankHeight: '20',
  waterWeight: '9.7',
  h2sStatus: 'none',
  linkedWell: {
    well_name: 'Kahuna 2-6-7H',
    api_no: '33-053-10170-00-00',
    operator: 'SLAWSON EXPLORATION COMPANY, INC.',
  },
};
