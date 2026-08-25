import type { PaperCaller } from './types';

export const DASHBOARD_PAPER_ROLES = new Set(['it', 'admin', 'manager', 'dispatch', 'viewer', 'payroll']);

export type PaperAuthIntent = 'driver' | 'dashboard' | 'none';

export function paperAuthIntent(token: Record<string, unknown> | null | undefined): PaperAuthIntent {
  if (!token || typeof token !== 'object') return 'none';
  if (token.kind === 'driver') return 'driver';
  return 'dashboard';
}

function explicitRoles(source: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof source.role === 'string') out.push(source.role);
  if (Array.isArray(source.roles)) {
    for (const r of source.roles) if (typeof r === 'string') out.push(r);
  }
  return out;
}

function explicitCaps(source: Record<string, unknown>): string[] {
  const caps: string[] = [];
  if (Array.isArray(source.caps)) {
    for (const c of source.caps) if (typeof c === 'string') caps.push(c);
  }
  if (source.viewTickets === true || source.viewTickets === 'true') caps.push('viewTickets');
  if (source.viewDispatch === true || source.viewDispatch === 'true') caps.push('viewDispatch');
  if (source.manageDrivers === true || source.manageDrivers === 'true') caps.push('manageDrivers');
  return caps;
}

export type PaperCallerResult =
  | { ok: true; caller: PaperCaller }
  | { ok: false; reason: string; message: string };

/**
 * Fail-closed caller discriminator. Driver kind never falls through to Dashboard.
 * Dashboard requires an RTDB user or explicit dashboard claims — never a default viewer.
 */
export function resolvePaperCaller(input: {
  uid?: string;
  token?: Record<string, unknown> | null;
  rtdbUser?: Record<string, unknown> | null;
  driverProfile?: { active?: boolean; companyId?: string } | null;
  driverProfileExists?: boolean;
}): PaperCallerResult {
  if (!input.uid) return { ok: false, reason: 'unauthenticated', message: 'Must be signed in.' };
  const token = input.token || {};
  const intent = paperAuthIntent(token);

  if (intent === 'driver') {
    const driverId = typeof token.driverId === 'string' ? token.driverId : '';
    if (!driverId) {
      return { ok: false, reason: 'driver_unauthenticated', message: 'Driver token missing driverId.' };
    }
    if (input.driverProfileExists && input.driverProfile?.active === false) {
      return { ok: false, reason: 'driver_deactivated', message: 'Driver deactivated.' };
    }
    const roles = Array.isArray(token.roles)
      ? (token.roles as unknown[]).filter((r): r is string => typeof r === 'string')
      : [];
    const companyId = typeof token.companyId === 'string'
      ? token.companyId
      : input.driverProfile?.companyId;
    return {
      ok: true,
      caller: {
        kind: 'driver',
        uid: input.uid,
        driverId,
        companyId,
        isPlatformAdmin: false,
        roles,
        caps: [],
      },
    };
  }

  if (input.rtdbUser) {
    const roles = explicitRoles(input.rtdbUser);
    if (roles.includes('driver') && roles.every((r) => r === 'driver')) {
      return { ok: false, reason: 'not_dashboard_user', message: 'Driver records are not Dashboard paper callers.' };
    }
    const companyId = typeof input.rtdbUser.companyId === 'string' ? input.rtdbUser.companyId : undefined;
    const caps = explicitCaps(input.rtdbUser);
    const isPlatformAdmin = !companyId && roles.some((r) => r === 'admin' || r === 'it');
    return {
      ok: true,
      caller: {
        kind: 'dashboard',
        uid: input.uid,
        companyId,
        isPlatformAdmin,
        roles,
        caps,
      },
    };
  }

  const claimRoles = explicitRoles(token).filter((r) => DASHBOARD_PAPER_ROLES.has(r));
  const dashboardMarked = token.kind === 'dashboard' || token.dashboard === true;
  const claimCaps = explicitCaps(token);
  const hasPaperCap = claimCaps.includes('viewTickets') || claimCaps.includes('viewDispatch') || claimCaps.includes('manageDrivers');
  if (dashboardMarked && (claimRoles.length > 0 || hasPaperCap)) {
    const companyId = typeof token.companyId === 'string' ? token.companyId : undefined;
    return {
      ok: true,
      caller: {
        kind: 'dashboard',
        uid: input.uid,
        companyId,
        isPlatformAdmin: !companyId && claimRoles.some((r) => r === 'admin' || r === 'it'),
        roles: claimRoles,
        caps: claimCaps,
      },
    };
  }

  return { ok: false, reason: 'not_dashboard_user', message: 'Caller is not a registered Dashboard user.' };
}

export const SYSTEM_PAPER_CALLER: PaperCaller = {
  kind: 'system',
  uid: 'system:paper-lifecycle',
  isPlatformAdmin: true,
  roles: ['it'],
  caps: ['manageDrivers', 'viewTickets', 'viewDispatch'],
};
