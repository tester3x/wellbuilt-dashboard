/**
 * Ordinary Edit Well save helpers. Production write is staffUpdateWellConfig.
 * This module never talks to RTDB.
 */

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

export type EditWellSaveStatus =
  | { kind: 'idle' }
  | { kind: 'submitting'; wellName: string }
  | { kind: 'success'; wellName: string; idempotent: boolean }
  | { kind: 'error'; message: string; reason: string };

export type EditWellFormInput = {
  wellName: string;
  route: string;
  bottomLevel: number;
  tanks: string;
  pullBbls: string;
  tankCapacity: string;
  tankHeight: string;
  waterWeight: string;
  h2sStatus: 'none' | 'low' | 'high' | 'unknown';
};

export function buildUpdateWellConfigPatch(form: EditWellFormInput): WellConfigUpdatePatch {
  const tankCapacity = parseInt(form.tankCapacity, 10) || 400;
  const tankHeight = parseInt(form.tankHeight, 10) || 20;
  const tanks = parseInt(form.tanks, 10) || 1;
  const bottomLevel = Number.isFinite(form.bottomLevel) && form.bottomLevel > 0 ? form.bottomLevel : 3;
  const patch: WellConfigUpdatePatch = {
    route: form.route.trim() ? form.route.trim() : 'Unrouted',
    bottomLevel,
    tanks,
    allowedBottom: bottomLevel,
    numTanks: tanks,
    pullBbls: parseInt(form.pullBbls, 10) || 140,
    tankCapacity,
    tankHeight,
    bblPerFoot: (tankCapacity / tankHeight) * tanks,
    h2sStatus: form.h2sStatus,
  };
  const ww = form.waterWeight.trim();
  if (ww) {
    const n = parseFloat(ww);
    if (Number.isFinite(n) && n > 0) patch.waterWeight = n;
  }
  return patch;
}

export function classifyUpdateWellError(err: unknown): { reason: string; message: string } {
  const e = err && typeof err === 'object' ? (err as { code?: string; message?: string }) : {};
  const raw = String(e.code || e.message || 'unknown');
  const msg = typeof e.message === 'string' && e.message.trim() ? e.message.trim() : '';
  if (/unauthenticated|auth/i.test(raw) && !/unauthor/i.test(raw)) {
    return { reason: 'unauthenticated', message: 'Sign in required to update a well.' };
  }
  if (/permission-denied|permission_denied|not authorized|pool_forbidden/i.test(raw)) {
    return { reason: 'permission-denied', message: 'You are not authorized to update wells.' };
  }
  if (/not_found:|reason":"not_found"|Well does not exist/i.test(raw + msg)) {
    return { reason: 'not-found', message: 'That well was not found.' };
  }
  if (/not-found|missing-callable|404/i.test(raw) && !/not_found/i.test(msg)) {
    return { reason: 'missing-callable', message: 'Save Changes is not available on the server yet.' };
  }
  if (/unexpected_field/i.test(raw + msg)) {
    return { reason: 'unexpected_field', message: msg || 'Unexpected field in update.' };
  }
  if (/invalid_/i.test(raw + msg)) {
    return { reason: 'invalid', message: msg.slice(0, 200) || 'The update payload is invalid.' };
  }
  if (/deadline|unavailable|network|Failed to fetch|internal/i.test(raw)) {
    return { reason: 'unavailable', message: 'Could not reach the server. Try again.' };
  }
  return { reason: 'failed', message: (msg || 'Could not update well.').slice(0, 200) };
}

export function createUpdateWellClickGuard() {
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

export function applyUpdateWellSuccess<T>(
  configs: Record<string, T>,
  wellName: string,
  config: T,
): Record<string, T> {
  return { ...configs, [wellName]: config };
}
